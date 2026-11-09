import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestLimits } from "../server/request-limits.js";
import type { BrowserLease, Usage } from "../server/usage.js";
import { defaults } from "../config/tuning.js";
import {
  MAX_BROWSER_PAGE_CHARS,
  MAX_BROWSER_IMAGE_BYTES,
} from "../config/safety-limits.js";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser } from "playwright-core";
import { AppError } from "../server/error.js";
import { validatePublicUrl } from "../server/target.js";
import { checkPage } from "../tools/page-check.js";
import { cleanPage } from "../tools/page-content.js";
import { browserInputs } from "./browser-input.js";
import { browserSnapshots } from "./browser-snapshot.js";
import { browserActionError } from "./browser-action-error.js";
import { watchCaptcha } from "./browser-captcha.js";
import {
  guardNavigations,
  documentResponseState,
  goBack,
} from "./browser-navigation.js";
import { scrapflyTransport } from "./scrapfly-browser-transport.js";
import type {
  BrowserProvider,
  BrowserSession,
  BrowserTarget,
  ScrapeProvider,
} from "./types.js";

const actionTimeout = 15_000;

function within<T>(operation: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  return Promise.race([
    operation,
    delay(ms, undefined, { signal: controller.signal }).then(() => {
      throw new AppError(
        "browser_timeout",
        `Scrapfly Cloud Browser timed out after ${ms} ms.`,
      );
    }),
  ]).finally(() => controller.abort());
}

