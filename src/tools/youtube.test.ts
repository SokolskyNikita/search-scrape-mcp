import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { once } from "node:events";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttp } from "../server/http.js";
import type { YouTubeProvider } from "../providers/types.js";
import { OutputFiles } from "./output-files.js";
import { registerScrape } from "./scrape.js";
import { youtubeTool } from "./youtube.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("YouTube normalizes URLs, keeps metadata and transcript cache entries distinct, and tries another provider", async (t) => {
  const calls: [string, string, boolean][] = [];
  const canceledVideo = "aaaaaaaaaaa";
  const providerCanceled = latch();
  let cancellationCalls = 0;
  const fixture: YouTubeProvider = {
    name: "first",
    async fetch(id, transcript, signal, _deadline, notify) {
      notify?.({ ahead: 1, startMs: 15_000, resultMs: 23_000 });
      if (id === canceledVideo) {
        cancellationCalls++;
        return new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              providerCanceled.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      calls.push(["first", id, transcript]);
      return {
        url: `https://www.youtube.com/watch?v=${id}`,
        title: "Fixture",
        ...(transcript ? { transcript: { status: "no_captions" } } : {}),
      };
    },
  };
  const register = youtubeTool(
    [
      fixture,
      {
        name: "second",
        async fetch(id, transcript) {
          calls.push(["second", id, transcript]);
          return {
            url: `https://www.youtube.com/watch?v=${id}`,
            title: "Fixture",
            transcript: {
              status: "ok",
              language: "ja",
              kind: "automatic",
              translated: false,
              segments: [
                { start_seconds: 1, text: "テスト" },
                { start_seconds: 2, text: "Outside range" },
              ],
            },
          };
        },
      },
    ],
    new OutputFiles(),
  );
  const token = "a".repeat(40);
  const server = createMcpHttp(token, (mcp) => {
    register(mcp);
  });
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  async function connect() {
    const client = new Client({ name: "fixture", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    t.after(() => client.close());
    return client;
  }
  const first = await connect();
  const second = await connect();
  const updates: (string | undefined)[] = [];
  async function call(client: Client, args: Record<string, unknown>) {
    const response = await client.callTool(
      {
        name: "youtube",
        arguments: args,
      },
      undefined,
      { onprogress: (update) => updates.push(update.message) },
    );
    assert(!response.isError);
    assert(response.structuredContent);
    assert(Array.isArray(response.content));
    const body = response.content[0];
    assert(body?.type === "text");
    if (args.transcript) assert.match(body.text, /テスト/);
    else assert.match(body.text, /Fixture/);
    return response.structuredContent as {
      cached: boolean;
      cached_at?: string;
      transcript?: { language: string; segments: { text: string }[] };
    };
  }

  const short = "https://youtu.be/0yIfx7JlkiM?t=10";
  const watch = "https://www.youtube.com/watch?v=0yIfx7JlkiM";
  assert.equal((await call(first, { url: short })).transcript, undefined);
  assert.match(updates[0] ?? "", /Estimated start in 15s, result in 23s/);
  const metadataHit = await call(second, { url: watch });
  assert.equal(metadataHit.cached, true);
  assert(metadataHit.cached_at);
  assert.equal(
    (await call(second, { url: watch, transcript: true })).transcript?.language,
    "ja",
  );
  assert.equal(
    (await call(first, { url: short, transcript: true })).cached,
    true,
  );
  assert.equal(
    (await call(first, { url: short, transcript: true, fresh: true })).cached,
    false,
  );
  assert.equal((await call(second, { url: watch })).transcript, undefined);
  const excerpt = await call(second, {
    url: short,
    transcript: true,
    start_seconds: 1,
    end_seconds: 2,
  });
  assert.equal(excerpt.cached, true);
  assert.deepEqual(excerpt.transcript?.segments, [
    { start_seconds: 1, text: "テスト" },
  ]);
  for (const alias of [
    "https://www.youtube.com/live/0yIfx7JlkiM",
    "https://music.youtube.com/watch?v=0yIfx7JlkiM",
    "https://youtube.com/embed/0yIfx7JlkiM",
  ]) {
    assert.equal((await call(first, { url: alias })).cached, true);
  }
  const invalidRange = await first.callTool({
    name: "youtube",
    arguments: { url: short, end_seconds: 2 },
  });
  assert.equal(invalidRange.isError, true);
  const rejected = await first.callTool({
    name: "youtube",
    arguments: { url: "https://youtube.com.example/watch?v=0yIfx7JlkiM" },
  });
  assert.equal(rejected.isError, true);
  assert.deepEqual(calls, [
    ["first", "0yIfx7JlkiM", false],
    ["first", "0yIfx7JlkiM", true],
    ["second", "0yIfx7JlkiM", true],
    ["first", "0yIfx7JlkiM", true],
    ["second", "0yIfx7JlkiM", true],
  ]);

  // Two callers share the pending provider work. Only the last cancellation
  // should abort it.
  const requests = [first, second].map((client) => {
    const controller = new AbortController();
    const progress = latch();
    const result = client.callTool(
      {
        name: "youtube",
        arguments: { url: `https://youtu.be/${canceledVideo}` },
      },
      undefined,
      { signal: controller.signal, onprogress: () => progress.resolve() },
    );
    return { controller, progress: progress.promise, result };
  });
  await Promise.all(requests.map(({ progress }) => progress));
  assert.equal(cancellationCalls, 1);
  const one = requests[0]!;
  const two = requests[1]!;
  one.controller.abort();
  await assert.rejects(one.result);
  const pending = Symbol("pending");
  assert.equal(
    await Promise.race([providerCanceled.promise, Promise.resolve(pending)]),
    pending,
  );
  two.controller.abort();
  await assert.rejects(two.result);
  await providerCanceled.promise;

  // The desktop relay must forward progress under the downstream token.
  const dir = mkdtempSync(join(tmpdir(), "youtube-relay-"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ token, port: address.port }), {
    mode: 0o600,
  });
  const relay = new Client({ name: "relay-fixture", version: "1" });
  t.after(async () => {
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await relay.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../server/desktop-relay.js", import.meta.url)),
      ],
      env: { MCP_CONFIG: config },
    }),
  );
  updates.length = 0;
  await call(relay, { url: short, fresh: true });
  await relay.close();
  assert.match(updates[0] ?? "", /Estimated start in 15s, result in 23s/);
});

