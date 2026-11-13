import { messages } from "../config/messages.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { defaults } from "../config/tuning.js";
import { toolTimeoutMs } from "../config/deadline.js";
import {
  presentedError,
  presentedResult,
  type ResultPresentation,
} from "./result-format.js";
import {
  newRequestId,
  statsContext,
  writeToolStats,
  type RequestStats,
} from "../server/stats.js";
import { AppError, safeError } from "../server/error.js";
import { toolCallContext } from "../server/tool-transport.js";

export type Attempt = (provider?: string) => void;

const cacheMarker = Symbol("cachedSearch");
type CachedSearch<T> = { [cacheMarker]: true; value: T; cached_at: string };
export const cachedSearch = <T>(
  value: T,
  cached_at: string,
): CachedSearch<T> => ({
  [cacheMarker]: true as const,
  value,
  cached_at,
});
function isCachedSearch<T>(
  value: T | CachedSearch<T>,
): value is CachedSearch<T> {
  return !!value && typeof value === "object" && cacheMarker in value;
}

export async function fallback<T extends { name?: string }, R>(
  providers: readonly T[],
  run: (provider: T) => Promise<R>,
  attempt: Attempt,
  signal: AbortSignal,
): Promise<R> {
  const errors: AppError[] = [];
  for (const provider of providers) {
    signal.throwIfAborted();
    try {
      attempt(provider.name);
      return await run(provider);
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        [
          "unsafe_url",
          "unsupported_in_scrape",
          "dns",
          "provider_auth",
          "provider_limit",
          "provider_credit",
          "provider_cost_overrun",
          "provider_cost_opt_in_required",
          "provider_proxy_pool",
          "binary_download",
          "file_refused",
          "file_host_state",
          "output_size",
          "provider_rate",
          "local_rate_limit",
          "local_site_limit",
          "local_credit_limit",
          "not_found",
          "sign_in",
          "content_moved",
        ].includes(error.code)
      )
        throw error;
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  const costError = errors.findLast(
    (error) => error.code === "provider_cost_budget",
  );
  if (costError) throw costError;
  if (errors.length === 0)
    throw new AppError("not_configured", "Provider is not configured.");
  throw new AppError(
    errors.at(-1)!.code,
    errors.map((error) => error.message).join(" "),
    errors.findLast((error) => error.details?.hint)?.details ??
      errors.at(-1)?.details,
  );
}

export async function toolResult(
  name: string,
  run: (
    attempt: Attempt,
    signal: AbortSignal,
    deadline: number,
  ) => Promise<unknown>,
  settings = defaults,
  {
    partialOnTimeout = false,
    presentation,
    signal: cancelSignal,
  }: {
    partialOnTimeout?: boolean;
    presentation?: ResultPresentation;
    /** Aborts when the client cancels the request. */
    signal?: AbortSignal;
  } = {},
): Promise<CallToolResult> {
  const start = performance.now();
  const timeoutMs = Math.min(
    toolTimeoutMs(settings),
    toolCallContext.getStore()?.deadlineMs ?? Infinity,
  );
  const request: RequestStats = { httpAttempts: 0, requestId: newRequestId() };
  let attempts = 0;
  let errorCode: string | null = null;
  let outputChars: number | undefined;
  const providers = new Set<string>();
  const controller = new AbortController();
  const timeoutError = new AppError("tool_timeout", messages.service.timeout);
  // Stop provider work, and its cost, once nobody is waiting for the result.
  const callers: [AbortSignal | undefined, AppError][] = [
    [
      cancelSignal,
      new AppError("client_cancelled", messages.service.cancelled),
    ],
    [
      toolCallContext.getStore()?.disconnected,
      new AppError("client_disconnected", messages.service.disconnected),
    ],
  ];
  const detach: (() => void)[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          // A batch returns what it has at the deadline. A caller that left gets nothing.
          if (controller.signal.reason !== timeoutError || !partialOnTimeout)
            reject(controller.signal.reason);
        },
        { once: true },
      );
    });
    deadline.catch(() => {});
    timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    for (const [caller, reason] of callers) {
      if (!caller) continue;
      const stop = () => controller.abort(reason);
      if (caller.aborted) stop();
      else {
        caller.addEventListener("abort", stop, { once: true });
        detach.push(() => caller.removeEventListener("abort", stop));
      }
    }
    const result = await Promise.race([
      statsContext.run({ tool: name, request }, () =>
        run(
          (provider) => {
            attempts++;
            if (provider) providers.add(provider);
          },
          controller.signal,
          start + timeoutMs,
        ),
      ),
      deadline,
    ]);
    const cached = isCachedSearch(result);
    if (cached) request.cached = true;
    const value = cached ? result.value : result;
    const presented = presentedResult(
      presentation ?? { operation: name },
      value,
      cached ? result.cached_at : undefined,
    );
    outputChars = textLength(presented);
    return presented;
  } catch (error) {
    const failure = safeError(error);
    errorCode = failure.code;
    if (failure.code === "internal") console.error("Unexpected tool error.");
    const presented = presentedError(
      presentation ?? { operation: name },
      failure,
    );
    outputChars = textLength(presented);
    return presented;
  } finally {
    clearTimeout(timer);
    for (const remove of detach) remove();
    writeToolStats(
      {
        requestId: request.requestId,
        tool: name,
        durationMs: Math.round(performance.now() - start),
        attempts,
        httpAttempts: request.httpAttempts,
        warningCode: request.warningCode,
        batchItems: request.batchItems,
        provider: providers.size ? [...providers].join(",") : null,
        errorCode,
        host: request.host,
        outputChars,
        cached: request.cached,
        truncated: request.truncated,
        creditsSpent: request.creditsSpent,
        era: toolCallContext.getStore()?.era,
      },
      settings,
    );
  }
}