export function scrapflyBrowser(
  key: string,
  settings = defaults,
  limits?: RequestLimits,
  usage?: Usage,
): BrowserProvider {
  const provider = {
    name: "scrapfly",
    async open(
      signal?: AbortSignal,
      target?: URL,
      lease?: BrowserLease,
    ): Promise<BrowserSession> {
      const endpoint = new URL("wss://browser.scrapfly.io");
      endpoint.searchParams.set("api_key", key);
      if (target) {
        const routingUrl = new URL(target);
        routingUrl.hash = "";
        endpoint.searchParams.set("target_url", routingUrl.href);
      }
      endpoint.searchParams.set(
        "timeout",
        String(lease?.seconds ?? settings.browserSessionSeconds),
      );
      endpoint.searchParams.set("auto_close", "true");
      endpoint.searchParams.set("solve_captcha", "false");

      let transport: Awaited<ReturnType<typeof scrapflyTransport>> | undefined;
      const disconnected = new AbortController();
      const opening = lease
        ? AbortSignal.any([lease.signal, ...(signal ? [signal] : [])])
        : signal;
      const expired = () => transport?.terminate();
      const onClosed = () => {
        disconnected.abort();
        lease?.signal.removeEventListener("abort", expired);
        lease?.release();
      };
      let navigationContext = AsyncLocalStorage.snapshot();
      let navigationSignal = opening;
      let navigationDeadline = performance.now() + actionTimeout;
      let browser: Browser | undefined;
      let closing: Promise<void> | undefined;
      function close(): Promise<void> {
        return (closing ??= (async () => {
          try {
            if (browser?.isConnected()) await within(browser.close(), 3_000);
          } catch {
            console.error("Could not close Scrapfly Cloud Browser connection.");
          } finally {
            transport?.terminate();
          }
        })());
      }

      const abort = () => transport?.close();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        transport = await scrapflyTransport(endpoint, opening, onClosed);
        lease?.signal.addEventListener("abort", expired, { once: true });
        lease?.signal.throwIfAborted();
        browser = await chromium.connectOverCDP(transport, {
          timeout: 8_000,
          noDefaults: true,
        });

        return await within(
          (async () => {
            // Scrapfly allocates one fresh default context per WebSocket session.
            const context = browser!.contexts()[0];
            if (!context)
              throw new AppError(
                "browser_connect",
                "Scrapfly returned no browser context.",
              );
            const page = context.pages()[0] ?? (await context.newPage());
            const cdp = await context.newCDPSession(page);
            const captcha = watchCaptcha(cdp, page, settings.captchaWaitMs);
            const documentResponse = documentResponseState();
            const navigationError = await guardNavigations(
              cdp,
              (status, challenge) => {
                captcha.reset();
                documentResponse.observe(status, challenge);
              },
              limits &&
                ((hostname, requestSignal) =>
                  navigationContext(() =>
                    limits.acquire(
                      AbortSignal.any([
                        requestSignal,
                        ...(navigationSignal ? [navigationSignal] : []),
                      ]),
                      navigationDeadline,
                      undefined,
                      hostname,
                    ),
                  )),
              disconnected.signal,
            );
            await page.routeWebSocket("**/*", async (socket) => {
              try {
                await validatePublicUrl(socket.url().replace(/^ws/, "http"));
              } catch {
                socket.close();
                return;
              }
              socket.connectToServer();
            });
            await cdp.send("Network.setBypassServiceWorker", { bypass: true });
            page.on("download", (download) => {
              void download
                .cancel()
                .catch(() =>
                  console.error("Could not cancel a remote download."),
                );
            });
            page.setDefaultTimeout(actionTimeout);
            context.on("page", (popup) => {
              void popup
                .close()
                .catch(() =>
                  console.error("Could not close a remote browser popup."),
                );
            });

            function isClosed(): boolean {
              return !!closing || !browser?.isConnected() || page.isClosed();
            }

            function closedError(): AppError {
              return new AppError(
                "browser_closed",
                "Browser session expired or disconnected. Navigate again to start a new session.",
              );
            }

            const snapshots = browserSnapshots(page);
            const inputs = browserInputs(page);
            function locator(target: BrowserTarget) {
              return target.selector
                ? page.locator(target.selector)
                : snapshots.locator(target.ref);
            }

            async function content() {
              const location = page.url();
              const url = await validatePublicUrl(location);
              const title = await page.title();
              const body = await page
                .locator("body")
                .evaluate(
                  (element, cap) =>
                    (element as HTMLElement).innerText.slice(0, cap + 1),
                  MAX_BROWSER_PAGE_CHARS,
                  { timeout: actionTimeout },
                );
              if (body.length > MAX_BROWSER_PAGE_CHARS)
                throw new AppError(
                  "page_size",
                  "Browser page exceeds 2 million characters.",
                );
              if (page.url() !== location)
                throw new AppError(
                  "browser_navigation",
                  "The browser page changed while reading its content.",
                );
              if (documentResponse.status === undefined)
                throw new AppError(
                  "browser_navigation",
                  "The browser did not report the document’s response status.",
                );
              return {
                url,
                status: documentResponse.status,
                title,
                text: cleanPage(body),
              };
            }

            return {
              currentUrl: () => page.url(),
              async run(action, runSignal) {
                runSignal?.throwIfAborted();
                runSignal?.addEventListener("abort", abort, { once: true });
                navigationError();
                navigationContext = AsyncLocalStorage.snapshot();
                navigationSignal = runSignal;
                navigationDeadline = performance.now() + actionTimeout;
                try {
                  if (isClosed()) throw closedError();
                  if (action.action === "navigate") {
                    const target = await validatePublicUrl(action.url);
                    if (documentResponse.prepare(page.url(), target))
                      captcha.reset();
                    const response = await page.goto(target.href, {
                      waitUntil: "domcontentloaded",
                    });
                    if (documentResponse.status === undefined && response)
                      documentResponse.observe(
                        response.status(),
                        response.headers()["cf-mitigated"] === "challenge",
                      );
                    await captcha.wait(
                      () => documentResponse.mitigated,
                      runSignal,
                    );
                    return await within(content(), actionTimeout);
                  }
                  if (action.action === "back") {
                    await goBack(page);
                    await captcha.wait(
                      () => documentResponse.mitigated,
                      runSignal,
                    );
                  }
                  if (action.action === "click") await locator(action).click();
                  if (action.action === "fill")
                    await inputs.fill(locator(action), action.text, action.ref);
                  if (action.action === "press")
                    await inputs.press(locator(action), action.key, action.ref);
                  if (action.action === "scroll") {
                    await page.mouse.wheel(0, action.pixels);
                    await within(
                      page.evaluate(
                        () =>
                          new Promise<void>((resolve) =>
                            requestAnimationFrame(() =>
                              requestAnimationFrame(() => resolve()),
                            ),
                          ),
                      ),
                      actionTimeout,
                    );
                  }
                  if (action.action === "wait") {
                    if (action.selector)
                      await page
                        .locator(action.selector)
                        .waitFor({ timeout: Math.max(1, action.ms) });
                    else
                      await delay(action.ms, undefined, { signal: runSignal });
                  }
                  if (action.action === "screenshot") {
                    await validatePublicUrl(page.url());
                    const image = await page.screenshot({
                      type: "jpeg",
                      quality: 65,
                      timeout: actionTimeout,
                    });
                    if (image.byteLength > MAX_BROWSER_IMAGE_BYTES)
                      throw new AppError(
                        "image_size",
                        "Viewport screenshot exceeds 1 MB.",
                      );
                    return {
                      type: "image",
                      mimeType: "image/jpeg",
                      data: image.toString("base64"),
                    };
                  }
                  if (page.url() === "about:blank")
                    throw new AppError(
                      "empty_page",
                      "The browser is on a blank page.",
                    );
                  await validatePublicUrl(page.url());
                  return await within(
                    snapshots.read(
                      action.action === "snapshot" || action.action === "find"
                        ? action
                        : undefined,
                    ),
                    actionTimeout,
                  );
                } catch (error) {
                  if (
                    error instanceof AppError &&
                    error.code === "captcha_control"
                  ) {
                    await close();
                    throw new AppError("browser_closed", error.message);
                  }
                  if (isClosed()) throw closedError();
                  const blocked = navigationError();
                  if (blocked) throw blocked;
                  if (error instanceof AppError) throw error;
                  throw browserActionError(error, action.action);
                } finally {
                  runSignal?.removeEventListener("abort", abort);
                  navigationSignal = undefined;
                  navigationDeadline = Infinity;
                }
              },
              close,
            };
          })(),
          12_000,
        );
      } catch (error) {
        await close();
        if (error instanceof AppError) throw error;
        throw new AppError(
          "browser_connect",
          browser
            ? "Could not initialize an isolated Scrapfly browser page."
            : "Could not attach Playwright to the Scrapfly browser.",
        );
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
  if (!usage) return provider;
  return {
    name: provider.name,
    open(signal, target) {
      signal?.throwIfAborted();
      return usage.open(
        (lease) => provider.open(signal, target, lease),
        signal,
      );
    },
  };
}

export function browserScraper(provider: BrowserProvider): ScrapeProvider {
  return {
    name: "scrapfly-browser",
    async scrape(url, signal, options) {
      options?.tried.push("browser");
      const target = await validatePublicUrl(url);
      const session = await provider.open(signal, target);
      try {
        const result = await session.run(
          { action: "navigate", url: target.href },
          signal,
        );
        if (typeof result === "string" || !("url" in result))
          throw new AppError(
            "internal",
            "Expected browser navigation details.",
          );
        const { url: final, status, title, text } = result;
        const markdown = title ? `# ${title}\n\n${text}` : text;
        const check = checkPage(markdown, target, final, status);
        if (check.code !== "ok" && !check.warning)
          throw new AppError(check.code, check.reason);
        return { markdown, check, finalUrl: final.href };
      } finally {
        await session.close();
      }
    },
  };
}
