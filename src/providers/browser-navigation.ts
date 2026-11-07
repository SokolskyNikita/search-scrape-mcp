import type { CDPSession } from "playwright-core";
import { safeError } from "../server/error.js";
import { validatePublicUrl } from "../server/target.js";

export async function guardNavigations(cdp: CDPSession) {
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
  // A separate CDP session keeps Playwright's own request interception disabled.
  await cdp.send("Fetch.enable", { patterns: [{ resourceType: "Document" }] });
  return () => {
    const error = blocked;
    blocked = undefined;
    return error;
  };
}
