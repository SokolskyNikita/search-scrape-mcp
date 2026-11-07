import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppError, safeError } from "../server/error.js";
import { writeProviderAttempt } from "../server/stats.js";
import { validatePublicUrl } from "../server/target.js";
import { checkPage, type PageCheck } from "../tools/page-check.js";
import { cleanPage } from "../tools/page-content.js";
import { providerResponse } from "./http.js";
import { scrapeRungs, type ScrapeProvider, type ScrapeRung } from "./types.js";

const cost = z.number().finite().nonnegative();
const envelope = z.object({
  context: z
    .object({
      redirects: z
        .array(
          z.union([
            z.string(),
            z.object({ url: z.string(), location: z.string() }),
          ]),
        )
        .max(20)
        .optional(),
      cost: z.union([cost, z.object({ total: cost })]).optional(),
    })
    .nullish(),
  result: z
    .object({
      content: z.string().nullish(),
      status_code: z.number().int().min(100).max(599).nullish(),
      success: z.boolean().optional(),
      url: z.string().nullish(),
      error: z.object({ code: z.string() }).nullish(),
    })
    .nullish(),
  code: z.string().optional(),
});
const blocked = new Set(["blocked", "challenge"]);
const timeouts = { datacenter: 12_000, unblocker: 17_000, render: 24_000 };

function retryDelay(response: Response): number | undefined {
  const value =
    response.headers.get("Retry-After") ??
    response.headers.get("X-Scrapfly-Retry-After");
  if (value === null) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

function providerError(status: number, code: string) {
  if (status === 401 || status === 403)
    return new AppError("provider_auth", "Scrapfly rejected the API key.");
  if (
    status === 402 ||
    /COST_BUDGET|CREDIT|QUOTA|BALANCE_REQUIRED|USAGE_LIMIT|PAYMENT_REQUIRED/.test(
      code,
    )
  )
    return new AppError(
      "provider_credit",
      "Scrapfly rejected the request for cost or insufficient credit.",
    );
  if (status === 429)
    return new AppError("provider_rate", "Scrapfly is rate-limiting requests.");
}

async function requestPage(
  key: string,
  target: URL,
  rung: ScrapeRung,
  signal: AbortSignal,
) {
  const endpoint = new URL("https://api.scrapfly.io/scrape");
  endpoint.search = new URLSearchParams({
    key,
    url: target.href,
    proxy_pool: "public_datacenter_pool",
    cost_budget: "30",
    timeout: "30000",
    retry: "false",
    format: "markdown:no_images",
  }).toString();
  // This account's gateway rejects the newer named pools.
  if (rung !== "datacenter") endpoint.searchParams.set("unblocker", "true");
  if (rung === "render") {
    endpoint.searchParams.set("render_js", "true");
    endpoint.searchParams.set("rendering_wait", "1000");
  }
  const start = performance.now();
  let credits: number | null = null;
  let errorCode: string | null = null;
  let retryMs: number | undefined;
  let retryable = true;
  let headerFailure: AppError | undefined;
  try {
    const { response, body } = await providerResponse(
      "Scrapfly",
      endpoint,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeouts[rung])]),
      },
      (headers) => {
        headerFailure = providerError(
          headers.status,
          headers.headers.get("X-Scrapfly-Reject-Code") ?? "",
        );
        const rawCost = headers.headers.get("X-Scrapfly-Api-Cost");
        if (rawCost !== null && cost.safeParse(Number(rawCost)).success)
          credits = Number(rawCost);
        retryMs = retryDelay(headers);
        retryable =
          headers.headers.get("X-Scrapfly-Reject-Retryable")?.toLowerCase() !==
          "false";
      },
    );
    const parsed = envelope.safeParse(body);
    const data = parsed.success ? parsed.data : undefined;
    const charged = data?.context?.cost;
    credits =
      typeof charged === "number" ? charged : (charged?.total ?? credits);
    const result = data?.result;
    const code =
      response.headers.get("X-Scrapfly-Reject-Code") ??
      result?.error?.code ??
      data?.code ??
      "";
    const failure = providerError(response.status, code);
    if (failure) throw failure;

    if (
      code.startsWith("ERR::ASP::") ||
      code.includes("UNBLOCKER_ULTRA_REQUIRED")
    ) {
      errorCode = "challenge";
      return {
        markdown: "",
        check: {
          code: "challenge",
          reason: "Scrapfly reported anti-bot protection.",
          next: "stronger",
        } satisfies PageCheck,
      };
    }
    const upstream =
      code.includes("UPSTREAM_WEBSITE_ERROR") ||
      code.includes("BAD_UPSTREAM_RESPONSE");
    if (!response.ok && !upstream) {
      if (response.status >= 500 || response.status === 408)
        throw new AppError(
          "provider_down",
          "Scrapfly is temporarily unavailable.",
        );
      throw new AppError(
        "provider_http",
        `Scrapfly rejected the request (HTTP ${response.status}).`,
      );
    }
    if (!result?.url || !result.status_code)
      throw new AppError(
        "provider_response",
        "Scrapfly returned an invalid target response.",
      );
    const final =
      result.url === target.href ? target : await validatePublicUrl(result.url);
    const hops = new Set<string>();
    for (const redirect of data?.context?.redirects ?? []) {
      if (typeof redirect === "string") hops.add(redirect);
      else {
        hops.add(redirect.url);
        if (!URL.canParse(redirect.location, redirect.url))
          throw new AppError(
            "unsafe_url",
            "Scrapfly reported an invalid redirect.",
          );
        hops.add(new URL(redirect.location, redirect.url).href);
      }
    }
    await Promise.all(
      [...hops]
        .filter((hop) => hop !== target.href && hop !== final.href)
        .map(validatePublicUrl),
    );
    const markdown = cleanPage(result.content ?? "");
    const check = checkPage(markdown, target, final, result.status_code);
    errorCode = check.code === "ok" || check.warning ? null : check.code;
    if (check.code === "ok" && result.success === false)
      throw new AppError(
        "provider_response",
        "Scrapfly reported an unsuccessful scrape.",
      );
    return { markdown, check };
  } catch (error) {
    const caught = safeError(error);
    const failure =
      caught.code === "provider_request" || caught.code === "provider_response"
        ? (headerFailure ?? caught)
        : caught;
    const mapped =
      failure.code === "provider_request"
        ? new AppError(
            "provider_down",
            "Scrapfly is temporarily unavailable or timed out.",
          )
        : failure;
    errorCode = mapped.code;
    return {
      error: mapped,
      retryMs:
        retryable &&
        (mapped.code === "provider_down" ||
          (mapped.code === "provider_rate" && retryMs !== undefined))
          ? (retryMs ?? 500)
          : undefined,
    };
  } finally {
    writeProviderAttempt({
      provider: "scrapfly",
      rung,
      credits,
      durationMs: Math.round(performance.now() - start),
      errorCode,
    });
  }
}

