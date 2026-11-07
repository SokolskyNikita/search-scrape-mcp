import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "../config/tuning.js";
import { RequestLimits } from "./request-limits.js";

test("provider rates are independent and deadline-limited", async () => {
  const limits = new RequestLimits(defaults);
  const signal = new AbortController().signal;
  await limits.acquire(signal, Infinity, "serper");
  await limits.acquire(signal, Infinity, "scrapfly");
  for (const provider of ["serper", "scrapfly"] as const) {
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
