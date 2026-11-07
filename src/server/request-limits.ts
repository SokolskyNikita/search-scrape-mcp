import { setTimeout as delay } from "node:timers/promises";
import type { Tuning } from "../config/tuning.js";
import { AppError } from "./error.js";
import { writeLimitEvent } from "./stats.js";

type LimitCode = "local_site_limit" | "local_rate_limit";
type Provider = "serper" | "scrapfly";
type Bucket = {
  capacity: number;
  refillPerMs: number;
  tokens: number;
  updated: number;
};
type Site = { active: number; next: number; cleanup?: NodeJS.Timeout };

export class RequestLimits {
  private readonly buckets: Record<Provider, Bucket>;
  private readonly sites = new Map<string, Site>();

  constructor(private readonly settings: Tuning) {
    const bucket = (capacity: number, requestsPerMinute: number): Bucket => ({
      capacity,
      refillPerMs: requestsPerMinute / 60_000,
      tokens: capacity,
      updated: performance.now(),
    });
    this.buckets = {
      serper: bucket(
        settings.serperBurstCapacity,
        settings.serperRequestsPerMinute,
      ),
      scrapfly: bucket(
        settings.scrapflyBurstCapacity,
        settings.scrapflyRequestsPerMinute,
      ),
    };
  }

  async acquire(
    signal: AbortSignal,
    deadline: number,
    provider?: Provider,
    hostname?: string,
  ): Promise<() => void> {
    const host = hostname?.toLowerCase().replace(/\.$/, "");
    const stop = Math.min(
      deadline,
      performance.now() + this.settings.localLimitWaitMs,
    );
    const bucket = provider ? this.buckets[provider] : undefined;
    const events = new Set<string>();
    let lastCode: LimitCode = "local_rate_limit";
    for (;;) {
      signal.throwIfAborted();
      const now = performance.now();
      const site = host ? this.sites.get(host) : undefined;
      let providerWait = 0;
      if (bucket) {
        bucket.tokens = Math.min(
          bucket.capacity,
          bucket.tokens + (now - bucket.updated) * bucket.refillPerMs,
        );
        bucket.updated = now;
        providerWait = Math.max(0, (1 - bucket.tokens) / bucket.refillPerMs);
      }
      const siteWait = Math.max(
        site ? site.next - now : 0,
        site && site.active >= this.settings.siteConcurrency ? 100 : 0,
      );
      const wait = Math.ceil(Math.max(providerWait, siteWait));
      if (wait <= 0 && (now <= stop || events.size === 0)) {
        if (bucket) bucket.tokens--;
        if (!host) return () => {};
        const entry = site ?? { active: 0, next: 0 };
        clearTimeout(entry.cleanup);
        this.sites.set(host, entry);
        entry.active++;
        entry.next = now + this.settings.siteGapMs;
        return () => {
          if (--entry.active === 0)
            entry.cleanup = setTimeout(
              () => this.sites.delete(host),
              Math.max(0, Math.ceil(entry.next - performance.now())),
            ).unref();
        };
      }

      const fail = now + wait > stop || now >= stop;
      const code: LimitCode =
        wait <= 0
          ? lastCode
          : siteWait > providerWait
            ? "local_site_limit"
            : "local_rate_limit";
      lastCode = code;
      const retryAt = new Date(Date.now() + Math.max(1, wait)).toISOString();
      for (const [eventCode, blocked] of [
        ["local_rate_limit", providerWait > 0],
        ["local_site_limit", siteWait > 0],
      ] as const) {
        if (
          (blocked || (fail && eventCode === code && wait <= 0)) &&
          (fail || !events.has(eventCode))
        ) {
          writeLimitEvent(
            {
              code: eventCode,
              outcome: fail ? "rejected" : "wait",
              provider,
              retryAt,
            },
            this.settings,
          );
          events.add(eventCode);
        }
      }
      if (fail) {
        const target = code === "local_site_limit" ? host : provider;
        throw new AppError(
          code,
          `Local request limit for ${target}. Retry at ${retryAt}.`,
          { retryAt },
        );
      }
      await delay(wait, undefined, { signal }).catch(() =>
        signal.throwIfAborted(),
      );
    }
  }
}
