import { MAX_PROVIDER_RESPONSE_BYTES } from "../config/safety-limits.js";
import type { RequestLimits } from "../server/request-limits.js";
import type { Usage } from "../server/usage.js";
import {
  scrapeReserveMs,
  scrapflyTimeoutMs,
  toolTimeoutMs,
} from "../config/deadline.js";
import { defaults, type Tuning } from "../config/tuning.js";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppError, safeError } from "../server/error.js";
import { writeProviderAttempt } from "../server/stats.js";
import { validatePublicUrl } from "../server/target.js";
import { checkPage, type PageCheck } from "../tools/page-check.js";
import { cleanPage } from "../tools/page-content.js";
import { providerResponse } from "./http.js";
import {
  scrapeRungs,
  type ScrapeProvider,
  type ScrapeResult,
  type ScrapeRung,
} from "./types.js";

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
      content_type: z.string().nullish(),
      response_headers: z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .nullish(),
      format: z.string().nullish(),
      status_code: z.number().int().min(100).max(599).nullish(),
      success: z.boolean().optional(),
      url: z.string().nullish(),
      error: z.object({ code: z.string() }).nullish(),
    })
    .nullish(),
  code: z.string().optional(),
});
const blocked = new Set(["blocked", "challenge"]);

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
  if (code === "ERR::SCRAPE::DOMAIN_NOT_ALLOWED")
    return new AppError(
      "unsafe_url",
      "Scrapfly refused a restricted target or redirect.",
    );
  if (code.includes("COST_BUDGET"))
    return new AppError(
      "provider_cost_budget",
      "Scrapfly exceeded this rung’s request cost budget.",
    );
  if (status === 401 || status === 403)
    return new AppError("provider_auth", "Scrapfly rejected the API key.");
  if (
    status === 402 ||
    /CREDIT|QUOTA|BALANCE_REQUIRED|USAGE_LIMIT|PAYMENT_REQUIRED/.test(code)
  )
    return new AppError(
      "provider_credit",
      "Scrapfly rejected the request for insufficient credit or account quota.",
    );
  if (status === 429)
    return new AppError("provider_rate", "Scrapfly is rate-limiting requests.");
}

function header(
  headers: Record<string, string | string[]> | null | undefined,
  name: string,
) {
  const value = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function mimeType(value: string | null | undefined, bytes: Buffer) {
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")))
    return "image/jpeg";
  const type = value?.split(";", 1)[0]?.trim().toLowerCase();
  return type && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type)
    ? type
    : "application/octet-stream";
}

async function downloadContent(
  content: string,
  endpoint: URL,
  key: string,
  signal: AbortSignal,
  format: "text" | "binary",
) {
  const url = URL.canParse(content) ? new URL(content) : undefined;
  if (
    !url ||
    url.protocol !== "https:" ||
    url.origin !== endpoint.origin ||
    url.username ||
    url.password
  )
    throw new AppError("provider_response", "Invalid Scrapfly content URL.");
  url.searchParams.set("key", key);
  const { response, body } = await providerResponse(
    "Scrapfly",
    url,
    { signal },
    undefined,
    format,
  );
  if (!response.ok || !(typeof body === "string" || Buffer.isBuffer(body)))
    throw new AppError(
      "provider_response",
      "Could not download Scrapfly content.",
    );
  return { body, contentType: response.headers.get("Content-Type") };
}

