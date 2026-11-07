import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ScrapeProvider } from "../providers/types.js";
import { validatePublicUrl } from "../server/target.js";
import type { OutputFiles } from "./output-files.js";
import { pageContent } from "./page-content.js";
import { batch, fallback, toolResult, type Attempt } from "./shared.js";

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
  ) {
    const target = await validatePublicUrl(url);
    const markdown = await fallback(
      providers,
      async (provider) =>
        pageContent(await provider.scrape(target.href, signal)),
      attempt,
      signal,
    );
    signal.throwIfAborted();
    return files.spill(markdown, limit) ?? { markdown };
  }

  server.registerTool(
    "scrape",
    {
      description:
        "Read a public web page as Markdown. Large results are saved to a local file.",
      inputSchema: z.object({ url: urlInput }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ url }) =>
      toolResult("scrape", (attempt, signal) =>
        scrape(url, 48_000, attempt, signal),
      ),
  );
  server.registerTool(
    "scrape_batch",
    {
      description: "Read up to three public web pages in order.",
      inputSchema: z.object({ urls: z.array(urlInput).min(1).max(3) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ urls }) =>
      toolResult("scrape_batch", (attempt, signal) =>
        batch(urls, (url) => scrape(url, 20_000, attempt, signal)),
      ),
  );
}
