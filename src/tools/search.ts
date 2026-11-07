import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SearchInput, SearchProvider } from "../providers/types.js";
import { AppError } from "../server/error.js";
import { batch, fallback, toolResult, type Attempt } from "./shared.js";

const query = z.string().trim().min(1).max(500);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
const input = z
  .object({
    query: query.optional(),
    q: query.optional().describe("Alias for query."),
    recency: z.enum(["day", "week", "month", "year"]).optional(),
    site: domain.optional(),
    exclude_domains: z.array(domain).max(5).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export function registerSearch(server: McpServer, providers: SearchProvider[]) {
  async function search(
    { query, q, ...options }: z.infer<typeof input>,
    attempt: Attempt,
    signal: AbortSignal,
  ) {
    if ((query === undefined) === (q === undefined)) {
      throw new AppError("input", "Provide exactly one of query or q.");
    }
    const args: SearchInput = { query: (query ?? q)!, ...options };
    return fallback(
      providers,
      (provider) => provider.search(args, signal, () => attempt(provider.name)),
      attempt,
      signal,
    );
  }
  server.registerTool(
    "search",
    {
      description: "Find web sources when you do not have a URL.",
      inputSchema: input,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      toolResult("search", (attempt, signal) => search(args, attempt, signal)),
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
    ({ searches }) =>
      toolResult("search_batch", (attempt, signal) =>
        batch(
          searches,
          (args) => search(args, attempt, signal),
          (args) => args.site,
        ),
      ),
  );
}
