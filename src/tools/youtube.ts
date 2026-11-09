import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { youtubeVideoId } from "../config/host-rules.js";
import { MAX_URL_CHARS } from "../config/safety-limits.js";
import { defaults } from "../config/tuning.js";
import type { YouTubeProvider, YouTubeResult } from "../providers/types.js";
import type { YouTubeProgress } from "../server/youtube-queue.js";
import { AppError } from "../server/error.js";
import { toolInput } from "./input.js";
import type { OutputFiles } from "./output-files.js";
import { ResultCache } from "./result-cache.js";
import { cachedSearch, fallback, toolResult } from "./shared.js";

const input = toolInput({
  url: z.string().trim().min(1).max(MAX_URL_CHARS),
  transcript: z
    .boolean()
    .default(false)
    .describe(
      "Fetch captions in the original language when available, otherwise English.",
    ),
  start_seconds: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Include captions starting at or after this timestamp. Requires transcript: true.",
    ),
  end_seconds: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Exclude captions starting at or after this timestamp. Requires transcript: true.",
    ),
  fresh: z.boolean().default(false).describe("Bypass the local result cache."),
});

function videoId(value: string) {
  const url = URL.parse(value);
  const id = url && youtubeVideoId(url);
  if (!id)
    throw new AppError(
      "input",
      "Use a YouTube watch, Shorts, live, embed, or youtu.be video URL.",
    );
  return id;
}

