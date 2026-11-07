import { MAX_PROVIDER_RESPONSE_BYTES } from "../config/safety-limits.js";
import type { ConnectOverCDPTransport } from "playwright-core";
import WebSocket from "ws";
import { AppError } from "../server/error.js";
export async function scrapflyTransport(
  endpoint: URL,
  signal?: AbortSignal,
): Promise<ConnectOverCDPTransport> {
  signal?.throwIfAborted();
  const socket = new WebSocket(endpoint, {
    handshakeTimeout: 15_000,
    maxPayload: MAX_PROVIDER_RESPONSE_BYTES,
    perMessageDeflate: false,
  });
  const transport = cdpTransport(socket);
  const abort = () => socket.terminate();
  signal?.addEventListener("abort", abort, { once: true });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.on("error", () => {
      reject(
        new AppError(
          "browser_socket",
          "Scrapfly Cloud Browser WebSocket failed.",
        ),
      );
    });
    socket.once("unexpected-response", (request, response) => {
      const status = response.statusCode ?? 502;
      reject(
        new AppError(
          `browser_http_${status}`,
          `Scrapfly Cloud Browser rejected the connection (HTTP ${status}).`,
        ),
      );
      response.destroy();
      request.destroy();
    });
    socket.once("close", () =>
      reject(
        new AppError(
          "browser_socket",
          "Scrapfly Cloud Browser closed the WebSocket.",
        ),
      ),
    );
  }).finally(() => signal?.removeEventListener("abort", abort));
  signal?.throwIfAborted();
  return transport;
}

function cdpTransport(socket: WebSocket): ConnectOverCDPTransport {
  const transport: ConnectOverCDPTransport = {
    close: () => socket.close(),
    send(message) {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    },
  };
  socket.addEventListener("message", ({ data }) => {
    try {
      if (typeof data !== "string")
        throw new AppError("browser_protocol", "Invalid CDP message.");
      const message: unknown = JSON.parse(data);
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new AppError("browser_protocol", "Invalid CDP message.");
      }
      transport.onmessage?.(message);
    } catch {
      socket.close();
    }
  });
  socket.addEventListener("close", () => transport.onclose?.());
  return transport;
}
