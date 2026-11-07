import { defaults } from "../config/tuning.js";
import { toolTimeoutMs } from "../config/deadline.js";
import type { BrowserImage } from "../providers/types.js";
import { statsContext, writeToolStats } from "../server/stats.js";
import { AppError, safeError } from "../server/error.js";

export type Attempt = (provider?: string) => void;

const cacheMarker = Symbol("cachedSearch");
type CachedSearch<T> = { [cacheMarker]: true; value: T };
export const cachedSearch = <T>(value: T): CachedSearch<T> => ({
  [cacheMarker]: true as const,
  value,
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
          "consent",
        ].includes(error.code)
      )
        throw error;
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
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
) {
  const start = performance.now();
  let attempts = 0;
  let errorCode: string | null = null;
  const providers = new Set<string>();
  const controller = new AbortController();
  const timeoutError = new AppError(
    "tool_timeout",
    `Tool exceeded its ${settings.toolDeadlineSeconds}-second deadline.`,
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError);
        controller.abort(timeoutError);
      }, toolTimeoutMs(settings));
    });
    const result = await Promise.race([
      statsContext.run({ tool: name }, () =>
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
    if (
      result &&
      typeof result === "object" &&
      "type" in result &&
      result.type === "image"
    )
      return { content: [result as BrowserImage] };
    const cached = isCachedSearch(result);
    const value = cached ? result.value : result;
    return {
      content: [
        {
          type: "text" as const,
          text: typeof value === "string" ? value : JSON.stringify(value),
        },
        ...(cached ? [{ type: "text" as const, text: '{"cached":true}' }] : []),
      ],
    };
  } catch (error) {
    const failure = safeError(error);
    errorCode = failure.code;
    if (failure.code === "internal") console.error("Unexpected tool error.");
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: failure.details
            ? JSON.stringify({
                code: failure.code,
                reason: failure.message,
                ...failure.details,
              })
            : `${failure.code}: ${failure.message}`,
        },
      ],
    };
  } finally {
    clearTimeout(timer);
    writeToolStats(
      {
        tool: name,
        durationMs: Math.round(performance.now() - start),
        attempts,
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
) {
  const results: (
    | { index: number; result: O; cached?: true }
    | { index: number; error: { code: string; message: string } }
  )[] = [];
  const pending = inputs.map((input, index) => ({
    input,
    index,
    key: group?.(input),
  }));
  const busy = new Set<string>();
  await Promise.all(
    Array.from({ length: Math.min(2, inputs.length) }, async () => {
      for (;;) {
        const next = pending.findIndex(({ key }) => !key || !busy.has(key));
        if (next < 0) return;
        const { input, index, key } = pending.splice(next, 1)[0]!;
        if (key) busy.add(key);
        const start = performance.now();
        let attempts = 0;
        let errorCode: string | null = null;
        const providers = new Set<string>();
        try {
          const result = await statsContext.run(
            { tool: stats?.tool ?? "batch", itemIndex: index },
            () =>
              run(input, (provider) => {
                stats?.attempt(provider);
                attempts++;
                if (provider) providers.add(provider);
              }),
          );
          results[index] = isCachedSearch(result)
            ? { index, result: result.value, cached: true }
            : { index, result };
        } catch (error) {
          const { code, message, details } = safeError(error);
          errorCode = code;
          if (code === "internal")
            console.error("Unexpected batch item error.");
          results[index] = { index, error: { code, message, ...details } };
        } finally {
          if (key) busy.delete(key);
          if (stats)
            writeToolStats(
              {
                tool: stats.tool,
                itemIndex: index,
                durationMs: Math.round(performance.now() - start),
                attempts,
                provider: providers.size ? [...providers].join(",") : null,
                errorCode,
              },
              stats.settings,
            );
        }
      }
    }),
  );
  return results;
}
