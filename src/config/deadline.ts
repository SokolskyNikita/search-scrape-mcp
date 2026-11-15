import type { Tuning } from "./tuning.js";

export const toolTimeoutMs = (settings: Tuning) =>
  settings.toolDeadlineSeconds * 1_000;
// The relay's host app has its own, shorter limit, so its calls get a shorter deadline.
export const relayDeadlineMs = (settings: Tuning) =>
  Math.min(settings.relayDeadlineSeconds * 1_000, toolTimeoutMs(settings));
export const relayTimeoutMs = (settings: Tuning) =>
  relayDeadlineMs(settings) + 3_000;
/** Header a client sends to ask for an answer within this many milliseconds. */
export const deadlineHeader = "x-search-scrape-deadline-ms";

// What a client should allow per tool call: the deadline plus time to receive the result.
export const clientTimeoutMs = (settings: Tuning) =>
  toolTimeoutMs(settings) + 30_000;

// Leave time for validation, serialization, or starting a fallback.
export const scrapeReserveMs = 3_000;

export const scrapeBudgetMs = (settings: Tuning) =>
  toolTimeoutMs(settings) - scrapeReserveMs;

// The provider requires 30 seconds for Unblocker and 15 seconds for
// the datacenter-only file preflight and download path.
export const scrapflyFileTimeoutMs = 15_000;
// With retry=false, Scrapfly's timeout covers only its own work. Its docs ask
// clients to wait 5 s longer so the response can arrive.
export const scrapflyResponseMarginMs = 5_000;
/** How long one Scrapfly attempt with this Scrapfly timeout may take locally. */
export const scrapflyRequestMs = (timeout: number) =>
  timeout + scrapflyResponseMarginMs;
export const scrapflyTimeoutMs = {
  datacenter: 30_000,
  render: 30_000,
  residential_render: 30_000,
} as const;