export function scrapflyScrape(key: string): ScrapeProvider {
  const hosts = new Map<string, { rung: number; expires: number }>();
  function remember(host: string, rung: number) {
    hosts.delete(host);
    if (hosts.size >= 256) hosts.delete(hosts.keys().next().value!);
    hosts.set(host, { rung, expires: Date.now() + 4 * 60 * 60_000 });
  }
  return {
    name: "scrapfly",
    async scrape(url, outer, options = { tried: [] }) {
      const deadline = Date.now() + 50_000;
      const timer = AbortSignal.timeout(50_000);
      const signal = outer ? AbortSignal.any([outer, timer]) : timer;
      const target = await validatePublicUrl(url);
      target.hash = "";
      const host = target.hostname;
      const known = hosts.get(host);
      if (known && known.expires <= Date.now()) hosts.delete(host);
      const previous = hosts.get(host)?.rung ?? 0;
      const start = options.start ? scrapeRungs.indexOf(options.start) : 0;
      let retryUsed = false;
      let lastThin: string | undefined;
      let protectedSite = false;
      for (let index = Math.max(previous, start); index < scrapeRungs.length;) {
        const rung = scrapeRungs[index]!;
        if (signal.aborted)
          throw new AppError("provider_down", "Scrapfly ran out of time.", {
            tried: options.tried,
            hint: `Retry with start_rung: "${rung}".`,
          });
        options.tried.push(rung);
        const result = await requestPage(key, target, rung, signal);
        if (result.error) {
          if (
            !retryUsed &&
            result.retryMs !== undefined &&
            Date.now() + result.retryMs + 1500 < deadline &&
            !signal.aborted
          ) {
            retryUsed = true;
            await delay(result.retryMs, undefined, { signal });
            continue;
          }
          if (index === previous) hosts.delete(host);
          if (protectedSite && !hosts.has(host)) remember(host, 1);
          throw new AppError(result.error.code, result.error.message, {
            tried: options.tried,
          });
        }
        const { markdown, check } = result;
        const next = check.next === "render" ? 2 : index + 1;
        const stronger = scrapeRungs[next];
        const hint = stronger
          ? `Try start_rung: "${stronger}" for a stronger fetch.`
          : undefined;
        if (
          check.code === "ok" ||
          (check.warning &&
            (!check.next || !stronger || lastThin === check.code))
        ) {
          if (!check.next)
            remember(
              host,
              start > previous && hosts.get(host)?.rung === previous
                ? previous
                : index,
            );
          return { markdown, check, hint: check.next ? hint : undefined };
        }
        if (index === previous) hosts.delete(host);
        if (index === 0 && blocked.has(check.code)) protectedSite = true;
        if (
          !check.next ||
          !stronger ||
          next <= index ||
          (check.code === "consent" && lastThin === check.code)
        ) {
          if (protectedSite && !hosts.has(host)) remember(host, 1);
          throw new AppError(check.code, check.reason, {
            tried: options.tried,
            hint: check.next ? hint : undefined,
          });
        }
        lastThin = check.code;
        index = next;
      }
      throw new AppError("internal", "No scrape rung was selected.", {
        tried: options.tried,
      });
    },
  };
}
