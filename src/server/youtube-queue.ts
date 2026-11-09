import type { Tuning } from "../config/tuning.js";
import { AppError } from "./error.js";
import { writeLimitEvent } from "./stats.js";

export type YouTubeProgress = {
  ahead: number;
  startMs: number;
  resultMs: number;
  running?: true;
};

type Job = {
  estimate: number;
  expires: number;
  notify?: (progress: YouTubeProgress) => void;
  run: () => Promise<void>;
  cancel: (error: unknown) => void;
  detach: () => void;
};

export class YouTubeQueue {
  private readonly waiting: Job[] = [];
  private active?: { finish: number };
  private readyAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(private readonly settings: Tuning) {}

  coolDown(retryAfterMs = 0) {
    // Bound upstream delay values before they can affect server-wide state.
    const maxRetryAfterMs = 24 * 60 * 60 * 1_000;
    const retryDelay =
      retryAfterMs > 0 && retryAfterMs <= maxRetryAfterMs ? retryAfterMs : 0;
    this.readyAt = Math.max(
      this.readyAt,
      performance.now() + Math.max(this.settings.youtubeCooldownMs, retryDelay),
    );
    return this.retryAt(this.readyAt);
  }

  enqueue<T>(
    transcript: boolean,
    signal: AbortSignal,
    deadline: number,
    run: () => Promise<T>,
    notify?: (progress: YouTubeProgress) => void,
  ): Promise<T> {
    signal.throwIfAborted();
    const now = performance.now();
    const estimate = transcript ? 20_000 : 8_000;
    const expires = Math.min(
      deadline - estimate,
      now + this.settings.youtubeLimitWaitMs,
    );
    const start =
      this.firstStart(now) +
      this.waiting.reduce(
        (sum, job) => sum + job.estimate + this.settings.youtubeJobGapMs,
        0,
      );
    if (start > expires) return Promise.reject(this.busy(start));

    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(job);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        job.cancel(signal.reason);
        this.advance();
      };
      const detach = () => signal.removeEventListener("abort", abort);
      const job: Job = {
        estimate,
        expires,
        notify,
        detach,
        cancel(error) {
          detach();
          reject(error);
        },
        async run() {
          try {
            signal.throwIfAborted();
            resolve(await run());
          } catch (error) {
            reject(error);
          }
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(job);
      this.advance(now);
    });
  }

  private firstStart(now: number) {
    return Math.max(
      now,
      this.readyAt,
      this.active
        ? Math.max(now, this.active.finish) + this.settings.youtubeJobGapMs
        : now,
    );
  }

  private retryAt(when: number) {
    return new Date(
      Date.now() + Math.max(0, when - performance.now()),
    ).toISOString();
  }

  private busy(when: number) {
    const retryAt = this.retryAt(when);
    writeLimitEvent(
      {
        code: "local_rate_limit",
        outcome: "rejected",
        provider: "yt-dlp",
        retryAt,
      },
      this.settings,
    );
    return new AppError(
      "local_rate_limit",
      "YouTube queue cannot start this job in time.",
      { retryAt },
    );
  }

  private advance(now = performance.now()) {
    clearTimeout(this.timer);
    let start = this.firstStart(now);
    let wake = Infinity;
    for (let i = 0; i < this.waiting.length;) {
      const job = this.waiting[i]!;
      if (start > job.expires) {
        this.waiting.splice(i, 1);
        job.cancel(this.busy(start));
        continue;
      }
      job.notify?.({
        ahead: i + Number(Boolean(this.active)),
        startMs: start - now,
        resultMs: start - now + job.estimate,
      });
      wake = Math.min(wake, job.expires + 1);
      start += job.estimate + this.settings.youtubeJobGapMs;
      i++;
    }

    if (!this.active && this.readyAt <= now) {
      const job = this.waiting.shift();
      if (!job) return;
      job.detach();
      this.active = { finish: now + job.estimate };
      job.notify?.({
        ahead: 0,
        startMs: 0,
        resultMs: job.estimate,
        running: true,
      });
      void job.run().finally(() => {
        this.active = undefined;
        this.readyAt = Math.max(
          this.readyAt,
          performance.now() + this.settings.youtubeJobGapMs,
        );
        this.advance();
      });
    } else if (!this.active) {
      wake = Math.min(wake, this.readyAt);
    }
    if (this.waiting.length && Number.isFinite(wake))
      this.timer = setTimeout(
        () => this.advance(),
        Math.max(1, Math.ceil(wake - now)),
      );
  }
}
