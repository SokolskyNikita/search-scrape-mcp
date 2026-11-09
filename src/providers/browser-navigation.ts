import type { CDPSession, Page } from "playwright-core";
import { safeError } from "../server/error.js";
import { validateBrowserUrl } from "../server/target.js";

export async function guardNavigations(
  cdp: CDPSession,
  onDocumentResponse?: (status: number | undefined, mitigated: boolean) => void,
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
      if (
        event.frameId !== frameTree.frame.id ||
        (event.resourceType && event.resourceType !== "Document")
      ) {
        await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
        return;
      }
      const networkId = event.networkId;
      const controller = new AbortController();
      if (pace && networkId) {
        // Redirects reuse the Network request ID and complete the previous hop.
        finish(networkId);
        pending.set(networkId, controller);
      }
      let release: (() => void) | undefined;
      try {
        const url = await validateBrowserUrl(event.request.url);
        if (pace) {
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
        blocked = safeError(error);
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
    const responses = new Map<string, [number, boolean]>();
    cdp.on(
      "Network.responseReceived",
      ({ frameId, type, response, loaderId }) => {
        if (frameId === frameTree.frame.id && type === "Document") {
          const mitigated = Object.entries(response.headers).some(
            ([name, value]) =>
              name.toLowerCase() === "cf-mitigated" && value === "challenge",
          );
          responses.set(loaderId, [response.status, mitigated]);
          if (responses.size > 32)
            responses.delete(responses.keys().next().value!);
          onDocumentResponse(response.status, mitigated);
        }
      },
    );
    cdp.on("Page.frameNavigated", ({ frame, type }) => {
      if (frame.id !== frameTree.frame.id || type !== "BackForwardCacheRestore")
        return;
      // A restored document has no new Network.responseReceived event.
      const response = responses.get(frame.loaderId);
      onDocumentResponse(response?.[0], response?.[1] ?? false);
    });
    await cdp.send("Page.enable");
  }
  if (onDocumentResponse || pace) await cdp.send("Network.enable");
  // A separate CDP session keeps Playwright's own request interception disabled.
  await cdp.send("Fetch.enable", {
    patterns: [{ resourceType: "Document" }],
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
    observe(nextStatus: number | undefined, challenge: boolean) {
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

export async function goBack(page: Page) {
  // A BFCache restore commits but does not fire DOMContentLoaded again.
  await page.goBack({ waitUntil: "commit" });
  await page.waitForFunction(() => document.readyState !== "loading");
}
