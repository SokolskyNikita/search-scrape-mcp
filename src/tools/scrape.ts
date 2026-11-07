import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ScrapeProvider } from "../providers/types.js";
import { validatePublicUrl } from "../server/target.js";
import { pageContent } from "./page-content.js";
import { batch, fallback, toolResult } from "./shared.js";

const urlInput = z.string().trim().min(1).max(4_096);

export function registerScrape(
  server: McpServer,
  providers: readonly ScrapeProvider[],
) {
  async function scrape(url: string, limit: number) {
    const target = await validatePublicUrl(url);
    return fallback(providers, async (provider) =>
      pageContent(await provider.scrape(target.href), { limit }),
    );
  }

  server.registerTool(
    "scrape",
    {
      description: "Read a public web page as markdown or plain text.",
      inputSchema: z.object({ url: urlInput }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ url }) => toolResult(() => scrape(url, 12_000)),
  );
  server.registerTool(
    "scrape_batch",
    {
      description: "Read up to three public web pages in order.",
      inputSchema: z.object({ urls: z.array(urlInput).min(1).max(3) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ urls }) => toolResult(() => batch(urls, (url) => scrape(url, 4_000))),
  );
}
