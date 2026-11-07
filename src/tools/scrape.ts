import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  scrapeRungs,
  type ScrapeProvider,
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
const urlInput = z.string().trim().min(1).max(4_096);

export function registerScrape(
  server: McpServer,
  providers: readonly ScrapeProvider[],
  files: OutputFiles,
) {
  async function scrape(
    url: string,
    limit: number,
    attempt: Attempt,
    signal: AbortSignal,
    start?: ScrapeRung,
  ) {
    const tried: string[] = [];
    try {
      signal.throwIfAborted();
      const target = await validatePublicUrl(url);
      const { markdown, check, hint } = await fallback(
        providers,
        (provider) => provider.scrape(target.href, signal, { start, tried }),
        attempt,
        signal,
      );
      signal.throwIfAborted();
      return {
        ...(files.spill(markdown, limit) ?? { markdown }),
        check,
        tried,
        hint,
      };
    } catch (error) {
      const failure = signal.aborted
        ? new AppError("tool_timeout", "Scrape ran out of time.")
        : safeError(error);
      throw new AppError(failure.code, failure.message, {
        tried,
        hint: failure.details?.hint,
      });
    }
  }

  server.registerTool(
    "scrape",
    {
      description:
        "Read a public web page as Markdown. Large results are saved to a local file.",
      inputSchema: z.object({ url: urlInput, start_rung: startRung }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ url, start_rung }) =>
      toolResult("scrape", (attempt, signal) =>
        scrape(
          url,
          48_000,
          attempt,
          AbortSignal.any([signal, AbortSignal.timeout(48_000)]),
          start_rung,
        ),
      ),
  );
  server.registerTool(
    "scrape_batch",
    {
      description: "Read up to three public web pages in order.",
      inputSchema: z
        .object({
          urls: z.array(urlInput).min(1).max(3),
          start_rung: startRung,
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ urls, start_rung }) =>
      toolResult("scrape_batch", (attempt, signal) => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(48_000)]);
        return batch(
          urls,
          (url) => scrape(url, 20_000, attempt, deadline, start_rung),
          (url) =>
            URL.canParse(url)
              ? new URL(url).hostname.replace(/\.$/, "")
              : undefined,
        );
      }),
  );
}
