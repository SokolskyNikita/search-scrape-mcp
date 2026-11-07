import { setTimeout as delay } from "node:timers/promises";
import type { CDPSession, Page } from "playwright-core";
import { AppError } from "../server/error.js";
import { pageContent } from "../tools/page-content.js";

export function watchCaptcha(cdp: CDPSession, page: Page) {
  const pending = new Set<string>();
  let failed = false;
  let solved = false;
  cdp.on("event", ({ method, params }) => {
    const id = (params as { detectionId?: string } | undefined)?.detectionId;
    if (!id) return;
    if (
      method === "Antibot.captchaDetected" ||
      method === "Antibot.captchaSolvingStarted"
    )
      pending.add(id);
    if (method === "Antibot.captchaSolved") {
      pending.delete(id);
      solved = true;
    }
    if (method === "Antibot.captchaError") {
      pending.delete(id);
      failed = true;
    }
  });

  return {
    reset() {
      pending.clear();
      failed = solved = false;
    },
    async wait(challenged: () => boolean, signal?: AbortSignal) {
      const deadline = Date.now() + 24_000;
      // Detection and widget attachment can lag DOMContentLoaded.
      await delay(650, undefined, { signal });
      while (Date.now() < deadline) {
        let view;
        try {
          view = await page.evaluate(() => ({
            title: document.title,
            lead: document.body?.innerText.slice(0, 2200) ?? "",
            widget: Array.from(document.querySelectorAll("iframe")).some(
              (frame) =>
                /challenges\.cloudflare\.com|\/recaptcha\/(?:api2|enterprise)\/|hcaptcha\.com/.test(
                  frame.src,
                ) && frame.getBoundingClientRect().height > 0,
            ),
            answered: Array.from(
              document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
                '[name="cf-turnstile-response"], [name="g-recaptcha-response"], [name="h-captcha-response"]',
              ),
            ).some((input) => Boolean(input.value)),
          }));
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/execution context|navigation/i.test(error.message)
          )
            throw error;
        }
        if (failed)
          throw new AppError(
            "challenge",
            "Scrapfly reported a CAPTCHA solve failure.",
          );
        if (
          view &&
          !pending.size &&
          (!view.widget || solved || view.answered)
        ) {
          try {
            pageContent(view.lead, { title: view.title });
            return;
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== "challenge")
              return;
          }
        }
        await delay(350, undefined, { signal });
      }
      throw new AppError(
        "challenge_timeout",
        "CAPTCHA did not clear within the browser tool deadline.",
      );
    },
  };
}
