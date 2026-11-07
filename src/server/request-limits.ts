import { setTimeout as delay } from "node:timers/promises";
import type { Tuning } from "../config/tuning.js";
import { AppError } from "./error.js";
import { writeLimitEvent } from "./stats.js";

type LimitCode = "local_site_limit" | "local_rate_limit";
type Provider = "serper" | "scrapfly";
type Site = { active: number; next: number; cleanup?: NodeJS.Timeout };

export class RequestLimits {
  private readonly next = { serper: 0, scrapfly: 0 };
  private readonly sites = new Map<string, Site>();

  constructor(private readonly settings: Tuning) {}

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
    const events = new Set<string>();
    let lastCode: LimitCode = "local_rate_limit";
    for (;;) {
      signal.throwIfAborted();
      const now = performance.now();
      const site = host ? this.sites.get(host) : undefined;
      const providerWait = provider ? this.next[provider] - now : 0;
      const siteWait = Math.max(
        site ? site.next - now : 0,
        site && site.active >= this.settings.siteConcurrency ? 100 : 0,
      );
      const wait = Math.ceil(Math.max(providerWait, siteWait));
      if (wait <= 0 && (now <= stop || events.size === 0)) {
        if (provider) {
          const rate =
            provider === "serper"
              ? this.settings.serperRequestsPerMinute
              : this.settings.scrapflyRequestsPerMinute;
          this.next[provider] = now + 60_000 / rate;
        }
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