async function requestPage(
  key: string,
  target: URL,
  rung: ScrapeRung,
  timeout: number,
  settings: Tuning,
  signal: AbortSignal,
  usage?: Usage,
): Promise<ScrapeResult | { error: AppError; retryMs?: number }> {
  const startedAt = Date.now();
  const endpoint = new URL("https://api.scrapfly.io/scrape");
  const [pool, budget] = (
    {
      datacenter: [
        settings.scrapflyDatacenterPool,
        settings.scrapflyDatacenterCost,
      ],
      unblocker: [
        settings.scrapflyUnblockerPool,
        settings.scrapflyUnblockerCost,
      ],
      render: [settings.scrapflyRenderPool, settings.scrapflyRenderCost],
    } as const
  )[rung];
  endpoint.search = new URLSearchParams({
    key,
    url: target.href,
    proxy_pool: String(pool),
    cost_budget: String(budget),
    timeout: String(timeout),
    retry: "false",
    format: "markdown:no_images",
  }).toString();
  if (settings.scrapflyCountry)
    endpoint.searchParams.set("country", settings.scrapflyCountry);
  if (rung !== "datacenter") endpoint.searchParams.set("unblocker", "true");
  if (rung === "render") {
    endpoint.searchParams.set("render_js", "true");
    endpoint.searchParams.set(
      "rendering_wait",
      String(settings.scrapflyRenderingWaitMs),
    );
  }
  const start = performance.now();
  let credits: number | null = null;
  let errorCode: string | null = null;
  let providerStatus: number | undefined;
  let providerCode: string | undefined;
  const overrun = () => credits !== null && credits > budget;
  const costWarning = () =>
    overrun()
      ? `Scrapfly reported ${credits} credits for this attempt, above the ${budget}-credit rung budget.`
      : undefined;
  let retryMs: number | undefined;
  let retryable = true;
  let headerFailure: AppError | undefined;
  const localTimeout = AbortSignal.timeout(timeout);
  const requestSignal = AbortSignal.any([signal, localTimeout]);
  try {
    const { response, body } = await providerResponse(
      "Scrapfly",
      endpoint,
      {
        headers: { Accept: "application/json" },
        signal: requestSignal,
      },
      (headers) => {
        providerStatus = headers.status;
        const rejectCode = headers.headers.get("X-Scrapfly-Reject-Code") ?? "";
        if (/^ERR(?:::[A-Z0-9_]{1,64}){1,4}$/.test(rejectCode))
          providerCode = rejectCode;
        headerFailure = providerError(headers.status, rejectCode);
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
    if (/^ERR(?:::[A-Z0-9_]{1,64}){1,4}$/.test(code)) providerCode = code;
    const hops = new Set<string>();
    function redirect(from: string, location: string) {
      const url = URL.parse(location, from);
      if (!url)
        throw new AppError(
          "unsafe_url",
          "Scrapfly reported an invalid redirect.",
        );
      hops.add(url.href);
    }
    for (const hop of data?.context?.redirects ?? []) {
      if (typeof hop === "string") redirect(target.href, hop);
      else {
        hops.add(hop.url);
        redirect(hop.url, hop.location);
      }
    }
    if (result?.url) hops.add(result.url);
    const location = header(result?.response_headers, "location");
    if (
      location &&
      result?.status_code &&
      result.status_code >= 300 &&
      result.status_code < 400
    )
      redirect(result.url ?? target.href, location);
    await Promise.all(
      [...hops].filter((url) => url !== target.href).map(validatePublicUrl),
    );
    const failure = providerError(response.status, code);
    if (failure) throw failure;

    if (code === "ERR::SCRAPE::OPERATION_TIMEOUT")
      throw new AppError(
        "provider_down",
        "Scrapfly returned an upstream operation timeout.",
      );

    if (code === "ERR::ASP::TIMEOUT" || code === "ERR::ASP::CAPTCHA_TIMEOUT")
      throw new AppError("provider_down", "Scrapfly Unblocker timed out.");

    if (
      code.startsWith("ERR::ASP::") ||
      code.includes("UNBLOCKER_ULTRA_REQUIRED")
    ) {
      errorCode = "challenge";
      return {
        markdown: "",
        costWarning: costWarning(),
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
    const final = new URL(result.url);
    const contentType =
      header(result.response_headers, "content-type") ??
      result.content_type ??
      undefined;
    if (result.format === "blob" || result.format === "binary") {
      if (
        result.status_code < 200 ||
        result.status_code >= 300 ||
        result.success === false
      ) {
        const check = checkPage("", target, final, result.status_code);
        throw new AppError(
          check.code === "empty_page" ? "binary_download" : check.code,
          check.reason,
        );
      }
      let bytes: Buffer;
      let type = contentType;
      const content = result.content ?? "";
      if (result.format === "blob") {
        const downloaded = await downloadContent(
          content,
          endpoint,
          key,
          requestSignal,
          "binary",
        ).catch((error: unknown) => {
          throw new AppError("binary_download", safeError(error).message);
        });
        if (!Buffer.isBuffer(downloaded.body))
          throw new AppError(
            "binary_download",
            "Scrapfly returned an invalid binary download.",
          );
        bytes = downloaded.body;
        type = downloaded.contentType ?? type;
      } else {
        bytes = Buffer.from(content, "base64");
        if (bytes.toString("base64") !== content)
          throw new AppError(
            "binary_download",
            "Scrapfly returned invalid base64 for the download.",
          );
      }
      if (
        !bytes.length ||
        bytes.length >
          Math.min(MAX_PROVIDER_RESPONSE_BYTES, settings.outputMaxBytes)
      )
        throw new AppError(
          "output_size",
          "The binary download is empty or exceeds the output size limit.",
        );
      return {
        markdown: "",
        binary: { bytes, mimeType: mimeType(type, bytes) },
        costWarning: costWarning(),
        check: {
          code: "ok",
          reason: "Binary download ready.",
        } satisfies PageCheck,
      };
    }
    let content = result.content ?? "";
    if (result.format === "clob") {
      const downloaded = await downloadContent(
        content,
        endpoint,
        key,
        requestSignal,
        "text",
      );
      if (typeof downloaded.body !== "string")
        throw new AppError(
          "provider_response",
          "Scrapfly returned an invalid text download.",
        );
      content = downloaded.body;
    }
    const markdown = cleanPage(content);
    const check = checkPage(
      markdown,
      target,
      final,
      result.status_code,
      contentType,
    );
    errorCode = check.code === "ok" || check.warning ? null : check.code;
    if (check.code === "ok" && result.success === false)
      throw new AppError(
        "provider_response",
        "Scrapfly reported an unsuccessful scrape.",
      );
    return { markdown, check, costWarning: costWarning() };
  } catch (error) {
    const caught = safeError(error);
    const failure =
      caught.code === "provider_request" || caught.code === "provider_response"
        ? (headerFailure ?? caught)
        : caught;
    const mapped =
      failure.code === "provider_request"
        ? localTimeout.aborted
          ? new AppError(
              "provider_timeout",
              "The local Scrapfly HTTP deadline expired.",
            )
          : new AppError(
              "provider_down",
              "The HTTP request to Scrapfly failed.",
            )
        : failure;
    const warning = costWarning();
    const reported =
      warning && mapped.code !== "unsafe_url"
        ? new AppError("provider_cost_overrun", `${warning} ${mapped.message}`)
        : mapped;
    errorCode = reported.code;
    return {
      error: reported,
      retryMs:
        !warning &&
        retryable &&
        (["provider_down", "provider_timeout"].includes(mapped.code) ||
          (mapped.code === "provider_rate" && retryMs !== undefined))
          ? (retryMs ?? 500)
          : undefined,
    };
  } finally {
    usage?.record("scrapfly", credits, startedAt);
    writeProviderAttempt(
      {
        provider: "scrapfly",
        rung,
        credits,
        costBudget: budget,
        providerStatus,
        providerCode,
        durationMs: Math.round(performance.now() - start),
        errorCode,
        ...(rung === "datacenter"
          ? { datacenterBlocked: errorCode !== null && blocked.has(errorCode) }
          : {}),
      },
      settings,
    );
  }
}

export function scrapflyScrape(
  key: string,
  settings = defaults,
  limits?: RequestLimits,
  usage?: Usage,
): ScrapeProvider {
  const hosts = new Map<string, { rung: number; expires: number }>();
  function remember(host: string, rung: number) {
    hosts.delete(host);
    if (!settings.siteMemoryMs || !settings.siteMemorySize) return;
    if (hosts.size >= settings.siteMemorySize)
      hosts.delete(hosts.keys().next().value!);
    hosts.set(host, { rung, expires: Date.now() + settings.siteMemoryMs });
  }
  return {
    name: "scrapfly",
    async scrape(url, outer, options = { tried: [] }) {
      const deadline =
        (options.deadline ?? performance.now() + toolTimeoutMs(settings)) -
        scrapeReserveMs;
      const remaining = () => Math.floor(deadline - performance.now());
      const signal = outer ?? AbortSignal.timeout(toolTimeoutMs(settings));
      const target = await validatePublicUrl(url);
      target.hash = "";
      const host = target.hostname;
      const known = hosts.get(host);
      if (known && known.expires <= Date.now()) hosts.delete(host);
      const previous = hosts.get(host)?.rung ?? 0;
      const start = options.start ? scrapeRungs.indexOf(options.start) : 0;
      let retryUsed = false;
      let advancedRung: ScrapeRung | undefined;
      let lastBudgetError: AppError | undefined;
      let lastThin: string | undefined;
      let warning: { markdown: string; check: PageCheck } | undefined;
      let protectedSite = false;
      for (let index = Math.max(previous, start); index < scrapeRungs.length;) {
        const rung = scrapeRungs[index]!;
        const timeout = scrapflyTimeoutMs[rung];
        const defer = advancedRung !== undefined && advancedRung !== rung;
        if (signal.aborted || remaining() < timeout || defer) {
          if (protectedSite && !hosts.has(host)) remember(host, 1);
          const hint = `Retry with start_rung: "${rung}".`;
          if (warning) return { ...warning, hint };
          throw new AppError(
            "stronger_rung_required",
            lastBudgetError?.message ??
              (defer
                ? "Scrapfly needs another call for the next advanced rung."
                : "Too little time remains for Scrapfly’s minimum request timeout."),
            {
              tried: options.tried,
              hint,
            },
          );
        }
        if (rung !== "datacenter") advancedRung = rung;
        lastBudgetError = undefined;
        const release = await limits?.acquire(
          signal,
          deadline - timeout,
          "scrapfly",
          host,
        );
        const result = await (async () => {
          try {
            signal.throwIfAborted();
            options.tried.push(rung);
            return await requestPage(
              key,
              target,
              rung,
              timeout,
              settings,
              signal,
              usage,
            );
          } finally {
            release?.();
          }
        })();
        if ("error" in result) {
          if (
            !retryUsed &&
            result.retryMs !== undefined &&
            remaining() >= result.retryMs + timeout &&
            !signal.aborted
          ) {
            retryUsed = true;
            await delay(result.retryMs, undefined, { signal });
            continue;
          }
          if (index === previous) hosts.delete(host);
          if (protectedSite && !hosts.has(host)) remember(host, 1);
          if (
            result.error.code === "provider_cost_budget" &&
            index + 1 < scrapeRungs.length
          ) {
            lastBudgetError = result.error;
            index++;
            continue;
          }
          throw new AppError(result.error.code, result.error.message, {
            tried: options.tried,
          });
        }
        const { markdown, check, binary, costWarning } = result;
        if (costWarning) {
          if (check.code === "ok" || check.warning)
            return { markdown, check, binary, costWarning };
          throw new AppError(
            "provider_cost_overrun",
            `${costWarning} ${check.reason}`,
            { tried: options.tried },
          );
        }
        if (binary) return { markdown, check, binary };
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
        if (check.warning && markdown) warning = { markdown, check };
        lastThin = check.code;
        index = next;
      }
      throw new AppError("internal", "No scrape rung was selected.", {
        tried: options.tried,
      });
    },
  };
}
