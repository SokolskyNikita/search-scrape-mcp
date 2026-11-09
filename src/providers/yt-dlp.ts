import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Tuning } from "../config/tuning.js";
import type { RequestLimits } from "../server/request-limits.js";
import { AppError } from "../server/error.js";
import type { YouTubeProvider, YouTubeResult } from "./types.js";

const execute = promisify(execFile);
const script = fileURLToPath(
  new URL("../../src/providers/yt-dlp.py", import.meta.url),
);
const brewPython = "/opt/homebrew/opt/yt-dlp/libexec/bin/python3";

export function ytDlp(
  limits: RequestLimits,
  settings: Tuning,
  python = process.env.YT_DLP_PYTHON ||
    (existsSync(brewPython) ? brewPython : "python3"),
): YouTubeProvider {
  return {
    name: "yt-dlp",
    async fetch(videoId, transcript, signal, deadline, notify) {
      return limits.youtube.enqueue(
        transcript,
        signal,
        deadline,
        async () => {
          signal.throwIfAborted();
          let stdout: string;
          try {
            const processResult = execute(
              python,
              [
                script,
                videoId,
                String(transcript),
                String(settings.youtubeRequestGapMs),
              ],
              {
                timeout: Math.max(1, Math.floor(deadline - performance.now())),
                killSignal: "SIGKILL",
                maxBuffer: 4_000_000,
                windowsHide: true,
                env: { ...process.env, PYTHONIOENCODING: "utf-8" },
              },
            );
            const kill = () => {
              processResult.child.kill("SIGKILL");
            };
            signal.addEventListener("abort", kill, { once: true });
            try {
              ({ stdout } = await processResult);
            } finally {
              signal.removeEventListener("abort", kill);
            }
          } catch {
            signal.throwIfAborted();
            throw new AppError(
              "youtube_unavailable",
              "Could not run yt-dlp. Check the configured Python and yt-dlp installation.",
            );
          }

          let result: YouTubeResult & {
            error?: string;
            rate_limited?: boolean;
            retry_after_ms?: number;
          };
          try {
            result = JSON.parse(stdout);
          } catch {
            throw new AppError(
              "youtube_unavailable",
              "yt-dlp returned an unreadable response.",
            );
          }
          const { error, rate_limited, retry_after_ms, ...video } = result;
          const retryAt =
            rate_limited ||
            error === "rate_limited" ||
            video.transcript?.status === "rate_limited"
              ? limits.youtube.coolDown(retry_after_ms)
              : undefined;
          if (error === "rate_limited")
            throw new AppError(
              "provider_rate",
              "YouTube rate-limited this request.",
              {
                retryAt,
              },
            );
          if (error)
            throw new AppError(
              "youtube_unavailable",
              "Could not retrieve the YouTube video.",
            );
          return video;
        },
        notify,
      );
    },
  };
}
