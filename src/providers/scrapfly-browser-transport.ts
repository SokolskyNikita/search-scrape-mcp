import type { ConnectOverCDPTransport } from "playwright-core";
import WebSocket from "ws";
import { AppError } from "../server/error.js";
import { validatePublicUrl } from "../server/target.js";

type ProtocolMessage = {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: { requestId?: string; request?: { url?: string }; url?: string };
};

export async function scrapflyTransport(
  endpoint: URL,
): Promise<ConnectOverCDPTransport> {
  const socket = new WebSocket(endpoint, {
    handshakeTimeout: 15_000,
    maxPayload: 8_000_000,
    perMessageDeflate: false,
  });
  const transport = guardedCdp(socket);
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
  });
  return transport;
}

export function guardedCdp(socket: WebSocket): ConnectOverCDPTransport {
  const transport: ConnectOverCDPTransport = {
    close: () => socket.close(),
    send: (message: ProtocolMessage) => {
      const id = requestId(message);
      if (message.method === "Fetch.continueRequest" && id) {
        // Playwright automatically continues redirect hops without calling the
        // context's route handler. Validate the URL before forwarding that command.
        const url = message.params?.url ?? paused.get(id);
        paused.delete(id);
        void allow(url).then((allowed) => {
          send(
            allowed
              ? message
              : {
                  id: message.id,
                  sessionId: message.sessionId,
                  method: "Fetch.failRequest",
                  params: {
                    requestId: message.params?.requestId,
                    errorReason: "BlockedByClient",
                  },
                },
          );
        });
        return;
      }
      if (
        id &&
        (message.method === "Fetch.fulfillRequest" ||
          message.method === "Fetch.failRequest")
      )
        paused.delete(id);
      send(message);
    },
  };
  const paused = new Map<string, string>();
  const pending = new Map<string, Promise<boolean>>();

  function requestId(message: ProtocolMessage): string | undefined {
    const id = message.params?.requestId;
    return id === undefined ? undefined : `${message.sessionId ?? ""}:${id}`;
  }

  function allow(url: string | undefined): Promise<boolean> {
    if (url === undefined) return Promise.resolve(false);
    const existing = pending.get(url);
    if (existing) return existing;
    if (pending.size >= 128) return Promise.resolve(false);
    const validation = validatePublicUrl(url)
      .then(
        () => true,
        () => false,
      )
      .finally(() => pending.delete(url));
    pending.set(url, validation);
    return validation;
  }

  function send(message: object): void {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  }

  socket.addEventListener("message", ({ data }) => {
    if (typeof data !== "string") {
      socket.close();
      return;
    }
    let message: ProtocolMessage;
    try {
      message = JSON.parse(data) as ProtocolMessage;
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        socket.close();
        return;
      }
    } catch {
      socket.close();
      return;
    }
    const id = requestId(message);
    const url = message.params?.request?.url;
    if (message.method === "Fetch.requestPaused" && id && url) {
      if (paused.size >= 2048) {
        socket.close();
        return;
      }
      paused.set(id, url);
    }
    transport.onmessage?.(message);
  });
  socket.addEventListener("close", () => transport.onclose?.());
  return transport;
}
