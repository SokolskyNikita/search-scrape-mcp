import { siteScrapeSettings } from "../config/site-scrape-settings.js";
import { messages } from "../config/messages.js";
import { FileHosts, normalizeFileHost } from "../config/file-hosts.js";
import { SCRAPFLY_STANDARD_COST } from "../config/safety-limits.js";
import {
  datacenterFilePool,
  fileHeaders,
  identifyDownload,
  isHtml,
  looksLikeFile,
  maxFileBytes,
  refuseFile,
  type FileHeaders,
} from "./scrapfly-files.js";
import { MAX_PROVIDER_RESPONSE_BYTES } from "../config/safety-limits.js";
import type { RequestLimits } from "../server/request-limits.js";
import type { Usage } from "../server/usage.js";
import {
  scrapeReserveMs,
  scrapflyTimeoutMs,
  scrapflyFileTimeoutMs,
  toolTimeoutMs,
} from "../config/deadline.js";
import { defaults, type Tuning } from "../config/tuning.js";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppError, safeError } from "../server/error.js";
import { providerTarget, writeProviderAttempt } from "../server/stats.js";
import { validatePublicUrl } from "../server/target.js";
import { checkPage, type PageCheck } from "../tools/page-check.js";
import { mainContent } from "../tools/main-content.js";
import { cleanPage } from "../tools/page-content.js";
import { providerResponse } from "./http.js";
import {
  scrapeRungs,
  type ScrapeContentMode,
  type ScrapeOptions,
  type ScrapeProvider,
  type ScrapeResult,
  type ScrapeRung,
} from "./types.js";

const cost = z.number().finite().nonnegative();
const poolName = z.string().regex(/^[a-z0-9_-]{1,128}$/i);
const costBreakdown = z.object({
  total: cost.optional().catch(undefined),
  details: z
    .array(
      z.object({
        amount: cost,
        code: z.string().regex(/^[a-z0-9_:-]{1,128}$/i),
        description: z.string().max(256).optional(),
      }),
    )
    .max(100)
    .optional()
    .catch(undefined),
});
const billing = z.object({
  context: z
    .object({
      cost: z.union([cost, costBreakdown]).nullish().catch(undefined),
      proxy: z
        .union([
          poolName,
          z.object({
            pool: poolName.optional(),
          }),
        ])
        .nullish()
        .catch(undefined),
      proxy_pool: poolName.nullish().catch(undefined),
    })
    .nullish(),
});
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
      error: z
        .object({ code: z.string(), message: z.string().optional() })
        .nullish(),
    })
    .nullish(),
  code: z.string().optional(),
});
const blocked = new Set(["blocked", "challenge"]);
const poolUnavailable = "ERR::PROXY::POOL_NOT_AVAILABLE_FOR_TARGET";
const residentialBaseCredits = 25;

function creditHeader(response: Response, name: string) {
  const value = response.headers.get(name);
  if (!value?.trim()) return null;
  return cost.safeParse(Number(value)).data ?? null;
}

function busy(retryAt: number) {
  return new AppError("provider_rate", messages.service.busy, {
    retryAt: new Date(retryAt).toISOString(),
  });
}

