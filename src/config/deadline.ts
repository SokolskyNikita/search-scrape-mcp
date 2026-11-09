import type { Tuning } from "./tuning.js";

export const toolTimeoutMs = (settings: Tuning) =>
  settings.toolDeadlineSeconds * 1_000;
export const relayTimeoutMs = (settings: Tuning) =>
  toolTimeoutMs(settings) + 3_000;

// Leave time for validation, serialization, or starting a fallback.
export const scrapeReserveMs = 3_000;

export const scrapeBudgetMs = (settings: Tuning) =>
  toolTimeoutMs(settings) - scrapeReserveMs;

// The provider requires 30 seconds for Unblocker and 15 seconds for
// the datacenter-only file preflight and download path.
export const scrapflyFileTimeoutMs = 15_000;
export const scrapflyTimeoutMs = {
  datacenter: 30_000,
  unblocker: 30_000,
  render: 30_000,
} as const;
