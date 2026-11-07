import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ScrapeProvider } from "../providers/types.js";
import { validatePublicUrl } from "../server/target.js";
import { PageCache } from "./page-cache.js";
import { pageContent } from "./page-content.js";
import { batch, fallback, toolResult } from "./shared.js";

const urlInput = z.string().trim().min(1).max(4_096);

export function registerScrape(
  server: McpServer,
  providers: readonly ScrapeProvider[],
  cache = new PageCache(),
) {
  async function scrape(url: string, limit: number, attempt: () => void) {
    const target = await validatePublicUrl(url);
    const markdown = await fallback(
      providers,
      async (provider) =>
        pageContent(await provider.scrape(target.href), { limit: Infinity }),
      attempt,
    );
    return cache.read(cache.put(markdown), 0, limit);
  }

  server.registerTool(
    "scrape",
    {
      description: "Read a public web page as markdown or plain text.",
      inputSchema: z.object({ url: urlInput }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ url }) =>
      toolResult("scrape", (attempt) => scrape(url, 48_000, attempt)),
  );
  server.registerTool(
    "scrape_batch",
    {
      description: "Read up to three public web pages in order.",
      inputSchema: z.object({ urls: z.array(urlInput).min(1).max(3) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ urls }) =>
      toolResult("scrape_batch", (attempt) =>
        batch(urls, (url) => scrape(url, 20_000, attempt)),
      ),
  );
  server.registerTool(
    "scrape_more",
    {
      description:
        "Read the next chunk of a cached scrape without fetching again.",
      inputSchema: z
        .object({ pageId: z.uuid(), offset: z.number().int().min(0) })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ pageId, offset }) =>
      toolResult("scrape_more", async () => cache.read(pageId, offset, 48_000)),
  );
}
