import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPage } from "./page-check.js";

const page = new URL("https://example.com/articles/notes");
const article =
  "The guide describes how to set up reliable infrastructure for a small team. It explains why clear naming and stable documentation matter.";
const menu = Array.from(
  { length: 40 },
  (_, i) =>
    `- [Find resources and related articles for topic ${i}](https://example.com/topic/${i})`,
).join("\n");

test("recorded page shapes classify walls, completeness and retry strategy", () => {
  const cases = [
    [
      "challenge",
      "# Just a moment…\nVerify you are human.",
      page,
      403,
      "stronger",
    ],
    [
      "challenge",
      "# Request received",
      new URL("/captcha/verify", page),
      200,
      "stronger",
    ],
    [
      "challenge",
      `Verify you are human to continue. [Continue](https://example.com/${"x".repeat(4000)})`,
      page,
      200,
      "stronger",
    ],
    ["blocked", "# Access denied", page, 403, "stronger"],
    ["empty_page", "", page, 200, "render"],
    [
      "empty_page",
      "# App\nEnable JavaScript to run this app.",
      page,
      200,
      "render",
    ],
    ["menus_only", menu, page, 200, "stronger"],
    [
      "consent",
      "# Cookie preferences\nWe use cookies and personal data to improve your browsing experience.\nAccept all cookies",
      page,
      200,
      "stronger",
    ],
    ["not_found", "# Page not found\nTry our search.", page, 200, undefined],
    ["not_found", article, page, 404, undefined],
    [
      "sign_in",
      "# Welcome back\nEmail\nPassword\nSign in",
      page,
      200,
      undefined,
    ],
    [
      "sign_in",
      article,
      new URL("/login?return=article", page),
      200,
      undefined,
    ],
    ["content_moved", article, new URL("/", page), 200, undefined],
    [
      "paywall",
      `# Member article\n${article}\nSubscribe to continue reading.`,
      page,
      200,
      undefined,
    ],
  ] as const;
  for (const [code, markdown, final, status, next] of cases) {
    const check = checkPage(markdown, page, final, status);
    assert.equal(check.code, code, markdown.slice(0, 70));
    assert.equal(check.next, next);
    assert(check.reason);
    assert.equal(
      check.warning,
      code === "menus_only" || code === "paywall" ? true : undefined,
    );
  }
});

test("short, rendered and index pages and articles that mention walls pass", () => {
  const cases = [
    "# Contact\nEmail help@example.com.",
    "# Working notes\nUse three spaces here",
    `# Rendered content\n${article}\nEnable JavaScript to run this app.`,
    `# Security check for your repo\n${(article + " The documentation discusses why sites ask you to sign in and verify you are human.\n").repeat(18)}`,
  ];
  for (const markdown of cases)
    assert.equal(checkPage(markdown, page, page, 200).code, "ok");
  const index = new URL("/category/news", page);
  assert.equal(checkPage(menu, index, index, 200).code, "ok");
});
