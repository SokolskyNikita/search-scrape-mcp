import { toolInput } from "./input.js";
import type { ResultCache } from "./result-cache.js";
import { defaults } from "../config/tuning.js";
import { MAX_URL_CHARS } from "../config/safety-limits.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  scrapeRungs,
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
const freshInput = z.boolean().optional().describe("Bypass the local cache.");
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
    start?: ScrapeRung,
    fresh?: boolean,
  ) {
    const tried: string[] = [];
    try {
      signal.throwIfAborted();
      const target = await validatePublicUrl(url);
      const key = JSON.stringify([target.href, start ?? "datacenter"]);
      const hit = cache?.get(key, fresh);
      const { markdown, check, hint } =
        hit ??
        (await fallback(
          providers,
          (provider) =>
            provider.scrape(target.href, signal, { start, tried, deadline }),
          attempt,
          signal,
        ));
      signal.throwIfAborted();
      if (!hit && check.code === "ok" && !check.warning && !check.next && !hint)
        cache?.set(key, { markdown, check, tried });
      return {
        ...(files.spill(markdown, limit) ?? { markdown }),
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
        "Read a public web page as Markdown. Large results are saved to a local file.",
      inputSchema: toolInput({
        url: urlInput,
        start_rung: startRung,
        fresh: freshInput,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ url, start_rung, fresh }) =>
      toolResult(
        "scrape",
        (attempt, signal, deadline) =>
          scrape(
            url,
            settings.scrapeInlineChars,
            attempt,
            signal,
            deadline,
            start_rung,
            fresh,
          ),
        settings,
      ),
  );
  server.registerTool(
    "scrape_batch",
    {
      description: "Read up to three public web pages in order.",
      inputSchema: toolInput({
        urls: z.array(urlInput).min(1).max(3),
        start_rung: startRung,
        fresh: freshInput,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ urls, start_rung, fresh }) =>
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
                start_rung,
                fresh,
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
