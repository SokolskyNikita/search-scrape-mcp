import { AppError, safeError } from "../server/error.js";

export async function fallback<T, R>(
  providers: readonly T[],
  run: (provider: T) => Promise<R>,
): Promise<R> {
  const errors: AppError[] = [];
  for (const provider of providers) {
    try {
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

export function toolResult(run: () => Promise<unknown>) {
  return run()
    .then((result) => ({
      content: [
        {
          type: "text" as const,
          text: typeof result === "string" ? result : JSON.stringify(result),
        },
      ],
    }))
    .catch((error: unknown) => {
      const failure = safeError(error);
      if (failure.code === "internal") console.error("Unexpected tool error.");
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `${failure.code}: ${failure.message}`,
          },
        ],
      };
    });
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
