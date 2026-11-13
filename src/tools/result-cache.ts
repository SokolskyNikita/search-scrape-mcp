import { createHmac, randomBytes } from "node:crypto";
import type { Tuning } from "../config/tuning.js";
import { writeLimitEvent } from "../server/stats.js";

/** Keyed per process, so logged hashes match within one server run but don't reveal the URL or query. */
const hashSecret = randomBytes(32);
const keyHash = (key: string) =>
  createHmac("sha256", hashSecret).update(key).digest("hex").slice(0, 16);

/** Lookups remembered per cache to explain later misses. */
const historyLimit = 10_000;

/**
 * Why a lookup missed: "new" (first lookup this run), "expired" (stored but older than cacheTtlMs),
 * "evicted" (pushed out by cacheMaxEntries or cacheMaxBytes before it would have expired), "not_stored" (looked up
 * before but the result was never stored, for example a failure or an oversized result).
 */
type MissReason = "new" | "expired" | "evicted" | "not_stored";

/** A key looked up before, or evicted while still fresh with the time it would have expired. */
type Past = "looked_up" | { evictedUntil: number };

export class ResultCache<T> {
  private readonly entries = new Map<
    string,
    { value: T; cached_at: string; expires: number; bytes: number }
  >();
  private bytes = 0;
  private readonly history = new Map<string, Past>();

  constructor(private readonly settings: Tuning) {}

  get(key: string, fresh?: boolean) {
    if (!this.settings.cacheTtlMs) return;
    const hash = keyHash(key);
    if (fresh) {
      writeLimitEvent(
        { code: "cache", outcome: "bypass", keyHash: hash },
        this.settings,
      );
      return;
    }
    const entry = this.entries.get(key);
    const now = performance.now();
    if (!entry || entry.expires <= now) {
      const past = this.history.get(hash);
      // An evicted entry that would have expired by now missed because of its age, not the eviction.
      const reason: MissReason = entry
        ? "expired"
        : typeof past === "object"
          ? now < past.evictedUntil
            ? "evicted"
            : "expired"
          : past
            ? "not_stored"
            : "new";
      this.remove(key);
      this.remember(hash, "looked_up");
      writeLimitEvent(
        { code: "cache", outcome: "miss", keyHash: hash, reason },
        this.settings,
      );
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    writeLimitEvent(
      {
        code: "cache",
        outcome: "hit",
        keyHash: hash,
        ageMs: Math.round(now - (entry.expires - this.settings.cacheTtlMs)),
      },
      this.settings,
    );
    return { value: entry.value, cached_at: entry.cached_at };
  }

  set(key: string, value: T) {
    if (!this.settings.cacheTtlMs) return;
    const bytes =
      Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.settings.cacheMaxBytes) return;
    this.remove(key);
    while (
      this.entries.size >= this.settings.cacheMaxEntries ||
      this.bytes + bytes > this.settings.cacheMaxBytes
    ) {
      const oldest = this.entries.keys().next().value!;
      const { expires } = this.entries.get(oldest)!;
      this.remember(keyHash(oldest), { evictedUntil: expires });
      this.remove(oldest);
    }
    this.entries.set(key, {
      value,
      cached_at: new Date().toISOString(),
      bytes,
      expires: performance.now() + this.settings.cacheTtlMs,
    });
    this.bytes += bytes;
  }

  private remember(hash: string, state: Past) {
    this.history.delete(hash);
    this.history.set(hash, state);
    if (this.history.size > historyLimit)
      this.history.delete(this.history.keys().next().value!);
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}
