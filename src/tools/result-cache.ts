import type { Tuning } from "../config/tuning.js";
import { writeLimitEvent } from "../server/stats.js";

export class ResultCache<T> {
  private readonly entries = new Map<
    string,
    { value: T; expires: number; bytes: number }
  >();
  private bytes = 0;

  constructor(private readonly settings: Tuning) {}

  get(key: string, fresh?: boolean): T | undefined {
    if (!this.settings.cacheTtlMs) return;
    if (fresh) {
      writeLimitEvent({ code: "cache", outcome: "bypass" }, this.settings);
      return;
    }
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= performance.now()) {
      this.remove(key);
      writeLimitEvent({ code: "cache", outcome: "miss" }, this.settings);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    writeLimitEvent({ code: "cache", outcome: "hit" }, this.settings);
    return entry.value;
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
    )
      this.remove(this.entries.keys().next().value!);
    this.entries.set(key, {
      value,
      bytes,
      expires: performance.now() + this.settings.cacheTtlMs,
    });
    this.bytes += bytes;
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}
