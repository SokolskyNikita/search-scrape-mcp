import type { BrowserImage } from "../providers/types.js";
import { writeToolStats } from "../server/stats.js";
import { AppError, safeError } from "../server/error.js";

export type Attempt = (provider?: string) => void;

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
        ["unsafe_url", "dns", "provider_auth", "provider_limit"].includes(
          error.code,
        )
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
  );
}

export async function toolResult(
  name: string,
  run: (attempt: Attempt, signal: AbortSignal) => Promise<unknown>,
) {
  const start = performance.now();
  let attempts = 0;
  let errorCode: string | null = null;
  const providers = new Set<string>();
  const controller = new AbortController();
  const timeoutError = new AppError(
    "tool_timeout",
    "Tool exceeded its 54-second deadline.",
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError);
        controller.abort(timeoutError);
      }, 54_000);
    });
    const result = await Promise.race([
      run((provider) => {
        attempts++;
        if (provider) providers.add(provider);
      }, controller.signal),
      deadline,
    ]);
    if (Array.isArray(result)) {
      const failed = result.find(
        (item: unknown): item is { error: { code: string } } =>
          item !== null && typeof item === "object" && "error" in item,
      );
      errorCode = failed?.error.code ?? null;
    }
    if (
      result &&
      typeof result === "object" &&
      "type" in result &&
      result.type === "image"
    )
      return { content: [result as BrowserImage] };
    return {
      content: [
        {
          type: "text" as const,
          text: typeof result === "string" ? result : JSON.stringify(result),
        },
      ],
    };
  } catch (error) {
    const failure = safeError(error);
    errorCode = failure.code;
    if (failure.code === "internal") console.error("Unexpected tool error.");
    return {
      isError: true,
      content: [
        { type: "text" as const, text: `${failure.code}: ${failure.message}` },
      ],
    };
  } finally {
    clearTimeout(timer);
    writeToolStats({
      tool: name,
      durationMs: Math.round(performance.now() - start),
      attempts,
      provider: providers.size ? [...providers].join(",") : null,
      errorCode,
    });
  }
}

export async function batch<I, O>(inputs: I[], run: (input: I) => Promise<O>) {
  const results: (
    | { index: number; result: O }
    | { index: number; error: { code: string; message: string } }
  )[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, inputs.length) }, async () => {
      while (next < inputs.length) {
        const index = next++;
        try {
          results[index] = { index, result: await run(inputs[index]!) };
        } catch (error) {
          const { code, message } = safeError(error);
          if (code === "internal")
            console.error("Unexpected batch item error.");
          results[index] = { index, error: { code, message } };
        }
      }
    }),
  );
  return results;
}
