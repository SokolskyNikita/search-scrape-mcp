import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaults } from "../config/tuning.js";
import { AppError } from "../server/error.js";
import type { ScrapeResult, SearchHit } from "../providers/types.js";
import { OutputFiles } from "./output-files.js";
import { ResultCache } from "./result-cache.js";
import { registerScrape } from "./scrape.js";
import { registerSearch } from "./search.js";

test("cache expires, evicts the oldest entry, and skips oversized entries", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const cache = new ResultCache<string>({
    ...defaults,
    cacheMaxEntries: 1,
    cacheMaxBytes: 10,
    cacheTtlMs: 100,
  });
  cache.set("a", "first");
  cache.set("b", "second");
  assert.equal(cache.get("a"), undefined);
  cache.set("c", "too many bytes");
  assert.equal(cache.get("c"), undefined);
  assert.equal(cache.get("b"), "second");
  now = 100;
  assert.equal(cache.get("b"), undefined);

  const bounded = new ResultCache<string>({ ...defaults, cacheMaxBytes: 10 });
  bounded.set("a", "first");
  bounded.set("b", "second");
  assert.equal(bounded.get("a"), undefined);
  assert.equal(bounded.get("b"), "second");
});

test("search and scrape cache hits cross sessions and batches, with fresh bypass and failure exclusion", async (t) => {
  const logger = t.mock.method(console, "log", () => {});
  const searchCache = new ResultCache<SearchHit[]>(defaults);
  const scrapeCache = new ResultCache<ScrapeResult & { tried: string[] }>(
    defaults,
  );
  let searches = 0;
  let scrapes = 0;
  const searchProvider = {
    async search({ query }: { query: string }) {
      searches++;
      if (query === "fail")
        throw new AppError("provider_down", "Fixture error.");
      return [{ title: String(searches), url: "https://example.com" }];
    },
  };
  const scrapeProvider = {
    async scrape(url: string) {
      scrapes++;
      return url.endsWith("/challenge")
        ? {
            markdown: "Challenge",
            check: {
              code: "blocked",
              reason: "Fixture",
              warning: true as const,
            },
          }
        : {
            markdown: String(scrapes),
            check: { code: "ok", reason: "Fixture" },
          };
    },
  };
  async function session() {
    const mcp = new McpServer({ name: "cache-test", version: "1.0.0" });
    registerSearch(mcp, [searchProvider], defaults, searchCache);
    registerScrape(
      mcp,
      [scrapeProvider],
      new OutputFiles(defaults.outputDirectory),
      defaults,
      scrapeCache,
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
      await client.close();
      await mcp.close();
    });
    return async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert(Array.isArray(response.content));
      return response.content.map((item) => JSON.parse(item.text));
    };
  }

  const first = await session();
  const second = await session();
  await first("search", { q: "fixture", limit: 3 });
  const [batch] = await second("search_batch", {
    searches: [{ query: "fixture" }],
  });
  assert.equal(batch[0].cached, true);
  assert.equal(batch[0].result[0].title, "1");
  assert.deepEqual((await second("search", { q: "fixture", limit: 3 }))[1], {
    cached: true,
  });
  await second("search", { q: "fixture", limit: 3, fresh: true });
  const [hits] = await first("search", { q: "fixture", limit: 3 });
  assert.equal(hits[0].title, "2");
  await second("search", { q: "fixture", limit: 3, recency: "week" });
  // Batch errors have structured content and must never populate the cache.
  for (let i = 0; i < 2; i++) {
    const [failed] = await first("search_batch", { searches: [{ q: "fail" }] });
    assert.equal(failed[0].error.code, "provider_down");
  }
  assert.equal(searches, 5);

  const url = "https://1.1.1.1/page";
  await first("scrape", { url });
  const [scraped] = await second("scrape_batch", { urls: [url] });
  assert.equal(scraped[0].result.cached, true);
  await second("scrape", { url, fresh: true });
  const [updated] = await first("scrape", { url });
  assert.equal(updated.markdown, "2");
  await second("scrape", { url, start_rung: "render" });
  for (let i = 0; i < 2; i++) {
    const [challenge] = await first("scrape", {
      url: "https://1.1.1.1/challenge",
    });
    assert.equal(challenge.cached, undefined);
  }
  assert.equal(scrapes, 5);

  const logs = logger.mock.calls.map(({ arguments: [line] }) =>
    JSON.parse(String(line)),
  );
  assert(
    logs.some(
      (log) =>
        log.event === "local_limit" &&
        log.code === "cache" &&
        log.outcome === "hit" &&
        log.tool === "search_batch" &&
        log.itemIndex === 0,
    ),
  );
});
