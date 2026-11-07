import assert from "node:assert/strict";
import { test } from "node:test";
import { serper } from "./serper.js";
import { defaults } from "../config/tuning.js";
import { RequestLimits } from "../server/request-limits.js";

test("Serper surfaces a rejected query without sending a hedge", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { statusCode: 400, message: "Missing query" },
      { status: 400 },
    ),
  );
  await assert.rejects(serper("fixture").search({ query: "", limit: 1 }), {
    code: "provider_http",
    message: "Serper returned HTTP 400.",
  });
  assert.equal(request.mock.callCount(), 1);
});

test("Serper hedges transient failures and keeps the first usable answer", async (t) => {
  const logger = t.mock.method(console, "log", () => {});
  let calls = 0;
  const request = t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return Response.json({ credits: 0 }, { status: 503 });
    return Response.json({
      credits: 1,
      organic: [{ title: "Backup", link: "https://example.com" }],
    });
  });
  let retries = 0;
  const result = await serper("fixture").search(
    { query: "fixture", limit: 1 },
    undefined,
    () => {
      retries++;
    },
  );
  assert.equal(result[0]?.title, "Backup");
  assert.equal(retries, 1);
  assert.equal(request.mock.callCount(), 2);
  const logged = logger.mock.calls.map(({ arguments: [line] }) =>
    JSON.parse(String(line)),
  );
  assert.equal(logged[1]?.hedgeTrigger, "failure");
  assert.deepEqual(
    logged.map(({ rung, credits }) => [rung, credits]),
    [
      ["primary", 0],
      ["hedge", 1],
    ],
  );
});

test("Serper sends locale and operators, filters subdomains, and preserves dates", async (t) => {
  const request = t.mock.method(
    globalThis,
    "fetch",
    async (_url: URL, init: RequestInit) => {
      assert.deepEqual(JSON.parse(String(init.body)), {
        q: "release site:example.com -site:spam.test",
        num: 3,
        gl: "us",
        hl: "en",
        tbs: "qdr:w",
      });
      return Response.json({
        credits: 1,
        organic: [
          { title: "Blocked", link: "https://blog.spam.test/path" },
          {
            title: "Valid",
            link: "https://example.com/path",
            date: "Nov 1, 2026",
          },
          { title: "Different hostname", link: "https://notspam.test/path" },
        ],
      });
    },
  );
  const results = await serper("fixture").search({
    query: "release",
    limit: 3,
    site: "example.com",
    exclude_domains: ["spam.test"],
    recency: "week",
  });
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(
    results.map(({ title, date }) => [title, date]),
    [
      ["Valid", "Nov 1, 2026"],
      ["Different hostname", undefined],
    ],
  );
});

test("a transient failure cannot send a hedge past the shared provider rate", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () =>
    Response.json({}, { status: 503 }),
  );
  const settings = { ...defaults, localLimitWaitMs: 0, serperBurstCapacity: 1 };
  const limits = new RequestLimits(settings);
  await assert.rejects(
    serper("fixture", settings, limits).search({ query: "fixture", limit: 1 }),
    {
      code: "local_rate_limit",
    },
  );
  assert.equal(request.mock.callCount(), 1);
});
