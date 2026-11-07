import { AppError } from "../server/error.js";

export async function providerRequest(
  provider: string,
  url: URL,
  init: RequestInit = {},
  classifyError?: (response: Response) => AppError | undefined,
): Promise<unknown> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const classified = classifyError?.(response);
      if (classified) throw classified;
      throw new AppError(
        "provider_http",
        `${provider} returned HTTP ${response.status}.`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new AppError(
        "provider_response",
        `${provider} returned an empty response.`,
      );
    const decoder = new TextDecoder();
    let size = 0;
    let body = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8_000_000) {
        await reader.cancel();
        throw new AppError(
          "provider_response",
          `${provider} response exceeded 8 MB.`,
        );
      }
      body += decoder.decode(value, { stream: true });
    }
    try {
      return JSON.parse(body + decoder.decode()) as unknown;
    } catch {
      throw new AppError(
        "provider_response",
        `${provider} returned invalid JSON.`,
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "provider_request",
      `${provider} request failed or timed out.`,
    );
  }
}
