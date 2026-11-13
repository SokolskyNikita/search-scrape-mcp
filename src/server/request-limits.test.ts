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
    ...Array.from({ length: 20 }, () =>
      limits.acquire(signal, Infinity, "scrapfly"),
    ),
  ]);
  for (let second = 1; second <= 5; second++) {
    now = 2_000 * second;
    await limits.acquire(signal, Infinity, "scrapfly");
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

test("scrape and search each pace starts and cap independently at five in flight", async (t) => {
  const settings = { ...defaults, providerGapMs: 20 };
  const starts = { scrapfly: [] as number[], serper: [] as number[] };
  let finish!: () => void;
  const hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  t.mock.method(globalThis, "fetch", async (endpoint: URL) => {
    const isScrape = endpoint.hostname === "api.scrapfly.io";
    starts[isScrape ? "scrapfly" : "serper"].push(performance.now());
    await hold;
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
  const limits = new RequestLimits(settings);
  const scrape = scrapflyScrape("fixture", settings, limits);
  const search = serper("fixture", settings, limits);
  const signal = AbortSignal.timeout(2_000);
  const work = Promise.all([
    ...Array.from({ length: 6 }, (_, index) =>
      scrape.scrape(`https://8.8.8.${index + 1}/`, signal),
    ),
    ...Array.from({ length: 6 }, (_, index) =>
      search.search({ query: `query ${index}`, limit: 1 }, signal),
    ),
  ]);
  try {
    await Promise.race([
      work,
      (async () => {
        while (starts.scrapfly.length < 5 || starts.serper.length < 5)
          await delay(10, undefined, { signal });
        await delay(60, undefined, { signal });
      })(),
    ]);
    assert.equal(starts.scrapfly.length, 5);
    assert.equal(starts.serper.length, 5);
  } finally {
    finish();
    await work;
  }
  for (const times of Object.values(starts)) {
    assert.equal(times.length, 6);
    assert(times.slice(1).every((time, index) => time - times[index]! >= 19));
  }
});

test("an expired queue wait never dispatches and shares the operation's admission budget", async () => {
  const limits = new RequestLimits({
    ...defaults,
    providerConcurrency: 1,
    providerGapMs: 1,
    localLimitWaitMs: 30,
  });
  const signal = new AbortController().signal;
  let finish!: () => void;
  const active = limits.run(
    "serper",
    signal,
    Infinity,
    limits.budget(),
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const budget = limits.budget();
  const never = async () => assert.fail("Expired work must not dispatch");
  try {
    await assert.rejects(
      limits.run("serper", signal, Infinity, budget, never),
      {
        code: "local_rate_limit",
      },
    );
    assert(budget.remainingMs < 2);
  } finally {
    finish();
    await active;
  }
  await limits.run("serper", signal, Infinity, limits.budget(), async () => {});
});
