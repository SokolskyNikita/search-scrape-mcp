import assert from "node:assert/strict";
import { test } from "node:test";
import { mainContent } from "./main-content.js";

test("Reddit main content keeps organic feed posts and their links", async () => {
  const url = new URL("https://www.reddit.com/r/example/");
  const { markdown, check } = await mainContent(
    `<!doctype html><html><head><title>Example community</title></head><body>
      <main><h1>Example community</h1><shreddit-feed>
        <article><shreddit-post post-title="First post" permalink="/r/example/comments/one/">
          <div slot="text-body"><p>First post body with <a href="/details">details</a>.</p></div>
        </shreddit-post></article>
        <shreddit-ad-post><shreddit-post post-title="Sponsored title" permalink="/ad/">
          <div slot="text-body">Sponsored body.</div>
        </shreddit-post></shreddit-ad-post>
        <article><shreddit-post post-title="Second post" permalink="/r/example/comments/two/">
          <div slot="text-body"><p>Second post body with a different story.</p></div>
        </shreddit-post></article>
      </shreddit-feed></main>
      <aside><h2>Community Rules</h2><p>Sidebar details.</p></aside>
    </body></html>`,
    url,
    url,
    200,
    "text/html",
    true,
  );

  assert.equal(check.code, "ok");
  assert.ok(
    markdown.includes(
      "[First post](https://www.reddit.com/r/example/comments/one/)",
    ),
  );
  assert.ok(
    markdown.includes(
      "[Second post](https://www.reddit.com/r/example/comments/two/)",
    ),
  );
  assert.ok(markdown.includes("[details](https://www.reddit.com/details)"));
  assert.match(markdown, /Second post body/);
  assert.doesNotMatch(markdown, /Sponsored|Community Rules|Sidebar details/);
});

test("recovers a link post from its heading and a unique external destination", async () => {
  const url = new URL("https://example.com/posts/link");
  const source = "https://source.example/story?q=1&part=2";
  const extract = (extraLink = "") =>
    mainContent(
      `<!doctype html><html><head><title>Example site</title></head><body>
        <main><link-post>
          <h1>Local station publishes its forecast</h1>
          <a href="/users/reader">Reader</a>
          <a href="${source}"><img alt="" src="/card.png"></a>
          <a href="${source}"></a>
          ${extraLink}
        </link-post></main>
        <aside><a href="https://unrelated.example/">Unrelated link</a></aside>
      </body></html>`,
      url,
      url,
      200,
      "text/html",
      true,
    );
  const result = await extract();
  assert.equal(result.check.code, "ok");
  assert.equal(result.extractionCause, undefined);
  assert.equal(
    result.markdown,
    `# Local station publishes its forecast\n\n<${source}>`,
  );

  const ambiguous = await extract('<a href="https://other.example/story"></a>');
  assert(!ambiguous.markdown.includes(source));
  assert(!ambiguous.markdown.includes("https://other.example/story"));
});
