import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  type Browser,
  type ConnectOverCDPTransport,
} from "playwright-core";
import { AppError } from "../server/error.js";
import { validatePublicUrl } from "../server/target.js";
import { pageContent } from "../tools/page-content.js";
import { scrapflyTransport } from "./scrapfly-browser-transport.js";
import type { BrowserProvider, ScrapeProvider } from "./types.js";

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
      endpoint.searchParams.set("timeout", "300");
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
            // Routing enables Chromium Fetch interception. The transport checks
            // every intercepted URL before allowing the request to continue.
            await context.route("**/*", (route) => route.continue());
            await context.routeWebSocket("**/*", (socket) => socket.close());
            const page = context.pages()[0] ?? (await context.newPage());
            const cdp = await context.newCDPSession(page);
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
            page.on("response", (response) => {
              const request = response.request();
              if (
                request.isNavigationRequest() &&
                request.frame() === page.mainFrame()
              ) {
                lastStatus = response.status();
              }
            });

            function isClosed(): boolean {
              return !!closing || !browser?.isConnected() || page.isClosed();
            }

            function closedError(): AppError {
              return new AppError(
                "browser_closed",
                "Browser session is closed.",
              );
            }

            async function snapshot(): Promise<string> {
              if (page.url() === "about:blank")
                throw new AppError(
                  "empty_page",
                  "The browser is on a blank page.",
                );
              await content();
              const tree = (await page.ariaSnapshot({ timeout: actionTimeout }))
                .split("\n")
                .filter(
                  (line) =>
                    !/^\s*- (?:generic|group|separator):?\s*$/.test(line),
                )
                .join("\n");
              return pageContent(tree);
            }

            async function content(): Promise<string> {
              await validatePublicUrl(page.url());
              const title = (await page.title()).slice(0, 512);
              const body = await page
                .locator("body")
                .evaluate(
                  (element) =>
                    (element as HTMLElement).innerText.slice(0, 16_000),
                  undefined,
                  { timeout: actionTimeout },
                );
              const readable = pageContent(body, {
                title,
                status: lastStatus,
                limit: 16_000,
              });
              return pageContent(
                title ? `# ${title}\n\n${readable}` : readable,
              );
            }

            return {
              async run(action) {
                try {
                  if (isClosed()) throw closedError();
                  if (action.action === "navigate") {
                    const target = await validatePublicUrl(action.url);
                    lastStatus = undefined;
                    await page.goto(target.href, {
                      waitUntil: "domcontentloaded",
                    });
                    return await within(content(), actionTimeout);
                  }
                  if (action.action === "click")
                    await page.locator(action.selector).click();
                  if (action.action === "fill")
                    await page.locator(action.selector).fill(action.text);
                  if (action.action === "press")
                    await page.locator(action.selector).press(action.key);
                  return await within(snapshot(), actionTimeout);
                } catch (error) {
                  if (isClosed()) throw closedError();
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
        return await session.run({ action: "navigate", url: target.href });
      } finally {
        await session.close();
      }
    },
  };
}
