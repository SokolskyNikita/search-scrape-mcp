import { AppError } from "../server/error.js";

export async function providerResponse(
  provider: string,
  url: URL,
  init: RequestInit = {},
  onHeaders?: (response: Response) => void,
) {
  try {
    const timeout = AbortSignal.timeout(32_000);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal,
    });
    onHeaders?.(response);
    const reader = response.body?.getReader();
    if (!reader && !response.ok) return { response, body: null };
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
      return { response, body: JSON.parse(body + decoder.decode()) as unknown };
    } catch {
      if (!response.ok) return { response, body: null };
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

export async function providerRequest(
  provider: string,
  url: URL,
  init: RequestInit = {},
  classifyError?: (response: Response) => AppError | undefined,
): Promise<unknown> {
  const { response, body } = await providerResponse(provider, url, init);
  if (!response.ok)
    throw (
      classifyError?.(response) ??
      new AppError(
        "provider_http",
        `${provider} returned HTTP ${response.status}.`,
      )
    );
  return body;
}
