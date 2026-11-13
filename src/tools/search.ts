import { messages } from "../config/messages.js";
import { isIP } from "node:net";
import { urlRule, youtubeVideoId } from "../config/host-rules.js";
import { MAX_URL_CHARS } from "../config/safety-limits.js";
import { toolInput } from "./input.js";
import type { ResultCache } from "./result-cache.js";
import { defaults } from "../config/tuning.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  SearchHit,
  SearchInput,
  SearchProvider,
} from "../providers/types.js";
import { AppError } from "../server/error.js";
import {
  batch,
  cachedSearch,
  fallback,
  toolResult,
  type Attempt,
} from "./shared.js";

const query = z.string().trim().min(1).max(500);
const hostname =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function domain(field: "site" | "exclude_domains") {
  const error =
    field === "site" ? messages.input.domain : messages.input.excludeDomains;
  return z
    .string({ error })
    .trim()
    .max(MAX_URL_CHARS, { error })
    .transform((value) =>
      (URL.parse(value)?.hostname ?? value)
        .toLowerCase()
        .replace(/\.$/, "")
        .replace(/^www\./, ""),
    )
    .pipe(
      z
        .string()
        .refine(
          (value) =>
            value.length <= 253 && hostname.test(value) && !isIP(value),
          { error },
        ),
    )
    .describe(
      "A domain or URL. Only the hostname is used, without a leading www.",
    );
}

const locationHint =
  "Best-effort location hint. Include the place name in the query when it matters.";
const queryHint =
  "Provide exactly one of q or query. Use double quotes for phrases and uppercase OR for alternatives. These are best-effort provider operators.";
const fields = {
  query: query.optional().describe("Search text. An alternative to q."),
  q: query.optional().describe("Search text. Use q or query."),
  recency: z.enum(["day", "week", "month", "year"]).optional(),
  location: z.string().trim().min(1).max(256).optional().describe(locationHint),
  gl: z
    .string()
    .trim()
    .regex(/^[a-z]{2}$/i)
    .toLowerCase()
    .optional()
    .describe("Best-effort two-letter country hint."),
  hl: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)
    .optional(),
  page: z.number().int().min(1).max(10).optional(),
  autocorrect: z.boolean().optional(),
  tbs: z.string().trim().min(1).max(256).optional(),
  site: domain("site").optional(),
  exclude_domains: z.array(domain("exclude_domains")).max(5).optional(),
  fresh: z.boolean().optional().describe("Bypass the local cache."),
};
const input = toolInput({
  ...fields,
  limit: z.number().int().min(1).max(10).default(10),
});

function withAccessHints(hits: SearchHit[]) {
  return hits.map((hit) => {
    const url = URL.parse(hit.url);
    const hint = url && urlRule(url)?.searchHint;
    return hint ? { ...hit, accessHint: hint } : hit;
  });
}

function searchUrlKey(value: string) {
  const url = URL.parse(value);
  if (!url) return value;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || ["srsltid", "fbclid", "gclid"].includes(key))
      url.searchParams.delete(key);
  }
  const id = youtubeVideoId(url);
  return id ? `youtube:${id}` : url.href;
}

type BatchHit = SearchHit & {
  also_found_in?: { query_index: number; rank: number }[];
};

function deduplicateBatch<T extends { index: number; result?: SearchHit[] }>(
  items: T[],
) {
  const seen = new Map<string, { queryIndex: number; hit: BatchHit }>();
  return items.map((item) => {
    if (!item.result) return item;
    const queryIndex = item.index + 1;
    const result: BatchHit[] = [];
    for (const [index, hit] of item.result.entries()) {
      const key = searchUrlKey(hit.url);
      const first = seen.get(key);
      if (first) {
        if (first.queryIndex !== queryIndex)
          (first.hit.also_found_in ??= []).push({
            query_index: queryIndex,
            rank: index + 1,
          });
      } else {
        const copy = { ...hit };
        seen.set(key, { queryIndex, hit: copy });
        result.push(copy);
      }
    }
    const removed = item.result.length - result.length;
    return {
      ...item,
      result,
      ...(removed ? { duplicates_removed: removed } : {}),
    };
  });
}

export function registerSearch(
  server: McpServer,
  providers: SearchProvider[],
  settings = defaults,
  cache?: ResultCache<SearchHit[]>,
) {
  async function search(
    { query, q, fresh, ...options }: z.infer<typeof input>,
    attempt: Attempt,
    signal: AbortSignal,
    deadline: number,
  ) {
    if ((query === undefined) === (q === undefined)) {
      throw new AppError("input", messages.input.query);
    }
    if (options.recency && options.tbs) {
      throw new AppError("input", messages.input.timeFilter);
    }
    const args: SearchInput = { query: (query ?? q)!, ...options };
    const key = JSON.stringify({
      ...args,
      gl: args.gl ?? settings.searchGl,
      hl: args.hl ?? settings.searchHl,
      exclude_domains: args.exclude_domains ?? [],
    });
    const hit = cache?.get(key, fresh);
    if (hit) return cachedSearch(withAccessHints(hit.value), hit.cached_at);
    const result = await fallback(
      providers,
      (provider) =>
        provider.search(args, signal, () => attempt(provider.name), deadline),
      attempt,
      signal,
    );
    signal.throwIfAborted();
    if (result.length) cache?.set(key, result);
    return withAccessHints(result);
  }
  server.registerTool(
    "search",
    {
      description: `Find web sources when you do not have a URL. ${queryHint}`,
      inputSchema: input,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args, extra) =>
      toolResult(
        "search",
        (attempt, signal, deadline) => search(args, attempt, signal, deadline),
        settings,
        {
          signal: extra.signal,
          presentation: {
            operation: messages.operation.search,
            service: "search",
            target: () => args.q ?? args.query,
            page: args.page ?? 1,
          },
        },
      ),
  );
  server.registerTool(
    "search_batch",
    {
      description: `Search up to five queries in order. For each search: ${queryHint}`,
      inputSchema: toolInput({
        searches: z.array(input).min(1).max(5),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ searches }, extra) =>
      toolResult(
        "search_batch",
        async (attempt, signal, deadline) =>
          deduplicateBatch(
            await batch(
              searches,
              (args, itemAttempt) =>
                search(args, itemAttempt, signal, deadline),
              (args) => args.site,
              { tool: "search_batch", attempt, settings },
              signal,
            ),
          ),
        settings,
        {
          partialOnTimeout: true,
          signal: extra.signal,
          presentation: {
            operation: messages.operation.search,
            service: "search",
            targets: searches.map(({ q, query }) => q ?? query),
            pages: searches.map(({ page }) => page ?? 1),
          },
        },
      ),
  );
}
