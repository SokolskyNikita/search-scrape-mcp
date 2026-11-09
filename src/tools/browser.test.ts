import { resultDivider } from "./result-format.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserAction, BrowserProvider } from "../providers/types.js";
import { OutputFiles } from "./output-files.js";
import { registerBrowser } from "./browser.js";

test("browser state and cleanup are isolated by MCP session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "browser-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = new OutputFiles(join(dir, "spills"));
  const page = "# Long page\n" + "page contents\n".repeat(2000).trimEnd();
  const snapshot = 'e2 link "example"\n'.repeat(1000).trimEnd();
  let opened = 0;
  const closed: number[] = [];
  const provider: BrowserProvider = {
    async open(_signal, target) {
      assert.equal(target?.href, "https://1.1.1.1/");
      const id = ++opened;
      return {
        currentUrl: () => "https://1.1.1.1/",
        async run(action) {
          if (action.action === "screenshot")
            return { type: "image", mimeType: "image/jpeg", data: "YQ==" };
          if (action.action === "snapshot")
            return {
              text: snapshot,
              warning: "One control is outside the viewport.",
            };
          if (action.action === "navigate" && action.url.endsWith("/long"))
            return page;
          return `Browser ${id}`;
        },
        async close() {
          closed.push(id);
        },
      };
    },
  };
  async function session() {
    const [upstream, downstream] = InMemoryTransport.createLinkedPair();
    const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
    const cleanup = registerBrowser(mcp, [provider], files);
    const client = new Client({ name: "fixture-client", version: "1.0.0" });
    await mcp.connect(upstream);
    await client.connect(downstream);
    return {
      call: async (command: BrowserAction) =>
        client.callTool({ name: "browser", arguments: { command } }),
      close: async () => {
        await client.close();
        await cleanup();
      },
    };
  }
  const a = await session();
  const b = await session();
  try {
    assert.equal(
      (await a.call({ action: "navigate", url: "http://127.0.0.1/" })).isError,
      true,
    );
    assert.equal(opened, 0);
    const github = await a.call({
      action: "navigate",
      url: "https://github.com/owner/repo",
    });
    assert.equal(github.isError, true);
    assert.match(JSON.stringify(github.content), /Use the GitHub CLI/);
    assert.equal(opened, 0);
    const command = { action: "navigate", url: "https://1.1.1.1/" } as const;
    assert.deepEqual((await a.call(command)).content, [
      {
        type: "text",
        text: `search-scrape-mcp · Browser navigate · https://1.1.1.1/\n\n${resultDivider}\n\nBrowser 1\n\n${resultDivider}`,
      },
    ]);
    assert.deepEqual((await b.call(command)).content, [
      {
        type: "text",
        text: `search-scrape-mcp · Browser navigate · https://1.1.1.1/\n\n${resultDivider}\n\nBrowser 2\n\n${resultDivider}`,
      },
    ]);
    for (const ref of ["e2", "f1e2"]) {
      for (const action of [
        { action: "click", ref },
        { action: "fill", ref, text: "example" },
        { action: "press", ref, key: "Enter" },
      ] as const) {
        assert.equal((await a.call(action)).isError, undefined);
      }
    }
    assert.equal(
      (await a.call({ action: "click", ref: "s1-e2" })).isError,
      true,
    );
    const screenshot = await a.call({ action: "screenshot" });
    assert.deepEqual(screenshot.content, [
      {
        type: "text",
        text: `search-scrape-mcp · Browser screenshot · https://1.1.1.1/\n\n${resultDivider}`,
      },
      { type: "image", mimeType: "image/jpeg", data: "YQ==" },
      { type: "text", text: resultDivider },
    ]);
    await a.call({ action: "close" });
    assert.deepEqual(closed, [1]);
    const actions = [
      { action: "navigate", url: "https://1.1.1.1/long" } as const,
      { action: "snapshot" } as const,
    ];
    for (const [index, action] of actions.entries()) {
      const response = await b.call(action);
      assert(Array.isArray(response.content));
      const result = response.structuredContent as Record<string, unknown>;
      assert.equal(
        readFileSync(result.path as string, "utf8"),
        index === 0 ? page : snapshot,
      );
    }
    t.mock.timers.tick(149_999);
    assert.deepEqual(closed, [1]);
    t.mock.timers.tick(1);
    assert.deepEqual(closed, [1, 2]);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
  assert.deepEqual(closed, [1, 2]);
});

test("browser marks access pages until a readable navigation", async (t) => {
  const mcp = new McpServer({ name: "access-test", version: "1.0.0" });
  const blocked = "https://1.1.1.1/blocked";
  const thread = "https://1.1.1.1/thread";
  const login = "https://1.1.1.1/login?next=/thread";
  const readable = "https://1.1.1.1/readable";
  let url = "about:blank";
  const cleanup = registerBrowser(
    mcp,
    [
      {
        async open() {
          return {
            currentUrl: () => url,
            async run(action) {
              if (action.action === "navigate") {
                url = action.url === thread ? login : action.url;
                return {
                  url: new URL(url),
                  status: url === blocked ? 403 : 200,
                  title: url === login ? "Localized account page" : "Example",
                  text: "Example text",
                };
              }
              if (action.action === "screenshot")
                return { type: "image", mimeType: "image/jpeg", data: "YQ==" };
              return {
                text: 'e1 link "Example"',
                warning: "One control is outside the viewport.",
              };
            },
            async close() {},
          };
        },
      },
    ],
    new OutputFiles(),
  );
  const [upstream, downstream] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "access-test", version: "1.0.0" });
  await mcp.connect(upstream);
  await client.connect(downstream);
  t.after(async () => {
    await cleanup();
    await client.close();
    await mcp.close();
  });
  async function call(command: BrowserAction) {
    const response = await client.callTool({
      name: "browser",
      arguments: { command },
    });
    assert(Array.isArray(response.content));
    return { response, text: response.content[0].text as string };
  }

  const denied = await call({ action: "navigate", url: blocked });
  assert.equal(denied.response.isError, true);
  assert.match(denied.text, /Error \(blocked\)/);

  url += "#details";
  const scroll = await call({ action: "scroll", pixels: 600 });
  assert.equal(scroll.response.isError, undefined);
  assert.match(
    scroll.text,
    /Warning: Target blocked access\..*This output shows the access page\. One control/,
  );
  assert(scroll.text.indexOf("Warning:") < scroll.text.indexOf(resultDivider));
  const screenshot = await call({ action: "screenshot" });
  assert.match(screenshot.text, /Warning: Target blocked access/);
  assert.equal(
    (screenshot.response.content as { type: string }[])[1]?.type,
    "image",
  );

  const redirected = await call({ action: "navigate", url: thread });
  assert.equal(redirected.response.isError, true);
  assert.match(redirected.text, /Error \(sign_in\): The site requires sign-in/);
  const snapshot = await call({ action: "snapshot" });
  assert.match(
    snapshot.text,
    /Warning: The site requires sign-in\. This output shows the access page/,
  );

  assert.equal(
    (await call({ action: "navigate", url: readable })).response.isError,
    undefined,
  );
  const recovered = await call({ action: "snapshot" });
  assert.match(recovered.text, /Warning: One control is outside the viewport/);
  assert.doesNotMatch(recovered.text, /blocked access|sign-in|access page/);
});
