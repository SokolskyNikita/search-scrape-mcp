import { hostRule } from "../config/host-rules.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/server";
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
  assert.equal(cache.get("b")?.value, "second");
  now = 100;
  assert.equal(cache.get("b"), undefined);

  const bounded = new ResultCache<string>({ ...defaults, cacheMaxBytes: 10 });
  bounded.set("a", "first");
  bounded.set("b", "second");
  assert.equal(bounded.get("a"), undefined);
  assert.equal(bounded.get("b")?.value, "second");
});

test("cache log events carry a key hash and say why a lookup missed", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const logger = t.mock.method(console, "log", () => {});
  const cache = new ResultCache<string>({
    ...defaults,
    cacheMaxEntries: 1,
    cacheTtlMs: 100,
  });
  cache.get("https://example.com/a");
  cache.set("https://example.com/a", "first");
  cache.set("https://example.com/b", "second");
  cache.get("https://example.com/a");
  cache.get("https://example.com/a");
  now = 50;
  cache.get("https://example.com/b");
  now = 200;
  cache.get("https://example.com/b");
  cache.set("https://example.com/c", "third");
  cache.get("https://example.com/b", true);
  // Evicted while fresh, but looked up after it would have expired.
  cache.set("https://example.com/d", "fourth");
  now = 400;
  cache.get("https://example.com/c");
  const events = logger.mock.calls.map(({ arguments: [line] }) =>
    JSON.parse(String(line)),
  );
  assert.deepEqual(
    events.map(({ outcome, reason, ageMs }) => ({ outcome, reason, ageMs })),
    [
      { outcome: "miss", reason: "new", ageMs: undefined },
      { outcome: "miss", reason: "evicted", ageMs: undefined },
      { outcome: "miss", reason: "not_stored", ageMs: undefined },
      { outcome: "hit", reason: undefined, ageMs: 50 },
      { outcome: "miss", reason: "expired", ageMs: undefined },
      { outcome: "bypass", reason: undefined, ageMs: undefined },
      { outcome: "miss", reason: "expired", ageMs: undefined },
    ],
  );
  const [a, , , b] = events.map((event) => event.keyHash);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(events[1].keyHash, a);
  assert.notEqual(b, a);
  assert.equal(events[4].keyHash, b);
  assert(!JSON.stringify(events).includes("example.com"));
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
    async search({ query, site }: { query: string; site?: string }) {
      searches++;
      if (query === "fail")
        throw new AppError("provider_down", "Fixture error.");
      if (query === "github fixture") {
        assert.equal(site, "github.com");
        return [
          { title: "Fixture repo", url: "https://github.com/owner/repo" },
          {
            title: "Raw file",
            url: "https://RAW.GitHubUserContent.com./owner/repo/main/file",
          },
          {
            title: "Lookalike",
            url: "https://github.com.example.com/owner/repo",
          },
          { title: "Other", url: "https://example.com/github.com" },
          {
            title: "Reddit thread",
            url: "https://old.reddit.com/r/example/comments/abc/thread/",
          },
          { title: "Reddit short link", url: "https://redd.it/abc" },
        ];
      }
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
      const data = response.structuredContent as Record<string, unknown>;
      return [
        data.items ?? data.results ?? data,
        data.cached ? { cached: true, cached_at: data.cached_at } : undefined,
        (response.content as { text: string }[])
          .map((block) => block.text)
          .join("\n"),
      ] as ReturnType<typeof JSON.parse>;
    };
  }

  const first = await session();
  const second = await session();
  await first("search", { q: "fixture", limit: 10 });
  const [batch] = await second("search_batch", {
    searches: [{ query: "fixture" }],
  });
  assert.equal(batch[0].cached, true);
  assert.equal(batch[0].result[0].title, "1");
  assert.match(batch[0].cached_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual((await second("search", { q: "fixture", limit: 10 }))[1], {
    cached: true,
    cached_at: batch[0].cached_at,
  });
  await second("search", { q: "fixture", limit: 10, fresh: true });
  const [hits] = await first("search", { q: "fixture", limit: 10 });
  assert.equal(hits[0].title, "2");
  await second("search", { q: "fixture", limit: 10, recency: "week" });
  // Batch errors have structured content and must never populate the cache.
  for (let i = 0; i < 2; i++) {
    const [failed] = await first("search_batch", { searches: [{ q: "fail" }] });
    assert.equal(failed[0].error.code, "provider_down");
  }
  assert.equal(searches, 5);
  const githubArgs = { query: "github fixture", site: "github.com", page: 2 };
  const [github, , rendered] = await first("search", githubArgs);
  const hint = hostRule("github.com")!.searchHint;
  const redditHint = hostRule("reddit.com")!.searchHint;
  assert.equal(github[0].url, "https://github.com/owner/repo");
  assert.deepEqual(
    github.map((hit: { accessHint?: string }) => hit.accessHint),
    [hint, hint, undefined, undefined, redditHint, redditHint],
  );
  assert(rendered.includes(JSON.stringify(github)));
  const [githubBatch, , renderedBatch] = await second("search_batch", {
    searches: [githubArgs, { ...githubArgs, page: 3 }],
  });
  assert.equal(githubBatch[0].cached, true);
  assert.deepEqual(
    githubBatch.map((item: { page: number }) => item.page),
    [2, 3],
  );
  const deduped = github.map((hit: object, index: number) => ({
    ...hit,
    also_found_in: [{ query_index: 2, rank: index + 1 }],
  }));
  assert.deepEqual(githubBatch[0].result, deduped);
  assert.deepEqual(githubBatch[1].result, []);
  assert.equal(githubBatch[1].duplicates_removed, github.length);
  assert(renderedBatch.includes(JSON.stringify(deduped)));
  assert(renderedBatch.includes("Duplicate search hits removed: 6."));
  const [unchanged] = await first("search", githubArgs);
  assert.deepEqual(unchanged, github);
  assert.equal(searches, 7);

  const url = "https://1.1.1.1/page";
  await first("scrape", { url });
  const [scraped] = await second("scrape_batch", { urls: [url] });
  assert.equal(scraped[0].result.cached, true);
  assert.match(scraped[0].result.cached_at, /^\d{4}-\d{2}-\d{2}T/);
  const [singleScrape] = await first("scrape", { url });
  assert.equal(singleScrape.cached_at, scraped[0].result.cached_at);
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
