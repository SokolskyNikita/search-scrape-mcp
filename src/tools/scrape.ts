import { messages } from "../config/messages.js";
import { statsContext, writeLimitEvent } from "../server/stats.js";
import { toolInput } from "./input.js";
import type { ResultCache } from "./result-cache.js";
import { defaults } from "../config/tuning.js";
import { MAX_URL_CHARS } from "../config/safety-limits.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  scrapeContentModes,
  scrapeRungs,
  type ScrapeProvider,
  type ScrapeResult,
} from "../providers/types.js";
import { validatePublicUrl } from "../server/target.js";
import type { OutputFiles } from "./output-files.js";
import { AppError, safeError } from "../server/error.js";
import { batch, fallback, toolResult, type Attempt } from "./shared.js";

const startRung = z
  .enum(scrapeRungs)
  .optional()
  .describe(
    "Page scrapes render JavaScript by default, except on sites known to load better without it. Select datacenter to start without rendering, or residential_render to render with residential IPs.",
  );
const retryAtHigherCost =
  "In rare cases a page is unusually costly to scrape. If the error includes a retry call, use that call.";
const scrapeFields = {
  content_mode: z
    .enum(scrapeContentModes)
    .default("main")
    .describe(
      "main extracts the main content with links. full returns whole-page Markdown.",
    ),
  start_rung: startRung,
  fresh: z.boolean().optional().describe("Bypass the local cache."),
  allow_higher_cost: z
    .boolean()
    .optional()
    .describe(
      "Set to true when a scrape error asks you to retry at higher cost.",
    ),
  max_chars: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Maximum inline Markdown characters per page. If shortened, the full text is saved to a local file.",
    ),
};
type ScrapeOptions = z.infer<z.ZodObject<typeof scrapeFields>>;
const urlInput = z.string().trim().min(1).max(MAX_URL_CHARS);

/** Registers the scrape tools with state of their own. The server shares one set through scrapeTools. */
export function registerScrape(
  server: McpServer,
  providers: readonly ScrapeProvider[],
  files: OutputFiles,
  settings = defaults,
  cache?: ResultCache<ScrapeResult & { tried: string[] }>,
) {
  scrapeTools(providers, files, settings, cache)(server);
}

/**
 * Builds the scrape tools once and returns a function that registers them. Their
 * memory of failing URLs has to outlive a request, and each request gets a new server.
 */
