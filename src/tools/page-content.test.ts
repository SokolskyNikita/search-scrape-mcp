import assert from "node:assert/strict";
import { test } from "node:test";
import { pageContent } from "./page-content.js";

test("page checker bounds content and classifies challenge, block and empty pages", () => {
  assert.equal(
    pageContent("  # Example\r\n\r\n\r\nHello  "),
    "# Example\n\nHello",
  );
  assert(pageContent("a".repeat(100), { limit: 40 }).length <= 40);
  assert.throws(() => pageContent("# Just a moment…", { status: 403 }), {
    code: "challenge",
  });
  assert.throws(() => pageContent("Denied", { status: 429 }), {
    code: "blocked",
  });
  assert.throws(() => pageContent("Oops", { status: 404 }), {
    code: "target_http",
  });
  assert.throws(() => pageContent("\n \t"), { code: "empty_page" });
  assert.equal(
    pageContent("# CAPTCHA guide\n\nHow to use a CAPTCHA."),
    "# CAPTCHA guide\n\nHow to use a CAPTCHA.",
  );
});

test("ordinary headings do not look like blocks or challenges", () => {
  for (const heading of [
    "Security check for your repo",
    "Access denied errors explained",
    "Just a moment of reflection",
  ]) {
    assert.equal(
      pageContent(`# ${heading}\n\nArticle body`),
      `# ${heading}\n\nArticle body`,
    );
  }
});
