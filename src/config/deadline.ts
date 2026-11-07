import type { Tuning } from "./tuning.js";

export const toolTimeoutMs = (settings: Tuning) =>
  settings.toolDeadlineSeconds * 1_000;
export const relayTimeoutMs = (settings: Tuning) =>
  toolTimeoutMs(settings) + 3_000;

// Leave time for validation, serialization, or starting a fallback.
export const scrapeReserveMs = 3_000;
