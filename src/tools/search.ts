import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SearchInput, SearchProvider } from "../providers/types.js";
import { batch, fallback, toolResult } from "./shared.js";

const input = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export function registerSearch(server: McpServer, providers: SearchProvider[]) {
  const search = (args: SearchInput) =>
    fallback(providers, (provider) => provider.search(args));
  server.registerTool(
    "search",
    {
      description: "Search the web for links and snippets.",
      inputSchema: input,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => search(args)),
  );
  server.registerTool(
    "search_batch",
    {
      description: "Search up to three queries in order.",
      inputSchema: z
        .object({
          searches: z
            .array(
              input.extend({
                limit: z.number().int().min(1).max(5).default(3),
              }),
            )
            .min(1)
            .max(3),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ searches }) => toolResult(() => batch(searches, search)),
  );
}
