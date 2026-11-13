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
 * "evicted" (stored but pushed out by cacheMaxEntries or cacheMaxBytes), "not_stored" (looked up
 * before but the result was never stored, for example a failure or an oversized result).
 */
type MissReason = "new" | "expired" | "evicted" | "not_stored";

export class ResultCache<T> {
  private readonly entries = new Map<
    string,
    { value: T; cached_at: string; expires: number; bytes: number }
  >();
  private bytes = 0;
  private readonly history = new Map<string, "looked_up" | "evicted">();

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
      const reason: MissReason = entry
        ? "expired"
        : past === "evicted"
          ? "evicted"
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
      // An entry that had already expired would have missed anyway.
      if (this.entries.get(oldest)!.expires > performance.now())
        this.remember(keyHash(oldest), "evicted");
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

  private remember(hash: string, state: "looked_up" | "evicted") {
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
