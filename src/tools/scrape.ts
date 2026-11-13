import { messages } from "../config/messages.js";
import { statsContext, writeLimitEvent } from "../server/stats.js";
import { toolInput } from "./input.js";
import type { ResultCache } from "./result-cache.js";
import { defaults } from "../config/tuning.js";
import { MAX_URL_CHARS } from "../config/safety-limits.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
    "Page scrapes render JavaScript by default. Select datacenter or unblocker for the static-first ladder, or residential_render to render with residential IPs.",
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

export function registerScrape(
  server: McpServer,
  providers: readonly ScrapeProvider[],
  files: OutputFiles,
  settings = defaults,
  cache?: ResultCache<ScrapeResult & { tried: string[] }>,
) {
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
    const tried: string[] = [];
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
      } = hit?.value ??
      (await fallback(
        contentMode === "full"
          ? providers.filter((provider) => provider.name === "scrapfly")
          : providers,
        (provider) =>
          provider.scrape(target.href, signal, {
            contentMode,
            start,
            tried,
            deadline,
            allowHigherCost,
          }),
        attempt,
        signal,
      ));
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
      throw new AppError(failure.code, failure.message, {
        tried,
        ...failure.details,
        ...(failure.details?.retryRung
          ? { retry: retry({ start_rung: failure.details.retryRung }) }
          : {}),
      });
    }
  }

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
    ({ url, ...options }) =>
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
    ({ urls, ...options }) =>
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
          presentation: {
            operation: messages.operation.scrape,
            targets: urls,
            batchSummary: true,
          },
        },
      ),
  );
}
