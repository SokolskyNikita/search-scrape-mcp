import { setTimeout as delay } from "node:timers/promises";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Tuning } from "../config/tuning.js";
import { AppError } from "./error.js";
import { writeLimitEvent } from "./stats.js";

const dayMs = 86_400_000;
const dayStart = (ms: number) => Math.floor(ms / dayMs) * dayMs;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const overlap = (start: number, end: number, day: number) =>
  Math.max(0, Math.min(end, day + dayMs) - Math.max(start, day));
const count = z.number().nonnegative();
const stateSchema = z.object({
  days: z.record(
    z.string(),
    z.object({
      browserMs: count,
      scrapflyCredits: count,
      serperSearches: count,
    }),
  ),
  leases: z.record(
    z.string(),
    z.object({ start: count, end: count, runId: z.string().optional() }),
  ),
});
type State = z.infer<typeof stateSchema>;
const emptyDay = () => ({
  browserMs: 0,
  scrapflyCredits: 0,
  serperSearches: 0,
});

export const usageFile = () =>
  join(homedir(), ".local", "state", "search-scrape-mcp", "usage.json");

function readState(file: string): State {
  try {
    const fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.mode & 0o077 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error("Usage file is not private.");
      return stateSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { days: {}, leases: {} };
    throw new AppError("usage_state", "Could not read private usage state.");
  }
}

export function todayUsage(file = usageFile(), now = Date.now()) {
  const state = readState(file);
  const { browserMs, ...totals } = state.days[dayKey(now)] ?? emptyDay();
  const elapsed = Object.values(state.leases).reduce(
    (sum, { start, end }) =>
      sum + overlap(start, Math.min(now, end), dayStart(now)),
    browserMs,
  );
  return {
    dateUtc: dayKey(now),
    browserSessionMinutes: elapsed / 60_000,
    ...totals,
  };
}

export type BrowserLease = {
  seconds: number;
  signal: AbortSignal;
  release: () => void;
};

const processRunId = randomUUID();

export class Usage {
  constructor(
    private readonly settings: Tuning,
    private readonly file = usageFile(),
    private readonly now = Date.now,
    private readonly runId: string = processRunId,
  ) {
    const startup = this.now();
    const state = readState(this.file);
    const stale = Object.entries(state.leases).filter(
      ([, lease]) => lease.runId !== this.runId,
    );
    for (const [id] of stale) this.finish(state, id, startup);
    if (stale.length) this.save(state);
  }

  private save(state: State) {
    const tmp = this.file + "." + randomUUID();
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(state), {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      renameSync(tmp, this.file);
    } catch {
      throw new AppError(
        "usage_state",
        "Could not persist private usage state.",
      );
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        console.error("Could not clean up temporary usage state.");
      }
    }
  }

  private finish(state: State, id: string, now: number) {
    const lease = state.leases[id];
    if (!lease) return;
    const end = Math.min(now, lease.end);
    for (let day = dayStart(lease.start); day <= dayStart(end); day += dayMs) {
      const used = overlap(lease.start, end, day);
      if (used) (state.days[dayKey(day)] ??= emptyDay()).browserMs += used;
    }
    delete state.leases[id];
  }

  private current(now: number) {
    const state = readState(this.file);
    for (const [id, { end }] of Object.entries(state.leases))
      if (end <= now) this.finish(state, id, now);
    for (const day of Object.keys(state.days))
      if (day < dayKey(now - dayMs)) delete state.days[day];
    return state;
  }

  record(
    provider: "serper" | "scrapfly",
    credits: number | null,
    startedAt: number,
  ) {
    try {
      const amount = provider === "serper" ? 1 : credits;
      if (amount === null) return;
      const state = this.current(this.now());
      const today = (state.days[dayKey(startedAt)] ??= emptyDay());
      if (provider === "serper") today.serperSearches += amount;
      else today.scrapflyCredits += amount;
      this.save(state);
    } catch {
      console.error("Could not persist provider usage totals.");
    }
  }

  async open<T>(
    connect: (lease: BrowserLease) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const stop = performance.now() + this.settings.localLimitWaitMs;
    let now: number;
    let state: State;
    let active: State["leases"][string][];
    for (;;) {
      signal?.throwIfAborted();
      now = this.now();
      state = this.current(now);
      active = Object.values(state.leases);
      const remaining = stop - performance.now();
      if (active.length < this.settings.browserConcurrency || remaining <= 0)
        break;
      await delay(Math.min(100, remaining), undefined, { signal }).catch(() =>
        signal?.throwIfAborted(),
      );
    }
    const reject = (code: string, retryAt: string, reason: string): never => {
      writeLimitEvent({ code, outcome: "rejected", retryAt }, this.settings);
      throw new AppError(code, `${reason} Retry at ${retryAt}.`, { retryAt });
    };
    if (active.length >= this.settings.browserConcurrency)
      reject(
        "local_browser_concurrency",
        new Date(Math.min(...active.map(({ end }) => end))).toISOString(),
        "Cloud Browser concurrency limit reached. Closing a session can free a slot sooner.",
      );

    const available = (day: number) =>
      this.settings.browserDailyMinutes * 60_000 -
      (state.days[dayKey(day)]?.browserMs ?? 0) -
      active.reduce((sum, { start, end }) => sum + overlap(start, end, day), 0);
    const today = dayStart(now);
    const reset = today + dayMs;
    const untilReset = reset - now;
    const remainingToday = available(today);
    const remaining =
      remainingToday >= untilReset
        ? untilReset + Math.max(0, available(reset))
        : remainingToday;
    const seconds = Math.min(
      this.settings.browserSessionSeconds,
      Math.floor(remaining / 1_000),
    );
    // Match the minimum configured Cloud Browser session length.
    if (seconds < 30)
      reject(
        "local_browser_daily_limit",
        new Date(reset).toISOString(),
        "The daily Cloud Browser budget cannot fund another 30-second session. Closing a session may free reserved time.",
      );

    const id = randomUUID();
    state.leases[id] = {
      start: now,
      end: now + seconds * 1_000,
      runId: this.runId,
    };
    this.save(state);
    if (seconds < this.settings.browserSessionSeconds)
      writeLimitEvent(
        {
          code: "local_browser_daily_limit",
          outcome: "shortened",
          seconds,
          retryAt: new Date(reset).toISOString(),
        },
        this.settings,
      );

    const expiry = AbortSignal.timeout(seconds * 1_000);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        const ended = this.now();
        const latest = this.current(ended);
        this.finish(latest, id, ended);
        this.save(latest);
      } catch {
        // The persisted reservation still covers the full lease if settlement fails.
        console.error("Could not settle Cloud Browser usage.");
      }
    };
    try {
      return await connect({ seconds, signal: expiry, release });
    } catch (error) {
      release();
      throw error;
    }
  }
}
