import type { CDPSession } from "playwright-core";
import { safeError } from "../server/error.js";
import { validatePublicUrl } from "../server/target.js";

export async function guardNavigations(
  cdp: CDPSession,
  onDocumentResponse?: (status: number, mitigated: boolean) => void,
  pace?: (hostname: string, signal: AbortSignal) => Promise<() => void>,
  disconnected?: AbortSignal,
) {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  let blocked: ReturnType<typeof safeError> | undefined;
  const pending = new Map<string, AbortController>();
  const finish = (id: string) => {
    pending.get(id)?.abort();
    pending.delete(id);
  };
  if (pace) {
    cdp.on("Network.loadingFinished", ({ requestId }) => finish(requestId));
    cdp.on("Network.loadingFailed", ({ requestId }) => finish(requestId));
    disconnected?.addEventListener(
      "abort",
      () => {
        for (const id of pending.keys()) finish(id);
      },
      { once: true },
    );
  }
  cdp.on("Fetch.requestPaused", (event) => {
    void (async () => {
      const main =
        event.frameId === frameTree.frame.id &&
        (!pace || event.resourceType === "Document");
      const networkId = event.networkId;
      const controller = new AbortController();
      if (pace && networkId) {
        // Redirects reuse the Network request ID and complete the previous hop.
        finish(networkId);
        pending.set(networkId, controller);
      }
      let release: (() => void) | undefined;
      try {
        const url = main
          ? await validatePublicUrl(event.request.url)
          : new URL(event.request.url);
        if (pace && (url.protocol === "https:" || url.protocol === "http:")) {
          disconnected?.throwIfAborted();
          controller.signal.throwIfAborted();
          release = await pace(url.hostname, controller.signal);
          if (networkId) {
            if (controller.signal.aborted) {
              release();
              return;
            }
            controller.signal.addEventListener("abort", release, {
              once: true,
            });
          }
        }
        await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
      } catch (error) {
        const cancelled = controller.signal.aborted || disconnected?.aborted;
        if (networkId && pending.get(networkId) === controller)
          finish(networkId);
        if (cancelled) return;
        if (main) blocked = safeError(error);
        await cdp.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "BlockedByClient",
        });
      } finally {
        if (!networkId) release?.();
      }
    })().catch(() => console.error("Browser navigation interception failed."));
  });
  if (onDocumentResponse) {
    cdp.on("Network.responseReceived", ({ frameId, type, response }) => {
      if (frameId === frameTree.frame.id && type === "Document") {
        const mitigated = Object.entries(response.headers).some(
          ([name, value]) =>
            name.toLowerCase() === "cf-mitigated" && value === "challenge",
        );
        onDocumentResponse(response.status, mitigated);
      }
    });
  }
  if (onDocumentResponse || pace) await cdp.send("Network.enable");
  // A separate CDP session keeps Playwright's own request interception disabled.
  await cdp.send("Fetch.enable", {
    patterns: pace ? [{}] : [{ resourceType: "Document" }],
  });
  return () => {
    const error = blocked;
    blocked = undefined;
    return error;
  };
}

export function documentResponseState() {
  let status: number | undefined;
  let mitigated = false;
  return {
    get status() {
      return status;
    },
    get mitigated() {
      return mitigated;
    },
    observe(nextStatus: number, challenge: boolean) {
      status = nextStatus;
      mitigated = challenge;
    },
    prepare(current: string, target: URL) {
      const from = new URL(current);
      const to = new URL(target);
      const differentUrl = from.href !== to.href;
      from.hash = to.hash = "";
      // Fragment-only changes keep the current document and get no response.
      if (differentUrl && from.href === to.href) return false;
      status = undefined;
      mitigated = false;
      return true;
    },
  };
}