function textLength(result: CallToolResult) {
  return result.content.reduce(
    (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
    0,
  );
}

export async function batch<I, O>(
  inputs: I[],
  run: (input: I, attempt: Attempt) => Promise<O | CachedSearch<O>>,
  group?: (input: I) => string | undefined,
  stats?: { tool: string; attempt: Attempt; settings: typeof defaults },
  signal?: AbortSignal,
) {
  const parent = statsContext.getStore()?.request;
  const results: (
    | { index: number; result: O; cached?: true; cached_at?: string }
    | {
        index: number;
        error: { code: string; reason: string; message: string };
      }
  )[] = [];
  const pending = inputs.map((input, index) => ({
    input,
    index,
    key: group?.(input),
  }));
  const busy = new Set<string>();
  const workers = Promise.all(
    // Batches are small, so every item starts at once. Items for the same host still
    // take turns, and the provider queues pace the requests.
    Array.from({ length: inputs.length }, async () => {
      while (!signal?.aborted) {
        const next = pending.findIndex(({ key }) => !key || !busy.has(key));
        if (next < 0) return;
        const { input, index, key } = pending.splice(next, 1)[0]!;
        if (key) busy.add(key);
        const start = performance.now();
        const request: RequestStats = {
          httpAttempts: 0,
          requestId: parent?.requestId,
          parent,
        };
        let attempts = 0;
        let errorCode: string | null = null;
        const providers = new Set<string>();
        try {
          const result = await statsContext.run(
            { tool: stats?.tool ?? "batch", itemIndex: index, request },
            () =>
              run(input, (provider) => {
                stats?.attempt(provider);
                attempts++;
                if (provider) providers.add(provider);
              }),
          );
          if (isCachedSearch(result)) request.cached = true;
          results[index] = isCachedSearch(result)
            ? {
                index,
                result: result.value,
                cached: true,
                cached_at: result.cached_at,
              }
            : { index, result };
        } catch (error) {
          const { code, message, details } = safeError(error);
          errorCode = code;
          if (code === "internal")
            console.error("Unexpected batch item error.");
          results[index] = {
            index,
            error: { code, reason: message, message, ...details },
          };
        } finally {
          if (key) busy.delete(key);
          if (stats)
            writeToolStats(
              {
                requestId: request.requestId,
                tool: stats.tool,
                itemIndex: index,
                durationMs: Math.round(performance.now() - start),
                attempts,
                httpAttempts: request.httpAttempts,
                warningCode: request.warningCode,
                provider: providers.size ? [...providers].join(",") : null,
                errorCode,
                host: request.host,
                outputChars: request.outputChars,
                cached: request.cached,
                truncated: request.truncated,
                creditsSpent: request.creditsSpent,
              },
              stats.settings,
            );
        }
      }
    }),
  );
  const summarize = (items: typeof results) => {
    if (parent) {
      const failed = items.filter((item) => "error" in item).length;
      parent.batchItems = { succeeded: items.length - failed, failed };
    }
    return items;
  };
  if (!signal) {
    await workers;
    return summarize(results);
  }
  let finish!: () => void;
  const aborted = new Promise<void>((resolve) => {
    finish = resolve;
  });
  if (signal.aborted) finish();
  else signal.addEventListener("abort", finish, { once: true });
  try {
    await Promise.race([workers, aborted]);
    if (!signal.aborted) return summarize(results);
    const { code, message, details } = safeError(signal.reason);
    return summarize(
      inputs.map(
        (_, index) =>
          results[index] ?? {
            index,
            error: { code, reason: message, message, ...details },
          },
      ),
    );
  } finally {
    signal.removeEventListener("abort", finish);
  }
}
