import { setTimeout as delay } from "node:timers/promises";
import PQueue from "p-queue";
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
export type AdmissionBudget = { remainingMs: number };
type Site = { active: number; next: number; cleanup?: NodeJS.Timeout };

export class RequestLimits {
  private readonly buckets: Record<Provider, Bucket>;
  private readonly queues: Record<Provider, PQueue>;
  private readonly lastDispatch: Record<Provider, number> = {
    serper: -Infinity,
    scrapfly: -Infinity,
  };
  private readonly sites = new Map<string, Site>();

  constructor(private readonly settings: Tuning) {
    const queue = () =>
      new PQueue({
        concurrency: settings.providerConcurrency,
        intervalCap: 1,
        interval: settings.providerGapMs,
        strict: true,
      });
    this.queues = { serper: queue(), scrapfly: queue() };
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

  acquire(
    signal: AbortSignal,
    deadline: number,
    provider?: Provider,
    hostname?: string,
  ): Promise<() => void> {
    return this.admit(
      signal,
      deadline,
      provider,
      hostname,
      this.budget(),
      (release) => release,
    );
  }

  budget(): AdmissionBudget {
    return { remainingMs: this.settings.localLimitWaitMs };
  }

  run<T>(
    provider: Provider,
    signal: AbortSignal,
    deadline: number,
    budget: AdmissionBudget,
    task: () => Promise<T>,
    hostname?: string,
    beforeDispatch?: () => void,
  ): Promise<T> {
    return this.admit(
      signal,
      deadline,
      provider,
      hostname,
      budget,
      async (release) => {
        try {
          return await task();
        } finally {
          release();
        }
      },
      this.queues[provider],
      beforeDispatch,
    );
  }

  private async admit<T>(
    signal: AbortSignal,
    deadline: number,
    provider: Provider | undefined,
    hostname: string | undefined,
    budget: AdmissionBudget,
    dispatch: (release: () => void) => T | Promise<T>,
    queue?: PQueue,
    beforeDispatch?: () => void,
  ): Promise<T> {
    const host = hostname?.toLowerCase().replace(/\.$/, "");
    const start = performance.now();
    const stop = Math.min(deadline, start + budget.remainingMs);
    const bucket = provider ? this.buckets[provider] : undefined;
    const events = new Set<string>();
    let lastCode: LimitCode = "local_rate_limit";
    let charged = false;
    const chargeWait = () => {
      if (charged) return;
      charged = true;
      budget.remainingMs = Math.max(
        0,
        budget.remainingMs - (performance.now() - start),
      );
    };

    const eligibility = (now: number) => {
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
      // Check actual admissions as well as the queue’s callback start times.
      if (queue && provider)
        providerWait = Math.max(
          providerWait,
          this.lastDispatch[provider] + this.settings.providerGapMs - now,
        );
      const siteWait = Math.max(
        site ? site.next - now : 0,
        site && site.active >= this.settings.siteConcurrency ? 100 : 0,
      );
      return { site, providerWait, siteWait };
    };

    const take = () => {
      const now = performance.now();
      const { site, providerWait, siteWait } = eligibility(now);
      if (providerWait > 0 || siteWait > 0) return undefined;
      beforeDispatch?.();
      chargeWait();
      const dispatchedAt = performance.now();
      if (queue && provider) this.lastDispatch[provider] = dispatchedAt;
      if (bucket) bucket.tokens--;
      if (!host) return () => {};
      const entry = site ?? { active: 0, next: 0 };
      clearTimeout(entry.cleanup);
      this.sites.set(host, entry);
      entry.active++;
      entry.next = dispatchedAt + this.settings.siteGapMs;
      return () => {
        if (--entry.active === 0)
          entry.cleanup = setTimeout(
            () => this.sites.delete(host),
            Math.max(0, Math.ceil(entry.next - performance.now())),
          ).unref();
      };
    };

    let immediate = true;
    try {
      for (;;) {
        signal.throwIfAborted();
        const now = performance.now();
        const { providerWait, siteWait } = eligibility(now);
        const wait = Math.ceil(Math.max(providerWait, siteWait));
        if (wait <= 0 && now <= deadline && (now <= stop || immediate)) {
          if (!queue) {
            const release = take();
            if (release) return await dispatch(release);
          } else {
            const admission = new AbortController();
            const abort = () => admission.abort(signal.reason);
            const queueWaitError = () =>
              new AppError(
                "local_rate_limit",
                `Local request queue wait expired for ${provider}.`,
              );
            const expire = () => admission.abort(queueWaitError());
            signal.addEventListener("abort", abort, { once: true });
            const timer = setTimeout(
              expire,
              Math.max(0, Math.ceil(stop - now)),
            );
            let started = false;
            let queuedAsynchronously = false;
            const cleanup = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", abort);
            };
            try {
              const queued = queue.add(
                async () => {
                  started = true;
                  cleanup();
                  signal.throwIfAborted();
                  if (performance.now() > deadline)
                    throw new AppError(
                      "local_rate_limit",
                      `Too little time remains to dispatch ${provider}.`,
                    );
                  if (queuedAsynchronously && performance.now() > stop)
                    throw queueWaitError();
                  const release = take();
                  return release
                    ? { value: await dispatch(release) }
                    : undefined;
                },
                { signal: admission.signal },
              );
              queuedAsynchronously = !started;
              if (queuedAsynchronously && now >= stop) expire();
              const result = await queued;
              if (result) return result.value;
              // A different caller took the permit while this task was queued.
              immediate = false;
              continue;
            } finally {
              cleanup();
            }
          }
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
        immediate = false;
        await delay(wait, undefined, { signal }).catch(() =>
          signal.throwIfAborted(),
        );
      }
    } finally {
      chargeWait();
    }
  }
}
