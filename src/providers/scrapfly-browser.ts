import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  type Browser,
  type ConnectOverCDPTransport,
} from "playwright-core";
import { AppError } from "../server/error.js";
import { validatePublicUrl } from "../server/target.js";
import { pageContent } from "../tools/page-content.js";
import { watchCaptcha } from "./browser-captcha.js";
import { guardNavigations } from "./browser-navigation.js";
import { scrapflyTransport } from "./scrapfly-browser-transport.js";
import type {
  BrowserProvider,
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
        "Scrapfly Cloud Browser timed out.",
      );
    }),
  ]).finally(() => controller.abort());
}

export function scrapflyBrowser(key: string): BrowserProvider {
  return {
    async open() {
      const endpoint = new URL("wss://browser.scrapfly.io");
      endpoint.searchParams.set("key", key);
      endpoint.searchParams.set("timeout", "1800");
      endpoint.searchParams.set("auto_close", "true");
      endpoint.searchParams.set("solve_captcha", "true");

      let transport: ConnectOverCDPTransport | undefined;
      let browser: Browser | undefined;
      let closing: Promise<void> | undefined;
      function close(): Promise<void> {
        return (closing ??= (async () => {
          try {
            if (browser?.isConnected()) await within(browser.close(), 3_000);
          } catch {
            console.error("Could not close Scrapfly Cloud Browser connection.");
          } finally {
            transport?.close();
          }
        })());
      }

      try {
        transport = await scrapflyTransport(endpoint);
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
            const navigationError = await guardNavigations(cdp);
            const captcha = watchCaptcha(cdp, page);
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
            let lastStatus: number | undefined;
            let mitigated = false;
            page.on("response", (response) => {
              const request = response.request();
              if (
                request.isNavigationRequest() &&
                request.frame() === page.mainFrame()
              ) {
                lastStatus = response.status();
                mitigated = response.headers()["cf-mitigated"] === "challenge";
              }
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

            let generation = 0;
            const refs = new Map<string, string>();
            page.on("framenavigated", (frame) => {
              if (frame === page.mainFrame()) refs.clear();
            });

            function locator(target: BrowserTarget) {
              if (target.selector) return page.locator(target.selector);
              const ref = target.ref && refs.get(target.ref);
              if (!ref)
                throw new AppError(
                  "browser_ref",
                  "Unknown or stale element ref. Take a fresh snapshot.",
                );
              return page.getByRef(ref);
            }

            async function snapshot(): Promise<string> {
              if (page.url() === "about:blank")
                throw new AppError(
                  "empty_page",
                  "The browser is on a blank page.",
                );
              await content();
              const tree = (
                await page.ariaSnapshot({ mode: "ai", timeout: actionTimeout })
              )
                .split("\n")
                .filter(
                  (line) =>
                    !/^\s*- (?:generic|group|separator):?\s*$/.test(line),
                )
                .join("\n");
              refs.clear();
              const version = ++generation;
              const snapshot = pageContent(
                tree.replace(
                  /\[ref=(e\d+)\]/g,
                  (_, ref: string) => `[ref=s${version}-${ref}]`,
                ),
              );
              for (const match of snapshot.matchAll(/\[ref=(s\d+-(e\d+))\]/g)) {
                if (match[1] && match[2]) refs.set(match[1], match[2]);
              }
              return snapshot;
            }

            async function content(fullPage = false): Promise<string> {
              await validatePublicUrl(page.url());
              const title = (await page.title()).slice(0, 512);
              const body = await page
                .locator("body")
                .evaluate(
                  (element, cap) =>
                    (element as HTMLElement).innerText.slice(0, cap + 1),
                  fullPage ? 2_000_000 : 16_000,
                  { timeout: actionTimeout },
                );
              if (fullPage && body.length > 2_000_000)
                throw new AppError(
                  "page_size",
                  "Browser page exceeds 2 million characters.",
                );
              const readable = pageContent(body, {
                title,
                status: lastStatus,
                limit: fullPage ? Infinity : 16_000,
              });
              return pageContent(
                title ? `# ${title}\n\n${readable}` : readable,
                { limit: fullPage ? Infinity : 12_000 },
              );
            }

            return {
              async run(action, fullPage) {
                navigationError();
                try {
                  if (isClosed()) throw closedError();
                  if (action.action === "navigate") {
                    const target = await validatePublicUrl(action.url);
                    lastStatus = undefined;
                    mitigated = false;
                    captcha.reset();
                    await page.goto(target.href, {
                      waitUntil: "domcontentloaded",
                    });
                    await captcha.wait(() => mitigated);
                    return await within(content(fullPage), actionTimeout);
                  }
                  if (action.action === "back") {
                    lastStatus = undefined;
                    mitigated = false;
                    captcha.reset();
                    await page.goBack({ waitUntil: "domcontentloaded" });
                    await captcha.wait(() => mitigated);
                  }
                  if (action.action === "click") await locator(action).click();
                  if (action.action === "fill")
                    await locator(action).fill(action.text);
                  if (action.action === "press")
                    await locator(action).press(action.key);
                  if (action.action === "scroll")
                    await page.mouse.wheel(0, action.pixels);
                  if (action.action === "wait") {
                    if (action.selector)
                      await page
                        .locator(action.selector)
                        .waitFor({ timeout: Math.max(1, action.ms) });
                    else await delay(action.ms);
                  }
                  if (action.action === "screenshot") {
                    await content();
                    const image = await page.screenshot({
                      type: "jpeg",
                      quality: 65,
                      timeout: actionTimeout,
                    });
                    if (image.byteLength > 1_000_000)
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
                  return await within(snapshot(), actionTimeout);
                } catch (error) {
                  if (isClosed()) throw closedError();
                  const blocked = navigationError();
                  if (blocked) throw blocked;
                  if (error instanceof AppError) throw error;
                  throw new AppError(
                    "browser_action",
                    "Scrapfly Cloud Browser action failed or timed out.",
                  );
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
      }
    },
  };
}

export function browserScraper(provider: BrowserProvider): ScrapeProvider {
  return {
    async scrape(url) {
      const target = await validatePublicUrl(url);
      const session = await provider.open();
      try {
        const result = await session.run(
          { action: "navigate", url: target.href },
          true,
        );
        if (typeof result !== "string")
          throw new AppError("internal", "Expected browser page text.");
        return result;
      } finally {
        await session.close();
      }
    },
  };
}