function retryDelay(response: Response): number | undefined {
  const value =
    response.headers.get("Retry-After") ??
    response.headers.get("X-Scrapfly-Retry-After");
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

function providerError(status: number, code: string) {
  if (code === poolUnavailable)
    return new AppError(
      "provider_proxy_pool",
      `Scrapfly rejected the proxy pool for this host (${code}). Scrapfly may require residential access, which starts at ${residentialBaseCredits} credits.`,
    );
  if (code === "ERR::SCRAPE::DOMAIN_NOT_ALLOWED")
    return new AppError("unsafe_url", messages.input.publicUrl);
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

async function downloadContent(
  content: string,
  target: URL,
  recordCredits: (credits: number | null) => void,
  endpoint: URL,
  key: string,
  signal: AbortSignal,
  settings: Tuning,
  usage: Usage | undefined,
  checkBackoff: () => void,
  rateLimited: (ms: number) => number,
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
  checkBackoff();
  const startedAt = Date.now();
  const start = performance.now();
  let credits: number | null = null;
  let remainingCredits: number | null = null;
  let providerStatus: number | undefined;
  let errorCode: string | null = null;
  try {
    const { response, body } = await providerResponse(
      "Scrapfly",
      url,
      { signal },
      (headers) => {
        providerStatus = headers.status;
        credits = creditHeader(headers, "X-Scrapfly-Api-Cost");
        remainingCredits = creditHeader(
          headers,
          "X-Scrapfly-Remaining-Api-Credit",
        );
        if (headers.status === 429)
          throw busy(rateLimited(retryDelay(headers) ?? 1000));
      },
      "text",
    );
    if (!response.ok || typeof body !== "string")
      throw new AppError(
        "provider_response",
        "Could not download Scrapfly content.",
      );
    return body;
  } catch (error) {
    errorCode = safeError(error).code;
    throw error;
  } finally {
    recordCredits(credits);
    usage?.record("scrapfly", credits, startedAt);
    writeProviderAttempt(
      {
        provider: "scrapfly",
        ...providerTarget(target),
        rung: "clob",
        format: "clob",
        credits,
        remainingCredits,
        requestedProxyPool: null,
        proxyPool: null,
        costBreakdown: null,
        providerStatus,
        durationMs: Math.round(performance.now() - start),
        errorCode,
      },
      settings,
    );
  }
}

type DispatchScrape = <T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

async function requestPage(
  key: string,
  target: URL,
  rung: ScrapeRung,
  timeout: number,
  settings: Tuning,
  signal: AbortSignal,
  usage: Usage | undefined,
  fileHosts: FileHosts,
  checkBackoff: () => void,
  rateLimited: (ms: number) => number,
  contentMode: ScrapeContentMode,
  recordCredits: (credits: number | null) => void,
  operation: "head" | FileHeaders | undefined,
  dispatch: DispatchScrape,
  recordAttempt: () => void,
  budget: number,
  startSource?: "caller" | "site" | "memory" | "default",
): Promise<
  | (ScrapeResult & { transientTarget?: boolean; residentialUsed?: boolean })
  | { head: FileHeaders }
  | { error: AppError; retryMs?: number }
> {
  const endpoint = new URL("https://api.scrapfly.io/scrape");
  const pool = {
    datacenter: settings.scrapflyDatacenterPool,
    render: settings.scrapflyRenderPool,
    residential_render: "public_residential_pool",
  }[rung];
  const requestedProxyPool = operation
    ? datacenterFilePool
    : (siteScrapeSettings(target.hostname)?.proxyPool ?? pool);
  const raw = contentMode === "main" && !operation;
  const formatRequested = raw ? "raw" : "markdown:no_images";
  endpoint.search = new URLSearchParams({
    key,
    url: target.href,
    proxy_pool: requestedProxyPool,
    cost_budget: String(budget),
    timeout: String(timeout),
    retry: "false",
    format: formatRequested,
  }).toString();
  if (settings.scrapflyCountry)
    endpoint.searchParams.set("country", settings.scrapflyCountry);
  if (!operation) endpoint.searchParams.set("unblocker", "true");
  if (!operation && (rung === "render" || rung === "residential_render")) {
    endpoint.searchParams.set("render_js", "true");
    endpoint.searchParams.set(
      "rendering_wait",
      String(settings.scrapflyRenderingWaitMs),
    );
  }
  let startedAt: number | undefined;
  let start = 0;
  let credits: number | null = null;
  let remainingCredits: number | null = null;
  let proxyPool: string | null = null;
  let breakdown: z.infer<typeof costBreakdown> | number | null = null;
  let errorCode: string | null = null;
  let providerStatus: number | undefined;
  let providerCode: string | undefined;
  let contentCredits: number | null = null;
  const costWarning = () => {
    const highestCharge = Math.max(credits ?? 0, contentCredits ?? 0);
    return highestCharge > SCRAPFLY_STANDARD_COST
      ? `Scrapfly reported ${highestCharge} credits for this attempt, above the ${SCRAPFLY_STANDARD_COST}-credit standard budget.`
      : undefined;
  };
  let retryMs: number | undefined;
  let retryAt: number | undefined;
  let retryable = true;
  let headerFailure: AppError | undefined;
  let localTimeout: AbortSignal | undefined;
  let requestSignal = signal;
  try {
    const { response, body } = await dispatch(() => {
      recordAttempt();
      startedAt = Date.now();
      start = performance.now();
      localTimeout = AbortSignal.timeout(timeout);
      requestSignal = AbortSignal.any([signal, localTimeout]);
      return providerResponse(
        "Scrapfly",
        endpoint,
        {
          method: operation === "head" ? "HEAD" : "GET",
          headers: { Accept: "application/json" },
          signal: requestSignal,
        },
        (headers) => {
          providerStatus = headers.status;
          const rejectCode =
            headers.headers.get("X-Scrapfly-Reject-Code") ?? "";
          if (/^ERR(?:::[A-Z0-9_]{1,64}){1,4}$/.test(rejectCode))
            providerCode = rejectCode;
          headerFailure = providerError(headers.status, rejectCode);
          credits = creditHeader(headers, "X-Scrapfly-Api-Cost");
          remainingCredits = creditHeader(
            headers,
            "X-Scrapfly-Remaining-Api-Credit",
          );
          retryMs = retryDelay(headers);
          if (headers.status === 429) {
            retryAt = rateLimited(retryMs ?? 1000);
            headerFailure ??= busy(retryAt);
          }
          retryable =
            headers.headers
              .get("X-Scrapfly-Reject-Retryable")
              ?.toLowerCase() !== "false";
        },
      );
    });
    const parsed = envelope.safeParse(body);
    const data = parsed.success ? parsed.data : undefined;
    const context = billing.safeParse(body).data?.context;
    const charged = context?.cost;
    breakdown = charged ?? null;
    const proxy = context?.proxy;
    proxyPool =
      (typeof proxy === "string" ? proxy : proxy?.pool) ??
      context?.proxy_pool ??
      null;
    credits =
      typeof charged === "number" ? charged : (charged?.total ?? credits);
    const result = data?.result;
    const code =
      response.headers.get("X-Scrapfly-Reject-Code") ??
      result?.error?.code ??
      data?.code ??
      "";
    if (/^ERR(?:::[A-Z0-9_]{1,64}){1,4}$/.test(code)) providerCode = code;
    const upstream =
      code.includes("UPSTREAM_WEBSITE_ERROR") ||
      code.includes("BAD_UPSTREAM_RESPONSE");
    const hops = new Set<string>();
    // An upstream rejection can omit both the target response and redirect log.
    // For an explicit redirect endpoint, the requested destination is still known.
    if (upstream && target.pathname.endsWith("/redirect-to")) {
      const destination = target.searchParams.get("url");
      if (destination) redirect(target.href, destination);
    }
    // Error messages can include a nested redirect URL even when the hop list is empty.
    for (const match of result?.error?.message
      ?.slice(0, 8192)
      .matchAll(/(?=(https?:\/\/[^\s<>"'\x60]+))/gi) ?? []) {
      const url = URL.parse(match[1]!);
      if (url && url.origin !== target.origin) hops.add(url.href);
    }
    function redirect(from: string, location: string) {
      const url = URL.parse(location, from);
      if (!url) throw new AppError("unsafe_url", messages.input.redirect);
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
    if (
      operation === "head" &&
      response.status >= 300 &&
      response.status < 400
    ) {
      const location = response.headers.get("location");
      if (location) {
        const redirected = URL.parse(location, target);
        if (!redirected)
          throw new AppError("unsafe_url", messages.input.redirect);
        await validatePublicUrl(redirected.href);
      }
    }
    const failure =
      providerError(response.status, code) ??
      (retryAt === undefined ? undefined : busy(retryAt));
    if (failure) throw failure;

    if (operation === "head") {
      if (code === "ERR::SCRAPE::OPERATION_TIMEOUT")
        throw refuseFile(
          { type: "unknown" },
          "the target timed out during the HEAD check. A retry may work.",
          messages.file.unknownSize,
        );
      const metadata = fileHeaders(
        response.headers.get("content-type"),
        response.headers.get("content-length"),
      );
      if (!response.ok || code)
        throw refuseFile(
          { type: "unknown" },
          "datacenter HEAD did not verify the target.",
          messages.file.unknownSize,
        );
      const warning = costWarning();
      if (warning) throw new AppError("provider_cost_overrun", warning);
      return { head: metadata };
    }

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
    const format = result.format?.toLowerCase();
    if (format === "blob" || format === "binary") {
      const metadata = fileHeaders(
        contentType,
        header(result.response_headers, "content-length"),
      );
      if (!operation) {
        fileHosts.remember(normalizeFileHost(target.hostname));
        fileHosts.remember(normalizeFileHost(final.hostname));
      }
      if (format === "blob")
        throw refuseFile(
          metadata,
          `Scrapfly returned a BLOB (over 5 MB).${credits === null ? "" : ` Scrapfly reported ${credits} credits for the scrape.`}`,
          messages.file.tooLarge,
        );
      if (
        result.status_code < 200 ||
        result.status_code >= 300 ||
        result.success === false
      )
        throw new AppError(
          "binary_download",
          `File fetch failed (HTTP ${result.status_code}).`,
        );
      const content = result.content ?? "";
      const bytes = Buffer.from(content, "base64");
      if (bytes.toString("base64") !== content)
        throw new AppError(
          "binary_download",
          "Scrapfly returned invalid base64 for the download.",
        );
      if (operation && bytes.length > maxFileBytes)
        throw refuseFile(
          { type: metadata.type, size: bytes.length },
          "the downloaded file exceeded 5 MB.",
          messages.file.tooLarge,
        );
      if (
        !bytes.length ||
        bytes.length >
          Math.min(MAX_PROVIDER_RESPONSE_BYTES, settings.outputMaxBytes)
      )
        throw new AppError(
          "output_size",
          "The binary download is empty or exceeds the output size limit.",
        );
      const type =
        metadata.type === "unknown" && operation
          ? operation.type
          : metadata.type;
      if (operation?.type === "application/pdf" && type !== "application/pdf")
        throw new AppError(
          "binary_download",
          "The target changed content type after the PDF HEAD check.",
        );
      return {
        markdown: "",
        binary: await identifyDownload(bytes, type),
        finalUrl: final.href,
        costWarning: costWarning(),
        check: { code: "ok", reason: "Binary download ready." },
      };
    }
    let content = result.content ?? "";
    if (format === "clob" && !operation) {
      content = await dispatch(
        () =>
          downloadContent(
            content,
            target,
            (charge) => {
              contentCredits = charge;
              recordCredits(charge);
            },
            endpoint,
            key,
            requestSignal,
            settings,
            usage,
            checkBackoff,
            rateLimited,
          ),
        requestSignal,
      );
    }
    const html =
      isHtml(fileHeaders(contentType).type) ||
      (!contentType && /^\s*(?:<!doctype html\b|<html[\s>])/i.test(content));
    let markdown: string;
    let check: PageCheck;
    let extraction: ScrapeResult["extraction"];
    if (raw && html) {
      const extracted = await mainContent(
        content,
        target,
        final,
        result.status_code,
        contentType,
        result.success,
      );
      ({ markdown, check } = extracted);
      if (extracted.extractionCause)
        extraction = {
          cause: extracted.extractionCause,
          html: content,
          ...(extracted.fallbackText
            ? { fallbackText: extracted.fallbackText }
            : {}),
        };
    } else {
      markdown = cleanPage(content);
      check = checkPage(
        markdown,
        target,
        final,
        result.status_code,
        contentType,
      );
    }
    if (operation && check.code === "ok")
      throw new AppError(
        "binary_download",
        "Expected a file after the HEAD check but received page content.",
      );
    // Only a target response (as opposed to Scrapfly's own HTTP errors)
    // can trigger this limited retry path.
    const transientTarget =
      !operation &&
      (result.status_code === 429 ||
        (result.status_code >= 500 && check.code === "target_http"));
    errorCode =
      extraction || check.code === "ok" || check.warning ? null : check.code;
    if (check.code === "ok" && result.success === false)
      throw new AppError(
        "provider_response",
        "Scrapfly reported an unsuccessful scrape.",
      );
    return {
      markdown,
      check,
      extraction,
      finalUrl: final.href,
      costWarning: costWarning(),
      transientTarget,
      residentialUsed:
        /(?:^|_)residential(?:_|$)/i.test(proxyPool ?? "") ||
        (typeof charged === "object" &&
          charged?.details?.some(
            ({ code }) => code === "PROXY_RESIDENTIAL_NETWORK",
          )),
    };
  } catch (error) {
    if (startedAt === undefined) throw error;
    const caught = safeError(error);
    const failure =
      caught.code === "provider_request" || caught.code === "provider_response"
        ? (headerFailure ?? caught)
        : caught;
    const mapped =
      failure.code === "provider_request"
        ? localTimeout?.aborted
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
      warning &&
      ![
        "unsafe_url",
        "unsupported_in_scrape",
        "provider_cost_overrun",
        "file_refused",
        "binary_download",
        "provider_proxy_pool",
        "provider_rate",
      ].includes(mapped.code)
        ? new AppError("provider_cost_overrun", `${warning} ${mapped.message}`)
        : mapped;
    errorCode = reported.code;
    return {
      error: reported,
      retryMs:
        !warning &&
        retryable &&
        ["provider_down", "provider_timeout"].includes(mapped.code)
          ? (retryMs ?? 500)
          : undefined,
    };
  } finally {
    if (startedAt !== undefined) {
      fileHosts.observeCost(normalizeFileHost(target.hostname), credits);
      recordCredits(credits);
      usage?.record("scrapfly", credits, startedAt);
      writeProviderAttempt(
        {
          provider: "scrapfly",
          ...providerTarget(target),
          rung: operation === "head" ? "datacenter_head" : rung,
          format: formatRequested,
          credits,
          remainingCredits,
          requestedProxyPool,
          proxyPool,
          costBreakdown: breakdown,
          costBudget: budget,
          ...(startSource && operation !== "head" ? { startSource } : {}),
          providerStatus,
          providerCode,
          durationMs: Math.round(performance.now() - start),
          errorCode,
          ...(rung === "datacenter" && operation !== "head"
            ? {
                datacenterBlocked: errorCode !== null && blocked.has(errorCode),
              }
            : {}),
        },
        settings,
      );
    }
  }
}

export function scrapflyScrape(
  key: string,
  settings = defaults,
  limits?: RequestLimits,
  usage?: Usage,
  fileHosts = new FileHosts(settings.scrapflyFileHosts),
): ScrapeProvider {
  // The app shares this provider across all MCP sessions.
  let busyUntil = 0;
  function checkBackoff() {
    if (Date.now() < busyUntil) throw busy(busyUntil);
  }
  const rateLimited = (ms: number) =>
    (busyUntil = Math.max(busyUntil, Date.now() + ms));
  const hosts = new Map<string, { rung: number; expires: number }>();
  function remember(host: string, rung: number) {
    hosts.delete(host);
    if (!settings.siteMemoryMs || !settings.siteMemorySize) return;
    if (hosts.size >= settings.siteMemorySize)
      hosts.delete(hosts.keys().next().value!);
    hosts.set(host, { rung, expires: Date.now() + settings.siteMemoryMs });
  }
  const implementation = {
    async scrape(
      url: string,
      outer: AbortSignal | undefined,
      options: ScrapeOptions,
      recordCredits: (credits: number | null) => void,
    ): Promise<ScrapeResult> {
      const deadline =
        (options.deadline ?? performance.now() + toolTimeoutMs(settings)) -
        scrapeReserveMs;
      const remaining = () => Math.floor(deadline - performance.now());
      const signal = outer ?? AbortSignal.timeout(toolTimeoutMs(settings));
      const target = await validatePublicUrl(url);
      target.hash = "";
      const host = normalizeFileHost(target.hostname);
      const { hosts: knownFiles, costs } = fileHosts.read();
      const notice = costs.get(host);
      if (notice && !options.allowHigherCost)
        throw new AppError(
          "provider_cost_opt_in_required",
          `Scrapfly has charged up to ${notice.expectedCredits} credits for a page on this host, above the ${SCRAPFLY_STANDARD_COST}-credit standard budget. Set allow_higher_cost: true to proceed.`,
          { expectedCredits: notice.expectedCredits },
        );
      const knownFile = knownFiles.has(host);
      let file: FileHeaders | undefined;
      const admission = limits?.budget();
      const budget = options.allowHigherCost
        ? settings.scrapflyExpensiveCost
        : SCRAPFLY_STANDARD_COST;
      let overrunCredits: number | undefined;
      // Set once the ladder's start is chosen; HEAD checks run before that.
      const ladder: {
        startSource?: "caller" | "site" | "memory" | "default";
      } = {};
      async function attempt(
        rung: ScrapeRung,
        operation?: "head" | FileHeaders,
      ) {
        if (overrunCredits !== undefined)
          throw new AppError(
            "provider_cost_overrun",
            `Scrapfly reported ${overrunCredits} credits on a previous attempt.`,
          );
        checkBackoff();
        const spent = settings.scrapflyDailyCredits
          ? (usage?.scrapflyCreditsToday() ?? 0)
          : 0;
        if (
          settings.scrapflyDailyCredits &&
          spent >= settings.scrapflyDailyCredits
        ) {
          const retryAt = new Date(
            (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000,
          ).toISOString();
          throw new AppError(
            "local_credit_limit",
            `Today's Scrapfly credit cap (${settings.scrapflyDailyCredits}) is used up. Retry at ${retryAt}.`,
            { retryAt },
          );
        }
        const timeout = operation
          ? scrapflyFileTimeoutMs
          : scrapflyTimeoutMs[rung];
        const dispatch: DispatchScrape = (task, requestSignal) => {
          if (!limits || !admission) return task();
          return limits.run(
            "scrapfly",
            requestSignal ?? signal,
            requestSignal ? deadline : deadline - timeout,
            admission,
            task,
            host,
            checkBackoff,
          );
        };
        return requestPage(
          key,
          target,
          rung,
          timeout,
          settings,
          signal,
          usage,
          fileHosts,
          checkBackoff,
          rateLimited,
          options.contentMode ?? "main",
          (credits) => {
            if (credits !== null && credits > SCRAPFLY_STANDARD_COST)
              overrunCredits = credits;
            recordCredits(credits);
          },
          operation,
          dispatch,
          () =>
            options.tried.push(operation === "head" ? "datacenter_head" : rung),
          budget,
          ladder.startSource,
        );
      }
      const filePath = looksLikeFile(target);
      if (filePath || knownFile) {
        if (remaining() < scrapflyFileTimeoutMs)
          throw refuseFile(
            { type: "unknown" },
            "too little time remains for the HEAD check.",
            messages.service.timeout,
          );
        const checked = await attempt("datacenter", "head");
        if ("error" in checked) {
          if (
            ["provider_timeout", "provider_down", "provider_http"].includes(
              checked.error.code,
            )
          )
            throw refuseFile(
              { type: "unknown" },
              `datacenter HEAD failed. ${checked.error.message}`,
              messages.file.unknownSize,
            );
          throw checked.error;
        }
        if (!("head" in checked))
          throw new AppError("internal", "Expected Scrapfly HEAD metadata.");
        if (filePath && isHtml(checked.head.type))
          throw refuseFile(
            checked.head,
            "datacenter HEAD reported an HTML page for the file URL.",
            messages.file.html,
          );
        if (!isHtml(checked.head.type)) {
          file = checked.head;
          if (options.start && options.start !== "datacenter")
            throw refuseFile(
              file,
              "downloads are allowed only on datacenter.",
              messages.file.mode,
            );
          if (file.size === undefined)
            throw refuseFile(
              file,
              "datacenter HEAD did not report a valid content length.",
              messages.file.unknownSize,
            );
          if (file.size > maxFileBytes)
            throw refuseFile(
              file,
              "the size exceeds 5 MB.",
              messages.file.tooLarge,
            );
        }
      }
      const site = siteScrapeSettings(target.hostname);
      // The caller's choice wins, then the site's own start, then rendering.
      const initialRung = options.start ?? site?.startRung ?? "render";
      const start = scrapeRungs.indexOf(initialRung);
      const renderedStart =
        initialRung === "render" || initialRung === "residential_render";
      const canEscalateRender =
        renderedStart &&
        !site?.proxyPool &&
        settings.scrapflyRenderPool !== "public_residential_pool";
      const renderRung = scrapeRungs.indexOf("render");
      const lastRung =
        initialRung === "residential_render" || canEscalateRender
          ? scrapeRungs.indexOf("residential_render")
          : renderRung;
      const memoryKey = renderedStart ? `render:${host}` : host;
      const known = hosts.get(memoryKey);
      if (known && known.expires <= Date.now()) hosts.delete(memoryKey);
      const previous = hosts.get(memoryKey)?.rung ?? 0;
      let retryUsed = false;
      let advancedRung: ScrapeRung | undefined;
      let lastBudgetError: AppError | undefined;
      let lastThin: string | undefined;
      let warning: ScrapeResult | undefined;
      let protectedSite = false;
      ladder.startSource = file
        ? undefined
        : Math.min(previous, lastRung) > start
          ? "memory"
          : options.start
            ? "caller"
            : site
              ? "site"
              : "default";
      for (
        let index = file ? 0 : Math.max(Math.min(previous, lastRung), start);
        index <= lastRung;
      ) {
        const rung = scrapeRungs[index]!;
        const timeout = file ? scrapflyFileTimeoutMs : scrapflyTimeoutMs[rung];
        const defer = advancedRung !== undefined && advancedRung !== rung;
        if (signal.aborted || remaining() < timeout || defer) {
          if (protectedSite && !hosts.has(memoryKey)) remember(memoryKey, 1);
          if (file)
            throw refuseFile(
              file,
              "too little time remains for a datacenter download.",
              messages.service.timeout,
            );
          const hint = messages.page.retryRung(rung);
          if (warning) return { ...warning, hint, retryRung: rung };
          throw new AppError(
            lastBudgetError?.code ?? "stronger_rung_required",
            lastBudgetError?.message ??
              (defer
                ? "Scrapfly needs another call for the next advanced rung."
                : "Too little time remains for Scrapfly’s minimum request timeout."),
            {
              tried: options.tried,
              hint,
              retryRung: rung,
            },
          );
        }
        if (!renderedStart && rung !== "datacenter") advancedRung = rung;
        lastBudgetError = undefined;
        const result = await attempt(rung, file);
        if ("head" in result)
          throw new AppError("internal", "Unexpected Scrapfly HEAD metadata.");
        if ("error" in result) {
          if (
            !file &&
            !retryUsed &&
            result.retryMs !== undefined &&
            remaining() >= result.retryMs + timeout &&
            !signal.aborted
          ) {
            retryUsed = true;
            await delay(result.retryMs, undefined, { signal });
            continue;
          }
          if (index === previous) hosts.delete(memoryKey);
          if (protectedSite && !hosts.has(memoryKey)) remember(memoryKey, 1);
          if (
            !file &&
            result.error.code === "provider_cost_budget" &&
            index < lastRung
          ) {
            lastBudgetError = result.error;
            index++;
            continue;
          }
          const error =
            file &&
            [
              "provider_http",
              "provider_response",
              "provider_down",
              "provider_timeout",
            ].includes(result.error.code)
              ? refuseFile(
                  file,
                  `datacenter could not deliver the file. ${result.error.message}`,
                )
              : result.error;
          throw new AppError(error.code, error.message, {
            tried: options.tried,
            ...error.details,
          });
        }
        const {
          markdown,
          check,
          binary,
          costWarning,
          transientTarget,
          residentialUsed,
          finalUrl,
        } = result;
        if (binary) return result;
        if (result.extraction) {
          if (
            file ||
            check.code !== "extraction_failed" ||
            costWarning ||
            rung === "residential_render" ||
            (rung === "render" && (!canEscalateRender || residentialUsed))
          )
            return result;
          const retryRung = rung === "render" ? "residential_render" : "render";
          const hint = messages.page.retryRung(retryRung);
          if (overrunCredits !== undefined) return result;
          if (
            site?.extractionRetry === "manual" ||
            remaining() < scrapflyTimeoutMs[retryRung]
          )
            return { ...result, hint, retryRung };
          try {
            const stronger = await attempt(retryRung);
            if ("error" in stronger) {
              if (
                stronger.error.code === "provider_cost_budget" &&
                !options.allowHigherCost
              )
                return {
                  ...result,
                  hint: messages.page.costRetry,
                  retryRung,
                  retryHigherCost: true,
                };
              return overrunCredits !== undefined
                ? { ...result, costWarning: messages.page.costWarning }
                : result;
            }
            if ("head" in stronger) return result;
            if (
              stronger.binary ||
              (!stronger.extraction && stronger.check.code === "ok")
            )
              return stronger;
            if (
              stronger.extraction &&
              stronger.markdown.length > markdown.length
            )
              return stronger;
            return {
              ...result,
              costWarning: stronger.costWarning ?? costWarning,
            };
          } catch (error) {
            if (signal.aborted || !(error instanceof AppError)) throw error;
            return result;
          }
        }
        if (file)
          throw refuseFile(
            file,
            `datacenter could not deliver the file. ${check.reason}`,
          );
        if (costWarning) {
          if (check.code === "ok" || check.warning)
            return { markdown, check, costWarning, finalUrl };
          throw new AppError(
            "provider_cost_overrun",
            `${costWarning} ${check.reason}`,
            { tried: options.tried },
          );
        }
        if (transientTarget) {
          // The target itself answered 429 or 5xx: try the same rung once more.
          const retryRung = rung;
          if (retryUsed || signal.aborted)
            throw new AppError(check.code, check.reason, {
              tried: options.tried,
            });
          if (remaining() < scrapflyTimeoutMs[retryRung])
            throw new AppError(check.code, check.reason, {
              tried: options.tried,
              hint: messages.page.retryRung(retryRung),
              retryRung,
            });
          retryUsed = true;
          continue;
        }
        const next =
          check.next === "render" && index < renderRung
            ? renderRung
            : index + 1;
        const stronger =
          next <= lastRung && !(rung === "render" && residentialUsed)
            ? scrapeRungs[next]
            : undefined;
        const hint = stronger ? messages.page.retryRung(stronger) : undefined;
        if (
          check.code === "ok" ||
          (check.warning &&
            (!check.next || !stronger || lastThin === check.code))
        ) {
          if (!check.next && (!renderedStart || index > start))
            remember(
              memoryKey,
              start > previous && hosts.get(memoryKey)?.rung === previous
                ? previous
                : index,
            );
          return {
            markdown,
            check,
            finalUrl,
            hint: check.next ? hint : undefined,
            ...(check.next && stronger ? { retryRung: stronger } : {}),
          };
        }
        if (index === previous) hosts.delete(memoryKey);
        if (index === 0 && blocked.has(check.code)) protectedSite = true;
        if (!check.next || !stronger || next <= index) {
          if (protectedSite && !hosts.has(memoryKey)) remember(memoryKey, 1);
          throw new AppError(check.code, check.reason, {
            tried: options.tried,
            hint: check.next ? hint : undefined,
            ...(check.next && stronger ? { retryRung: stronger } : {}),
          });
        }
        if (check.warning && markdown) warning = { markdown, check, finalUrl };
        lastThin = check.code;
        index = next;
      }
      throw new AppError("internal", "No scrape rung was selected.", {
        tried: options.tried,
      });
    },
  };
  return {
    name: "scrapfly",
    async scrape(url, outer, options = { tried: [] }) {
      let totalCredits: number | undefined;
      const recordCredits = (credits: number | null) => {
        if (credits !== null) totalCredits = (totalCredits ?? 0) + credits;
      };
      try {
        return {
          ...(await implementation.scrape(url, outer, options, recordCredits)),
          credits: totalCredits,
        };
      } catch (error) {
        if (!(error instanceof AppError) || totalCredits === undefined)
          throw error;
        throw new AppError(error.code, error.message, {
          tried: options.tried,
          ...error.details,
          credits: totalCredits,
        });
      }
    },
  };
}
