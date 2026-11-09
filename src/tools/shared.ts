import { messages } from "../config/messages.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { defaults } from "../config/tuning.js";
import { toolTimeoutMs } from "../config/deadline.js";
import {
  presentedError,
  presentedResult,
  type ResultPresentation,
} from "./result-format.js";
import {
  statsContext,
  writeToolStats,
  type RequestStats,
} from "../server/stats.js";
import { AppError, safeError } from "../server/error.js";

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
  }: { partialOnTimeout?: boolean; presentation?: ResultPresentation } = {},
): Promise<CallToolResult> {
  const start = performance.now();
  const request: RequestStats = { httpAttempts: 0 };
  let attempts = 0;
  let errorCode: string | null = null;
  const providers = new Set<string>();
  const controller = new AbortController();
  const timeoutError = new AppError("tool_timeout", messages.service.timeout);
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError);
        if (!partialOnTimeout) reject(timeoutError);
      }, toolTimeoutMs(settings));
    });
    const result = await Promise.race([
      statsContext.run({ tool: name, request }, () =>
        run(
          (provider) => {
            attempts++;
            if (provider) providers.add(provider);
          },
          controller.signal,
          start + toolTimeoutMs(settings),
        ),
      ),
      deadline,
    ]);
    const cached = isCachedSearch(result);
    const value = cached ? result.value : result;
    return presentedResult(
      presentation ?? { operation: name },
      value,
      cached ? result.cached_at : undefined,
    );
  } catch (error) {
    const failure = safeError(error);
    errorCode = failure.code;
    if (failure.code === "internal") console.error("Unexpected tool error.");
    return presentedError(presentation ?? { operation: name }, failure);
  } finally {
    clearTimeout(timer);
    writeToolStats(
      {
        tool: name,
        durationMs: Math.round(performance.now() - start),
        attempts,
        httpAttempts: request.httpAttempts,
        warningCode: request.warningCode,
        batchItems: request.batchItems,
        provider: providers.size ? [...providers].join(",") : null,
        errorCode,
      },
      settings,
    );
  }
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
    Array.from({ length: Math.min(2, inputs.length) }, async () => {
      while (!signal?.aborted) {
        const next = pending.findIndex(({ key }) => !key || !busy.has(key));
        if (next < 0) return;
        const { input, index, key } = pending.splice(next, 1)[0]!;
        if (key) busy.add(key);
        const start = performance.now();
        const request: RequestStats = { httpAttempts: 0, parent };
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
                tool: stats.tool,
                itemIndex: index,
                durationMs: Math.round(performance.now() - start),
                attempts,
                httpAttempts: request.httpAttempts,
                warningCode: request.warningCode,
                provider: providers.size ? [...providers].join(",") : null,
                errorCode,
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
