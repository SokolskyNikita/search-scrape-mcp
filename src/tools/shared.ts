import type { BrowserImage } from "../providers/types.js";
import { AppError, safeError } from "../server/error.js";

export async function fallback<T, R>(
  providers: readonly T[],
  run: (provider: T) => Promise<R>,
  attempt: () => void,
): Promise<R> {
  const errors: AppError[] = [];
  for (const provider of providers) {
    try {
      attempt();
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
  run: (attempt: () => void) => Promise<unknown>,
) {
  const start = performance.now();
  let attempts = 0;
  let ok = false;
  try {
    const result = await run(() => {
      attempts++;
    });
    ok =
      !Array.isArray(result) ||
      !result.some(
        (item: unknown) =>
          item !== null && typeof item === "object" && "error" in item,
      );
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
    if (failure.code === "internal") console.error("Unexpected tool error.");
    return {
      isError: true,
      content: [
        { type: "text" as const, text: `${failure.code}: ${failure.message}` },
      ],
    };
  } finally {
    console.log(
      JSON.stringify({
        tool: name,
        durationMs: Math.round(performance.now() - start),
        ok,
        attempts,
      }),
    );
  }
}

export async function batch<I, O>(inputs: I[], run: (input: I) => Promise<O>) {
  const results = [];
  for (const [index, input] of inputs.entries()) {
    try {
      results.push({ index, result: await run(input) });
    } catch (error) {
      const { code, message } = safeError(error);
      if (code === "internal") console.error("Unexpected batch item error.");
      results.push({ index, error: { code, message } });
    }
  }
  return results;
}