export function youtubeTool(
  providers: readonly YouTubeProvider[],
  files: OutputFiles,
  settings = defaults,
) {
  const cache = new ResultCache<YouTubeResult>(settings);
  type ProgressListener = (update: YouTubeProgress) => void;
  const pending = new Map<
    string,
    {
      result: Promise<YouTubeResult>;
      listeners: Set<ProgressListener>;
      controller: AbortController;
      latest?: YouTubeProgress;
    }
  >();

  function present(
    video: YouTubeResult,
    start: number | undefined,
    end: number | undefined,
    cachedAt?: string,
  ) {
    const cacheInfo = cachedAt
      ? { cached: true, cached_at: cachedAt }
      : { cached: false };
    const transcript = video.transcript;
    if (transcript?.status === "ok") {
      const ranged = start !== undefined || end !== undefined;
      const segments = ranged
        ? transcript.segments.filter(
            ({ start_seconds }) =>
              start_seconds >= (start ?? 0) &&
              start_seconds < (end ?? Infinity),
          )
        : transcript.segments;
      const range = ranged
        ? { range: { start_seconds: start, end_seconds: end } }
        : {};
      const bytes = Buffer.from(JSON.stringify(segments));
      if (bytes.length > settings.scrapeInlineChars) {
        const { status, language, kind, translated } = transcript;
        const preview = [];
        let remaining = settings.outputPreviewChars - 2;
        for (const segment of segments) {
          remaining -= JSON.stringify(segment).length + 1;
          if (remaining < 0) break;
          preview.push(segment);
        }
        return {
          ...video,
          ...cacheInfo,
          note: "Partial transcript preview. Use a timestamp range for a smaller excerpt.",
          transcript: {
            status,
            language,
            kind,
            translated,
            ...range,
            partial: true,
            segments: preview,
            file: files.saveBinary({
              bytes,
              mimeType: "application/json",
              extension: "json",
            }),
          },
        };
      }
      return {
        ...video,
        ...cacheInfo,
        transcript: { ...transcript, ...range, segments },
        ...(!segments.length && {
          note: "No captions start within the requested range.",
        }),
      };
    }
    return {
      ...video,
      ...cacheInfo,
      ...((transcript?.status === "no_captions" ||
        transcript?.status === "unavailable") && {
        note: "No transcript was retrieved. Try a different video if you need captions.",
      }),
    };
  }

  return (server: McpServer) =>
    server.registerTool(
      "youtube",
      {
        description:
          "Read a YouTube video's metadata. Set transcript to true to retrieve its captions with timestamps. Use start_seconds and end_seconds to request an excerpt.",
        inputSchema: input,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      (
        { url, transcript, fresh, start_seconds: start, end_seconds: end },
        extra,
      ) =>
        toolResult(
          "youtube",
          async (attempt, signal, deadline) => {
            if ((start !== undefined || end !== undefined) && !transcript)
              throw new AppError(
                "input",
                "Transcript ranges require transcript: true.",
              );
            if (end !== undefined && end <= (start ?? 0))
              throw new AppError(
                "input",
                "end_seconds must be greater than start_seconds.",
              );
            const id = videoId(url);
            const key = `${id}:${transcript}`;
            const cached = cache.get(key, fresh);
            if (cached)
              return cachedSearch(
                present(cached.value, start, end, cached.cached_at),
                cached.cached_at,
              );

            const caller = AbortSignal.any([signal, extra.signal]);
            caller.throwIfAborted();
            const token = extra._meta?.progressToken;
            let sequence = 0;
            let previous: YouTubeProgress | undefined;
            const notify: ProgressListener = (update) => {
              if (token === undefined || caller.aborted) return;
              if (
                previous &&
                previous.running === update.running &&
                previous.ahead === update.ahead &&
                Math.abs(previous.startMs - update.startMs) < 5_000 &&
                Math.abs(previous.resultMs - update.resultMs) < 5_000
              )
                return;
              previous = update;
              const start = Math.ceil(update.startMs / 1_000);
              const result = Math.ceil(update.resultMs / 1_000);
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken: token,
                    progress: ++sequence,
                    message: update.running
                      ? `Fetching YouTube video. Estimated result in ${result}s.`
                      : `Queued for YouTube. ${update.ahead} jobs ahead. Estimated start in ${start}s, result in ${result}s.`,
                  },
                })
                .catch(() => {});
            };

            let job = fresh ? undefined : pending.get(key);
            if (job) {
              job.listeners.add(notify);
              if (job.latest) notify(job.latest);
            } else {
              let partial: YouTubeResult | undefined;
              let latest: { update: YouTubeProgress; at: number } | undefined;
              const listeners = new Set([notify]);
              const controller = new AbortController();
              const result = fallback(
                providers,
                async (provider) => {
                  const result = await provider.fetch(
                    id,
                    transcript,
                    controller.signal,
                    deadline,
                    (update) => {
                      latest = { update, at: performance.now() };
                      for (const listener of listeners) listener(update);
                    },
                  );
                  const status = result.transcript?.status;
                  if (transcript && status !== "ok") {
                    partial ??= result;
                    throw new AppError(
                      "youtube_transcript_unavailable",
                      "Provider did not return a transcript.",
                    );
                  }
                  return result;
                },
                attempt,
                controller.signal,
              )
                .catch((error) => {
                  if (partial) return partial;
                  throw error;
                })
                .then((result) => {
                  controller.signal.throwIfAborted();
                  const { transcript: captions, ...metadata } = result;
                  cache.set(`${id}:false`, metadata);
                  if (captions?.status === "ok") cache.set(key, result);
                  return result;
                });
              job = {
                result,
                listeners,
                controller,
                get latest() {
                  if (!latest) return;
                  const elapsed = performance.now() - latest.at;
                  return {
                    ...latest.update,
                    startMs: Math.max(0, latest.update.startMs - elapsed),
                    resultMs: Math.max(0, latest.update.resultMs - elapsed),
                  };
                },
              };
              if (!fresh) {
                pending.set(key, job);
                const shared = job;
                const clear = () => {
                  if (pending.get(key) === shared) pending.delete(key);
                };
                void result.then(clear, clear);
              }
            }

            const shared = job;
            const detach = () => shared.listeners.delete(notify);
            let cancel!: () => void;
            const canceled = new Promise<never>((_, reject) => {
              cancel = () => {
                const reason =
                  caller.reason instanceof AppError
                    ? caller.reason
                    : new AppError(
                        "tool_cancelled",
                        "YouTube request was canceled.",
                      );
                detach();
                if (shared.listeners.size === 0) {
                  if (pending.get(key) === shared) pending.delete(key);
                  shared.controller.abort(reason);
                }
                reject(reason);
              };
              if (caller.aborted) cancel();
              else caller.addEventListener("abort", cancel, { once: true });
            });
            try {
              return present(
                await Promise.race([shared.result, canceled]),
                start,
                end,
              );
            } finally {
              detach();
              caller.removeEventListener("abort", cancel);
            }
          },
          settings,
          { presentation: { operation: "youtube", jsonBody: true } },
        ),
    );
}
