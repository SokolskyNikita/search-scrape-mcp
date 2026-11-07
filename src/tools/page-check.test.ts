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
    ["sign_in", "# Sign in\nEmail\nPassword", page, 200, undefined],
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
    "# Account help\nPassword and sign in assistance is available.",
    "# Working notes\nUse three spaces here",
    `# Rendered content\n${article}\nEnable JavaScript to run this app.`,
    `# Security check for your repo\n${(article + " The documentation discusses why sites ask you to sign in and verify you are human.\n").repeat(18)}`,
  ];
  for (const markdown of cases)
    assert.equal(checkPage(markdown, page, page, 200).code, "ok");
  const index = new URL("/category/news", page);
  assert.equal(checkPage(menu, index, index, 200).code, "ok");
});

test("short navigation shells are distinguished from a legitimate short page", () => {
  const shell =
    "# Quotes to Scrape\n[Quotes to Scrape](https://example.com/)\n[Login](https://example.com/login)\n[Next →](https://example.com/page/2)\nQuotes by [GoodReads](https://example.com/quotes)\nMade with love by [Zyte](https://example.com/about)";
  assert.equal(checkPage(shell, page, page, 200).code, "menus_only");
});

test("a newsletter prompt inside a full article does not mark it as paywalled", () => {
  const paragraphs = (article + "\n").repeat(25);
  const markdown = `# Full article\n${paragraphs}Subscribe to our newsletter and read the latest updates.\n${paragraphs}`;
  assert.equal(checkPage(markdown, page, page, 200).code, "ok");
});

test("only redirects to the same site's home page count as moved content", () => {
  assert.equal(
    checkPage(article, page, new URL("https://www.example.com/"), 200).code,
    "content_moved",
  );
  assert.equal(
    checkPage(article, page, new URL("https://example.org/"), 200).code,
    "ok",
  );
});

test("branded soft 404 and login titles classify the document", () => {
  const missing = new URL("https://www.spotify.com/in-en/missing/");
  assert.equal(
    checkPage(
      "Page not found - Spotify\n\n# Error code 404\n\nTry going back.",
      missing,
      missing,
      200,
    ).code,
    "not_found",
  );
  for (const heading of [
    "Página não encontrada — Spotify",
    "ページが見つかりません-Spotify",
    "ไม่พบหน้านี้ - Spotify",
    "No fue posible encontrar página - Spotify",
  ])
    assert.equal(
      checkPage(`${heading}\n\n# Try going back`, missing, missing, 200).code,
      "not_found",
    );
  const login = new URL("https://github.com/login");
  assert.equal(
    checkPage(
      "Sign in to GitHub · GitHub\n\n# Sign in to GitHub\n\nUsername and password.",
      login,
      login,
      200,
    ).code,
    "sign_in",
  );
});

test("explicit consent and membership screens survive lengthy site chrome", () => {
  const url = new URL("https://example.com/article");
  const chrome = "Navigation label and surrounding page chrome.\n".repeat(130);
  const consent = `Before you continue to Example Search\n\n${chrome}\nIf you choose to “Accept all,” we will use cookies and data. If you choose to “Reject all,” we will skip those purposes.`;
  assert.equal(checkPage(consent, url, url, 200).code, "consent");
  assert.equal(
    checkPage(
      `Member-only story\n\n# Article preview\n\n${chrome}`,
      url,
      url,
      200,
    ).code,
    "paywall",
  );
});
