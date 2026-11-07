import { defaults } from "../config/tuning.js";
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
    location: z.string().trim().min(1).max(256).optional(),
    gl: z
      .string()
      .trim()
      .regex(/^[a-z]{2}$/i)
      .toLowerCase()
      .optional(),
    hl: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)
      .optional(),
    page: z.number().int().min(1).max(10).optional(),
    autocorrect: z.boolean().optional(),
    tbs: z.string().trim().min(1).max(256).optional(),
    site: domain.optional(),
    exclude_domains: z.array(domain).max(5).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export function registerSearch(
  server: McpServer,
  providers: SearchProvider[],
  settings = defaults,
) {
  async function search(
    { query, q, ...options }: z.infer<typeof input>,
    attempt: Attempt,
    signal: AbortSignal,
    deadline: number,
  ) {
    if ((query === undefined) === (q === undefined)) {
      throw new AppError("input", "Provide exactly one of query or q.");
    }
    if (options.recency && options.tbs) {
      throw new AppError("input", "Provide either recency or tbs.");
    }
    const args: SearchInput = { query: (query ?? q)!, ...options };
    return fallback(
      providers,
      (provider) =>
        provider.search(args, signal, () => attempt(provider.name), deadline),
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
      toolResult(
        "search",
        (attempt, signal, deadline) => search(args, attempt, signal, deadline),
        settings,
      ),
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
      toolResult(
        "search_batch",
        (attempt, signal, deadline) =>
          batch(
            searches,
            (args, itemAttempt) => search(args, itemAttempt, signal, deadline),
            (args) => args.site,
            { tool: "search_batch", attempt, settings },
          ),
        settings,
      ),
  );
}
