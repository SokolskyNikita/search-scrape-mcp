import { MAX_PROVIDER_RESPONSE_BYTES } from "../config/safety-limits.js";
import { AppError } from "../server/error.js";

export async function providerResponse(
  provider: string,
  url: URL,
  init: RequestInit & { signal: AbortSignal },
  onHeaders?: (response: Response) => void,
  format: "json" | "text" | "binary" = "json",
) {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
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
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError(
          "provider_response",
          `${provider} response exceeded 8 MB.`,
        );
      }
      if (format === "binary") chunks.push(value);
      else body += decoder.decode(value, { stream: true });
    }
    if (format === "binary")
      return { response, body: Buffer.concat(chunks, size) };
    body += decoder.decode();
    if (format === "text") return { response, body };
    try {
      return { response, body: JSON.parse(body) as unknown };
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
