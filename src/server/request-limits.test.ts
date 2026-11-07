import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { scrapflyScrape } from "../providers/scrapfly-scrape.js";
import { serper } from "../providers/serper.js";
import { test } from "node:test";
import { defaults } from "../config/tuning.js";
import { RequestLimits } from "./request-limits.js";

test("a sustained flood drains each provider bucket and returns a retry time", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const limits = new RequestLimits(defaults);
  const signal = new AbortController().signal;
  await Promise.all([
    ...Array.from({ length: 20 }, () =>
      limits.acquire(signal, Infinity, "serper"),
    ),
    ...Array.from({ length: 10 }, () =>
      limits.acquire(signal, Infinity, "scrapfly"),
    ),
  ]);
  for (let second = 1; second <= 5; second++) {
    now = 2_000 * second;
    await limits.acquire(signal, Infinity, "scrapfly");
    await limits.acquire(signal, Infinity, "serper");
    await limits.acquire(signal, Infinity, "serper");
    for (const provider of ["serper", "scrapfly"] as const)
      await assert.rejects(
        limits.acquire(signal, performance.now() + 10, provider),
        {
          code: "local_rate_limit",
          message: /Retry at \d{4}-/,
        },
      );
  }
});

test("hostname concurrency is shared by the scrape provider and browser", async () => {
  const limits = new RequestLimits({
    ...defaults,
    siteGapMs: 0,
    siteConcurrency: 1,
    localLimitWaitMs: 0,
    scrapflyRequestsPerMinute: 6_000,
  });
  const signal = new AbortController().signal;
  const release = await limits.acquire(
    signal,
    Infinity,
    "scrapfly",
    "example.com.",
  );
  await assert.rejects(
    limits.acquire(signal, Infinity, undefined, "EXAMPLE.COM"),
    {
      code: "local_site_limit",
    },
  );
  (await limits.acquire(signal, Infinity, undefined, "other.example"))();
  release();
  (await limits.acquire(signal, Infinity, undefined, "example.com"))();
});

test("hostname gap applies after release and can wait for the next slot", async () => {
  const limits = new RequestLimits({ ...defaults, siteGapMs: 60 });
  const signal = new AbortController().signal;
  const start = performance.now();
  (await limits.acquire(signal, Infinity, undefined, "example.com"))();
  await assert.rejects(
    limits.acquire(signal, start + 10, undefined, "example.com"),
    {
      code: "local_site_limit",
    },
  );
  (await limits.acquire(signal, Infinity, undefined, "example.com"))();
  assert(performance.now() - start >= 60);
});

test("five parallel scrapes and ten parallel searches start under the defaults", async (t) => {
  let scrapes = 0;
  let searches = 0;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", async (endpoint: URL) => {
    const isScrape = endpoint.hostname === "api.scrapfly.io";
    if (isScrape) scrapes++;
    else searches++;
    if (scrapes + searches === 15) release();
    await started;
    return isScrape
      ? Response.json({
          result: {
            content: "# An article\n\nPublic content.",
            status_code: 200,
            success: true,
            url: endpoint.searchParams.get("url"),
          },
        })
      : Response.json({ organic: [] });
  });
  const limits = new RequestLimits(defaults);
  const scrape = scrapflyScrape("fixture", defaults, limits);
  const search = serper("fixture", defaults, limits);
  const signal = AbortSignal.timeout(1_000);
  await Promise.race([
    Promise.all([
      ...Array.from({ length: 5 }, (_, index) =>
        scrape.scrape(`https://8.8.8.${index + 1}/`, signal),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        search.search({ query: `query ${index}`, limit: 1 }, signal),
      ),
    ]),
    delay(500, undefined, { signal }).then(() =>
      assert.fail("All requests must start and finish in the initial burst"),
    ),
  ]).finally(release);
  assert.equal(scrapes, 5);
  assert.equal(searches, 10);
});
