import assert from "node:assert/strict";
import { test } from "node:test";
import type { CDPSession, Page } from "playwright-core";
import { watchCaptcha } from "./browser-captcha.js";

test("CAPTCHA widget events on ordinary form pages do not block navigation", async () => {
  let handle: (event: { method: string }) => void = () =>
    assert.fail("Missing event listener");
  const cdp = {
    on(_event: string, listener: typeof handle) {
      handle = listener;
    },
  } as unknown as CDPSession;
  const page = {
    url: () => "https://example.com/contact",
    async evaluate() {
      return {
        title: "Contact",
        text: "Send a message. Verify you are human.",
        hasFormFields: true,
      };
    },
  } as unknown as Page;
  const captcha = watchCaptcha(cdp, page, 0);
  handle({ method: "Antibot.captchaDetected" });
  handle({ method: "Antibot.captchaError" });
  await captcha.wait(() => false);
  await assert.rejects(
    captcha.wait(() => true),
    { code: "challenge" },
  );
});

test("challenge titles and challenge URLs trigger the bounded wait", async () => {
  let title = "Just a moment…";
  let url = "https://example.com/article";
  const cdp = { on() {} } as unknown as CDPSession;
  const page = {
    url: () => url,
    async evaluate() {
      return { title, text: "Readable body" };
    },
  } as unknown as Page;
  const captcha = watchCaptcha(cdp, page, 0);
  await assert.rejects(
    captcha.wait(() => false),
    { code: "challenge_timeout" },
  );
  title = "Fixture";
  url = "https://example.com/cdn-cgi/challenge-platform/";
  await assert.rejects(
    captcha.wait(() => false),
    { code: "challenge_timeout" },
  );
  url = "https://example.com/article";
  await captcha.wait(() => false);
});
