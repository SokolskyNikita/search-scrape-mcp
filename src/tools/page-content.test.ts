import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPage, pageContent } from "./page-content.js";

test("page checker cleans content and classifies challenge, block and empty pages", () => {
  assert.equal(
    pageContent("  # Example\r\n\r\n\r\nHello  "),
    "# Example\n\nHello",
  );
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

test("Markdown cleanup removes image markup, redundant titles and empty definitions outside code", () => {
  const content = [
    "![](https://example.com/picture_(1).png)",
    '[Anthropic](https://example.com/Anthropic "Anthropic")',
    '[Reference](https://example.com/ref "Additional context")',
    "[^20]:",
    "[^21]:",
    "    A continuation is a real definition.",
    "4 Likes",
    "```md",
    "![](example.png)",
    "[^22]:",
    "```",
  ].join("\n");
  assert.equal(
    cleanPage(content),
    [
      "[Anthropic](https://example.com/Anthropic)",
      '[Reference](https://example.com/ref "Additional context")',
      "",
      "[^21]:",
      "    A continuation is a real definition.",
      "",
      "```md",
      "![](example.png)",
      "[^22]:",
      "```",
    ].join("\n"),
  );
});
