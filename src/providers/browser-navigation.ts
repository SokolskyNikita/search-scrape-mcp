import type { CDPSession } from "playwright-core";
import { safeError } from "../server/error.js";
import { validatePublicUrl } from "../server/target.js";

export async function guardNavigations(
  cdp: CDPSession,
  onDocumentResponse?: (status: number, mitigated: boolean) => void,
) {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  let blocked: ReturnType<typeof safeError> | undefined;
  cdp.on("Fetch.requestPaused", (event) => {
    void (async () => {
      if (event.frameId === frameTree.frame.id) {
        try {
          await validatePublicUrl(event.request.url);
        } catch (error) {
          blocked = safeError(error);
          await cdp.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient",
          });
          return;
        }
      }
      await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
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
    await cdp.send("Network.enable");
  }
  // A separate CDP session keeps Playwright's own request interception disabled.
  await cdp.send("Fetch.enable", { patterns: [{ resourceType: "Document" }] });
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
