import assert from "node:assert/strict";
import { test } from "node:test";
import { serper } from "./serper.js";

test("Serper hedges transient failures and keeps the first usable answer", async (t) => {
  let calls = 0;
  const request = t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return new Response("", { status: 503 });
    return Response.json({
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
});