export function scrapeTools(
  providers: readonly ScrapeProvider[],
  files: OutputFiles,
  settings = defaults,
  cache?: ResultCache<ScrapeResult & { tried: string[] }>,
) {
  // Identical scrapes that arrive while one is in flight share its result, so
  // parallel agents asking for the same page fetch and pay for it once.
  type Fetched = ScrapeResult;
  const inFlight = new Map<
    string,
    {
      result: Promise<Fetched>;
      tried: string[];
      waiters: number;
      settled: boolean;
      controller: AbortController;
    }
  >();
  // Answers that will not change soon, so repeats get them at once.
  const settledFailures = new Map<string, { until: number; error: AppError }>();
  function checkSettledFailure(href: string, fresh: boolean | undefined) {
    const known = settledFailures.get(href);
    if (!known) return;
    if (fresh || known.until <= Date.now()) {
      settledFailures.delete(href);
      return;
    }
    writeLimitEvent({ code: "failure_memory", outcome: "hit" }, settings);
    throw known.error;
  }
  function rememberFailure(href: string, error: AppError) {
    if (!settings.failureMemoryMs) return;
    if (settledFailures.size >= 1_024)
      settledFailures.delete(settledFailures.keys().next().value!);
    settledFailures.set(href, {
      until: Date.now() + settings.failureMemoryMs,
      error,
    });
  }
  // URLs whose last scrape failed with provider_down, so repeats fail fast.
  const recentlyDown = new Map<string, number>();
  function checkRecentlyDown(href: string, fresh: boolean | undefined) {
    const until = recentlyDown.get(href);
    if (until === undefined) return;
    if (fresh || until <= Date.now()) {
      recentlyDown.delete(href);
      return;
    }
    writeLimitEvent({ code: "provider_down_memory", outcome: "hit" }, settings);
    throw new AppError("recently_down", messages.page.recentlyDown, {
      retryAt: new Date(until).toISOString(),
    });
  }
  function rememberDown(href: string) {
    if (!settings.providerDownMemoryMs) return;
    if (recentlyDown.size >= 1_024)
      recentlyDown.delete(recentlyDown.keys().next().value!);
    recentlyDown.set(href, Date.now() + settings.providerDownMemoryMs);
  }
  async function scrape(
    url: string,
    limit: number,
    attempt: Attempt,
    signal: AbortSignal,
    deadline: number,
    options: ScrapeOptions,
  ) {
    const {
      content_mode: contentMode,
      start_rung: start,
      fresh,
      allow_higher_cost: allowHigherCost,
      max_chars: maxChars,
    } = options;
    let tried: string[] = [];
    let href: string | undefined;
    const retry = (overrides: Partial<ScrapeOptions>) => ({
      name: "scrape",
      arguments: { url, ...options, ...overrides },
    });
    try {
      signal.throwIfAborted();
      const stats = statsContext.getStore()?.request;
      // Record the host before validation so refused URLs are attributed too.
      if (stats && URL.canParse(url)) stats.host = new URL(url).hostname;
      const target = await validatePublicUrl(url);
      href = target.href;
      if (stats) stats.host = target.hostname;
      checkRecentlyDown(target.href, fresh);
      checkSettledFailure(target.href, fresh);
      const key = JSON.stringify([
        target.href,
        start ?? "default",
        contentMode,
      ]);
      const hit = cache?.get(key, fresh);
      const {
        markdown,
        check: pageCheck,
        hint,
        retryRung,
        retryHigherCost,
        binary,
        extraction,
        costWarning,
        finalUrl,
      } = hit?.value ?? (await fetched());
      async function fetched(): Promise<Fetched> {
        const jobKey = JSON.stringify([key, Boolean(allowHigherCost)]);
        let job = fresh ? undefined : inFlight.get(jobKey);
        if (job)
          writeLimitEvent(
            { code: "scrape_in_flight", outcome: "hit" },
            settings,
          );
        else {
          // The shared fetch stops only when every caller waiting on it has left.
          const controller = new AbortController();
          const jobTried: string[] = [];
          const created = {
            result: fallback(
              contentMode === "full"
                ? providers.filter((provider) => provider.name === "scrapfly")
                : providers,
              (provider) =>
                provider.scrape(target.href, controller.signal, {
                  contentMode,
                  start,
                  tried: jobTried,
                  deadline,
                  allowHigherCost,
                }),
              attempt,
              controller.signal,
            ),
            tried: jobTried,
            waiters: 0,
            settled: false,
            controller,
          };
          const finish = () => {
            created.settled = true;
            if (inFlight.get(jobKey) === created) inFlight.delete(jobKey);
          };
          created.result.then(finish, finish);
          if (!fresh) inFlight.set(jobKey, created);
          job = created;
        }
        const shared = job;
        tried = shared.tried;
        shared.waiters++;
        const leave = () => {
          if (--shared.waiters === 0 && !shared.settled)
            shared.controller.abort(signal.reason);
        };
        if (signal.aborted) {
          leave();
          throw signal.reason;
        }
        return new Promise<Fetched>((resolve, reject) => {
          const stop = () => {
            leave();
            reject(signal.reason);
          };
          signal.addEventListener("abort", stop, { once: true });
          shared.result.then(
            (value) => {
              signal.removeEventListener("abort", stop);
              if (!signal.aborted) {
                shared.waiters--;
                resolve(value);
              }
            },
            (error) => {
              signal.removeEventListener("abort", stop);
              if (!signal.aborted) {
                shared.waiters--;
                reject(error);
              }
            },
          );
        });
      }
      signal.throwIfAborted();
      const check =
        !binary && !markdown.trim() && pageCheck.code === "ok"
          ? {
              code: "extraction_failed",
              reason: messages.page.extractionEmpty,
              warning: true as const,
            }
          : pageCheck;
      if (
        !hit &&
        !binary &&
        !extraction &&
        !costWarning &&
        check.code === "ok" &&
        !check.warning &&
        !check.next &&
        !hint
      )
        cache?.set(key, { markdown, check, tried, finalUrl });
      const inlineLimit = Math.min(limit, maxChars ?? limit);
      const previewLimit = maxChars === undefined ? undefined : inlineLimit;
      const output = binary
        ? files.saveBinary(binary)
        : extraction
          ? files.savePartial(
              markdown,
              extraction.html,
              inlineLimit,
              previewLimit,
            )
          : (files.spill(markdown, inlineLimit, previewLimit) ?? { markdown });
      const fallbackText = extraction?.fallbackText?.slice(
        0,
        Math.max(
          0,
          inlineLimit -
            ("markdown" in output
              ? output.markdown.length
              : "preview" in output
                ? (output.preview?.length ?? 0)
                : 0),
        ),
      );
      const result = {
        ...output,
        ...(fallbackText ? { fallbackText } : {}),
        ...("preview" in output ? { truncated: true } : {}),
        url: finalUrl ?? url,
        ...(extraction
          ? {
              extractionWarning: {
                code: "extraction_incomplete" as const,
                cause: extraction.cause,
                reason: markdown
                  ? messages.page.extractionPartial
                  : messages.page.extractionEmpty,
              },
            }
          : {}),
        ...(costWarning ? { warning: messages.page.costWarning } : {}),
        check,
        tried: hit?.value.tried ?? tried,
        ...(hit ? { cached: true, cached_at: hit.cached_at } : {}),
        ...(hint ? { nextHint: hint } : {}),
        ...(retryRung
          ? {
              retry: retry({
                start_rung: retryRung,
                ...(retryHigherCost ? { allow_higher_cost: true } : {}),
              }),
            }
          : {}),
      };
      const request = statsContext.getStore()?.request;
      if (request) {
        request.warningCode =
          result.extractionWarning?.code ??
          (check.warning ? check.code : undefined);
        if (hit) request.cached = true;
        if ("truncated" in result) request.truncated = true;
        request.outputChars = JSON.stringify(result).length;
      }
      return result;
    } catch (error) {
      const failure = signal.aborted
        ? safeError(signal.reason)
        : safeError(error);
      if (href && failure.code === "provider_down" && !signal.aborted)
        rememberDown(href);
      const settled =
        href &&
        !signal.aborted &&
        ["not_found", "sign_in"].includes(failure.code);
      if (
        ["provider_cost_opt_in_required", "provider_cost_budget"].includes(
          failure.code,
        )
      ) {
        throw new AppError(
          "scrape_cost",
          allowHigherCost ? messages.page.costStopped : messages.page.costRetry,
          allowHigherCost
            ? undefined
            : { retry: retry({ allow_higher_cost: true }) },
        );
      }
      if (failure.code === "provider_cost_overrun")
        throw new AppError("scrape_cost", messages.page.costStopped);
      const reported = new AppError(failure.code, failure.message, {
        tried,
        ...failure.details,
        ...(failure.details?.retryRung
          ? { retry: retry({ start_rung: failure.details.retryRung }) }
          : {}),
      });
      if (settled && href && !settledFailures.has(href))
        rememberFailure(href, reported);
      throw reported;
    }
  }

  return (server: McpServer) => {
    server.registerTool(
      "scrape",
      {
        description:
          "Read a public web page as main-content Markdown with links or save a binary download. " +
          `Text longer than ${settings.scrapeInlineChars} characters is saved to a local file. ` +
          retryAtHigherCost +
          " " +
          messages.page.untrusted,
        inputSchema: toolInput({
          url: urlInput,
          ...scrapeFields,
        }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      ({ url, ...options }, ctx) =>
        toolResult(
          "scrape",
          (attempt, signal, deadline) =>
            scrape(
              url,
              settings.scrapeInlineChars,
              attempt,
              signal,
              deadline,
              options,
            ),
          settings,
          {
            signal: ctx.mcpReq.signal,
            presentation: {
              operation: messages.operation.scrape,
              target: () => url,
            },
          },
        ),
    );
    server.registerTool(
      "scrape_batch",
      {
        description:
          "Read up to three public web pages in order as main-content Markdown with links. " +
          `Text longer than ${settings.scrapeBatchInlineChars} characters per page is saved to a local file. ` +
          retryAtHigherCost +
          " " +
          messages.page.untrusted,
        inputSchema: toolInput({
          urls: z
            .array(urlInput)
            .min(1)
            .max(
              3,
              "Use at most three URLs per call. Split larger lists into separate scrape_batch calls.",
            )
            .describe(
              "One to three URLs. Split larger lists into groups of at most three.",
            ),
          ...scrapeFields,
        }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      ({ urls, ...options }, ctx) =>
        toolResult(
          "scrape_batch",
          (attempt, signal, deadline) =>
            batch(
              urls,
              (url, itemAttempt) =>
                scrape(
                  url,
                  settings.scrapeBatchInlineChars,
                  itemAttempt,
                  signal,
                  deadline,
                  options,
                ),
              (url) =>
                URL.canParse(url)
                  ? new URL(url).hostname.replace(/\.$/, "")
                  : undefined,
              { tool: "scrape_batch", attempt, settings },
              signal,
            ),
          settings,
          {
            partialOnTimeout: true,
            signal: ctx.mcpReq.signal,
            presentation: {
              operation: messages.operation.scrape,
              targets: urls,
              batchSummary: true,
            },
          },
        ),
    );
  };
}
