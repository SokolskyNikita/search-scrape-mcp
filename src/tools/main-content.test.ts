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

test("a Reddit video thread without text returns its title as fallback", async () => {
  const url = new URL(
    "https://www.reddit.com/r/OcarinaOfTime/comments/1xq0ejr/",
  );
  // Reduced from the saved response. The raw DOM lacks post and comment text.
  const title = "Speedrunners dream. New glitch found by ZFG";
  const result = await mainContent(
    `<html><head><title>Reddit - The heart of the internet</title></head><body>
      <main>
        <shreddit-post post-title="${title}">
          <h1 slot="title">${title}</h1>
          <shreddit-player slot="post-media-container"></shreddit-player>
        </shreddit-post>
      </main>
    </body></html>`,
    url,
    url,
    200,
    "text/html",
    true,
  );
  assert.equal(result.markdown, "");
  assert.equal(result.check.code, "extraction_failed");
  assert.equal(result.extractionCause, "unusable_output");
  assert.equal(result.fallbackText, title);
});

test("main extraction omits navigation and complementary landmarks outside main content", async () => {
  const url = new URL("https://example.com/forum/topic");
  const directory = `<ul>
    <li><a href="/first">Global directory first section</a></li>
    <li><a href="/second">Global directory second section</a></li>
    <li><a href="/third">Global directory third section</a></li>
  </ul>`;
  const { markdown, check } = await mainContent(
    `<html><head><title>Community thread</title></head><body><div>
      <article><nav>${directory}</nav></article>
      <div role="navigation">${directory}</div>
      <main><h1>Community thread</h1><div>
        <p>The first contribution includes enough prose to establish the topic.</p>
        <p>The second contribution answers the question with additional context.</p>
      </div></main>
      <aside role="complementary"><p>Unrelated sidebar and list of contacts.</p></aside>
    </div></body></html>`,
    url,
    url,
    200,
    "text/html",
    true,
  );
  assert.equal(check.code, "ok");
  assert.match(markdown, /first contribution/);
  assert.match(markdown, /second contribution/);
  assert.doesNotMatch(markdown, /Global directory|Unrelated sidebar/);
});

test("broken JSON-LD is dropped quietly while valid schema data still reaches Defuddle", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const url = new URL("https://example.com/article");
  const { markdown, check } = await mainContent(
    `<!doctype html><html><head><title>Fixture article</title>
      <script type="application/ld+json">{"@type": "Article", "author": {"name": "Ada</script>
      <script type="application/ld+json">{"@type": "Article", "headline": "Fixture article", "author": {"@type": "Person", "name": "Grace Hopper"}}</script>
    </head><body><main><article><h1>Fixture article</h1>
      <p>This article body has enough words to count as real content for the extractor to keep.</p>
      <p>A second paragraph keeps the page from looking empty or like a navigation menu.</p>
    </article></main></body></html>`,
    url,
    url,
    200,
    "text/html",
    true,
  );
  assert.equal(check.code, "ok");
  assert.match(markdown, /second paragraph/);
  assert.equal(errors.mock.callCount(), 0);
});
