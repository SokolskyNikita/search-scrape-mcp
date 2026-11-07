import { toolInput } from "./input.js";
import type { ResultCache } from "./result-cache.js";
import { defaults } from "../config/tuning.js";
import { MAX_URL_CHARS } from "../config/safety-limits.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  scrapeContentModes,
  scrapeRungs,
  type ScrapeContentMode,
  type ScrapeProvider,
  type ScrapeResult,
  type ScrapeRung,
} from "../providers/types.js";
import { validatePublicUrl } from "../server/target.js";
import type { OutputFiles } from "./output-files.js";
import { AppError, safeError } from "../server/error.js";
import { batch, fallback, toolResult, type Attempt } from "./shared.js";

const startRung = z
  .enum(scrapeRungs)
  .optional()
  .describe("Start at this rung or higher if the hostname already needs it.");
const contentModeInput = z
  .enum(scrapeContentModes)
  .default("main")
  .describe(
    "main extracts the main content with links using Defuddle. full returns Scrapfly whole-page Markdown.",
  );
const fileLimits =
  "Files are checked before downloading and limited to 5 MB on datacenter. Scrapfly may charge above the requested cost_budget.";
const freshInput = z.boolean().optional().describe("Bypass the local cache.");
const allowHigherCostInput = z
  .boolean()
  .optional()
  .describe(
    "Allow Scrapfly requests to hosts flagged for higher charges in this call.",
  );
const urlInput = z.string().trim().min(1).max(MAX_URL_CHARS);

export function registerScrape(
  server: McpServer,
  providers: readonly ScrapeProvider[],
  files: OutputFiles,
  settings = defaults,
  cache?: ResultCache<ScrapeResult & { tried: string[] }>,
) {
  async function scrape(
    url: string,
    limit: number,
    attempt: Attempt,
    signal: AbortSignal,
    deadline: number,
    contentMode: ScrapeContentMode,
    start?: ScrapeRung,
    fresh?: boolean,
    allowHigherCost?: boolean,
  ) {
    const tried: string[] = [];
    try {
      signal.throwIfAborted();
      const target = await validatePublicUrl(url);
      const key = JSON.stringify([
        target.href,
        start ?? "datacenter",
        contentMode,
      ]);
      const hit = cache?.get(key, fresh);
      const { markdown, check, hint, binary, costWarning, credits } =
        hit ??
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
      if (
        !hit &&
        !binary &&
        check.code === "ok" &&
        !check.warning &&
        !check.next &&
        !hint
      )
        cache?.set(key, { markdown, check, tried, costWarning });
      return {
        ...(binary
          ? files.saveBinary(binary)
          : (files.spill(markdown, limit) ?? { markdown })),
        ...(costWarning ? { costWarning } : {}),
        ...(credits !== undefined ? { credits } : {}),
        check,
        tried: hit?.tried ?? tried,
        ...(hit ? { cached: true } : {}),
        ...(hint ? { nextHint: hint } : {}),
      };
    } catch (error) {
      const failure = signal.aborted
        ? safeError(signal.reason)
        : safeError(error);
      throw new AppError(failure.code, failure.message, {
        tried,
        ...failure.details,
        hint: failure.details?.hint,
      });
    }
  }

  server.registerTool(
    "scrape",
    {
      description:
        "Read a public web page as main-content Markdown with links or save a binary download. Set content_mode to full for Scrapfly whole-page Markdown. Large results are saved to a local file. " +
        fileLimits,
      inputSchema: toolInput({
        url: urlInput,
        content_mode: contentModeInput,
        start_rung: startRung,
        fresh: freshInput,
        allow_higher_cost: allowHigherCostInput,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ url, content_mode, start_rung, fresh, allow_higher_cost }) =>
      toolResult(
        "scrape",
        (attempt, signal, deadline) =>
          scrape(
            url,
            settings.scrapeInlineChars,
            attempt,
            signal,
            deadline,
            content_mode,
            start_rung,
            fresh,
            allow_higher_cost,
          ),
        settings,
      ),
  );
  server.registerTool(
    "scrape_batch",
    {
      description:
        "Read up to three public web pages in order as main-content Markdown with links. Set content_mode to full for Scrapfly whole-page Markdown. " +
        fileLimits,
      inputSchema: toolInput({
        urls: z.array(urlInput).min(1).max(3),
        content_mode: contentModeInput,
        start_rung: startRung,
        fresh: freshInput,
        allow_higher_cost: allowHigherCostInput,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ urls, content_mode, start_rung, fresh, allow_higher_cost }) =>
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
                content_mode,
                start_rung,
                fresh,
                allow_higher_cost,
              ),
            (url) =>
              URL.canParse(url)
                ? new URL(url).hostname.replace(/\.$/, "")
                : undefined,
            { tool: "scrape_batch", attempt, settings },
          ),
        settings,
      ),
  );
}
