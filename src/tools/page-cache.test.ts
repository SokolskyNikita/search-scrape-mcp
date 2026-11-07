import assert from "node:assert/strict";
import { test } from "node:test";
import { PageCache } from "./page-cache.js";

test("full page cache bounds memory and expires entries", (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const cache = new PageCache(10, 8, 2);
  const evicted = cache.put("12345");
  const kept = cache.put("a😀b");
  assert.throws(() => cache.get(evicted), { code: "page_expired" });
  const first = cache.read(kept, 0, 2);
  assert.equal(first.markdown, "a");
  assert.equal(first.nextOffset, 1);
  assert.equal(cache.read(kept, first.nextOffset, 8).markdown, "😀b");
  now += 10;
  assert.throws(() => cache.get(kept), { code: "page_expired" });
});