test("YouTube links route away from both scrape tools and missing captions suggest another video", async (t) => {
  const files = new OutputFiles();
  const register = youtubeTool(
    [
      {
        name: "fixture",
        async fetch(id) {
          return {
            url: `https://www.youtube.com/watch?v=${id}`,
            transcript: { status: "no_captions" },
          };
        },
      },
    ],
    files,
  );
  const token = "b".repeat(40);
  const server = createMcpHttp(token, (mcp) => {
    register(mcp);
    registerScrape(mcp, [], files);
  });
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const client = new Client({ name: "youtube-routing-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    ),
  );
  t.after(() => client.close());

  const url = "https://youtu.be/0yIfx7JlkiM";
  const scrape = await client.callTool({ name: "scrape", arguments: { url } });
  assert.equal(scrape.isError, true);
  assert.match(JSON.stringify(scrape.content), /Use the youtube tool/);
  const channel = await client.callTool({
    name: "scrape",
    arguments: { url: "https://www.youtube.com/@example" },
  });
  assert.equal(channel.isError, true);
  assert.match(
    JSON.stringify(channel.content),
    /Use browser for this YouTube page/,
  );
  const batch = await client.callTool({
    name: "scrape_batch",
    arguments: { urls: ["https://www.youtube.com/watch?v=0yIfx7JlkiM"] },
  });
  assert.match(JSON.stringify(batch.structuredContent), /Use the youtube tool/);
  const youtube = await client.callTool({
    name: "youtube",
    arguments: { url, transcript: true },
  });
  assert.equal(
    (youtube.structuredContent as { note?: string } | undefined)?.note,
    "No transcript was retrieved. Try a different video if you need captions.",
  );
  assert.match(JSON.stringify(youtube.content), /Try a different video/);
});
