import { setTimeout as delay } from "node:timers/promises";
import type { CDPSession, Page } from "playwright-core";
import { defaults } from "../config/tuning.js";
import { AppError } from "../server/error.js";
import {
  CHALLENGE_TEXT_CHARS,
  isChallengeUrl,
  looksChallenged,
} from "../tools/page-check.js";

const pollMs = 350;

export function watchCaptcha(
  cdp: CDPSession,
  page: Page,
  waitMs = defaults.captchaWaitMs,
) {
  // Scrapium extends CDP beyond Playwright's standard protocol types.
  const send = cdp.send.bind(cdp) as (
    command: "Antibot.captchaEnable" | "Antibot.captchaDisable",
  ) => Promise<unknown>;
  let failed = false;
  cdp.on("event", ({ method }) => {
    if (method === "Antibot.captchaError") failed = true;
    if (method === "Antibot.captchaSolved") failed = false;
  });

  return {
    reset() {
      failed = false;
    },
    async wait(mitigated: () => boolean, signal?: AbortSignal) {
      const deadline = performance.now() + waitMs;
      let enabled = false;
      try {
        for (;;) {
          signal?.throwIfAborted();
          const url = page.url();
          if (
            !mitigated() &&
            !(URL.canParse(url) && isChallengeUrl(new URL(url)))
          ) {
            try {
              const view = await page.evaluate(
                (cap) => ({
                  title: document.title,
                  text: document.body?.innerText.slice(0, cap) ?? "",
                  hasFormFields: !!document.querySelector(
                    'form :is(textarea, input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="tel"])',
                  ),
                }),
                CHALLENGE_TEXT_CHARS + 1,
              );
              if (
                !looksChallenged(
                  view.hasFormFields ? "" : view.text,
                  view.title,
                )
              )
                return;
            } catch (error) {
              if (
                !(error instanceof Error) ||
                !/execution context|navigation/i.test(error.message)
              )
                throw error;
              // The challenge can clear by navigating away during the check.
            }
          }
          if (failed)
            throw new AppError(
              "challenge",
              "Scrapfly reported a CAPTCHA solve failure.",
            );
          const remaining = deadline - performance.now();
          if (remaining <= 0)
            throw new AppError(
              "challenge_timeout",
              "CAPTCHA did not clear within the browser challenge wait.",
            );
          if (!enabled) {
            await send("Antibot.captchaEnable");
            enabled = true;
          }
          await delay(Math.min(pollMs, remaining), undefined, { signal });
        }
      } finally {
        if (enabled && !signal?.aborted) {
          try {
            await send("Antibot.captchaDisable");
          } catch {
            throw new AppError(
              "captcha_control",
              "Could not disable the CAPTCHA solver.",
            );
          }
        }
      }
    },
  };
}
