import assert from "node:assert/strict";
import { test } from "node:test";
import type { CDPSession, Page } from "playwright-core";
import { watchCaptcha } from "./browser-captcha.js";

test("CAPTCHA wait follows terminal events for a visible widget", async () => {
  let handle: (event: {
    method: string;
    params: { detectionId: string };
  }) => void = () => assert.fail("Missing CAPTCHA event listener");
  const cdp = {
    on(_event: string, listener: typeof handle) {
      handle = listener;
    },
  } as unknown as CDPSession;
  const page = {
    async evaluate() {
      return {
        title: "Fixture",
        lead: "Readable body",
        widget: true,
        answered: false,
      };
    },
  } as unknown as Page;
  const captcha = watchCaptcha(cdp, page);
  const params = { detectionId: "fixture" };
  handle({ method: "Antibot.captchaDetected", params });
  const waiting = captcha.wait(() => false);
  handle({ method: "Antibot.captchaError", params });
  await assert.rejects(waiting, { code: "challenge" });

  captcha.reset();
  handle({ method: "Antibot.captchaDetected", params });
  const solved = captcha.wait(() => false);
  handle({ method: "Antibot.captchaSolved", params });
  await solved;
});
