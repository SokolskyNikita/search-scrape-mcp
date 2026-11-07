import type { Tuning } from "./tuning.js";

export const toolTimeoutMs = (settings: Tuning) =>
  settings.toolDeadlineSeconds * 1_000;
export const relayTimeoutMs = (settings: Tuning) =>
  toolTimeoutMs(settings) + 3_000;

// Leave time for validation, serialization, or starting a fallback.
export const scrapeReserveMs = 3_000;

export const scrapeBudgetMs = (settings: Tuning) =>
  toolTimeoutMs(settings) - scrapeReserveMs;

// Scrapfly rejects shorter timeouts. Use the minimum for both the API and HTTP
// client so a datacenter attempt and one advanced attempt fit in the default budget.
// https://scrapfly.io/docs/scrape-api/understand-timeout
export const scrapflyTimeoutMs = {
  datacenter: 15_000,
  unblocker: 30_000,
  render: 30_000,
} as const;
