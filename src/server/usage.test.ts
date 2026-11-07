import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaults } from "../config/tuning.js";
import {
  scrapflyBrowser,
  browserScraper,
} from "../providers/scrapfly-browser.js";
import { todayUsage, Usage, type BrowserLease } from "./usage.js";

test("browser preflight checks both caps before connecting, and usage survives a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "search-scrape-usage-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "usage.json");
  const settings = {
    ...defaults,
    browserDailyMinutes: 1,
    browserConcurrency: 1,
  };
  let now = Date.parse("2026-11-07T12:00:00Z");
  let opens = 0;
  const connect = async (lease: BrowserLease) => {
    opens++;
    return lease;
  };
  const usage = new Usage(settings, file, () => now);
  const first = await usage.open(connect);
  assert.equal(first.seconds, 60);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  now += 10_000;
  const restarted = new Usage(settings, file, () => now);
  assert.equal(todayUsage(file, now).browserSessionMinutes, 10 / 60);
  await assert.rejects(restarted.open(connect), {
    code: "local_browser_concurrency",
  });
  // Both production entry points must surface preflight errors without a socket.
  const provider = scrapflyBrowser("unused", settings, undefined, restarted);
  await assert.rejects(provider.open(), { code: "local_browser_concurrency" });
  await assert.rejects(browserScraper(provider).scrape("https://1.1.1.1/"), {
    code: "local_browser_concurrency",
  });
  assert.equal(opens, 1);
  now += 25_000;
  first.release();
  assert.equal(todayUsage(file, now).browserSessionMinutes, 35 / 60);
  await assert.rejects(restarted.open(connect), {
    code: "local_browser_daily_limit",
    message: /2026-11-08T00:00:00.000Z/,
  });
  await assert.rejects(provider.open(), { code: "local_browser_daily_limit" });
  assert.equal(opens, 1);

  restarted.record("serper", null, now);
  restarted.record("scrapfly", 17, now);
  assert.deepEqual(todayUsage(file, now), {
    dateUtc: "2026-11-07",
    browserSessionMinutes: 35 / 60,
    serperSearches: 1,
    scrapflyCredits: 17,
  });

  now = Date.parse("2026-11-08T00:00:00Z");
  assert.equal(todayUsage(file, now).browserSessionMinutes, 0);
  const second = await restarted.open(connect);
  assert.equal(second.seconds, 60);
  second.release();
});

test("browser usage splits at midnight and an unsettled lease expires conservatively", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "search-scrape-usage-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "usage.json");
  const settings = {
    ...defaults,
    browserSessionSeconds: 60,
    browserDailyMinutes: 1,
  };
  let now = Date.parse("2026-11-07T23:59:40Z");
  const usage = new Usage(settings, file, () => now);
  await usage.open(async (lease) => assert.equal(lease.seconds, 60));
  now += 70_000;
  const restarted = new Usage(settings, file, () => now);
  assert.equal(todayUsage(file, now).browserSessionMinutes, 40 / 60);
  await assert.rejects(
    restarted.open(async () => assert.fail("Must reject")),
    {
      code: "local_browser_daily_limit",
    },
  );
});
