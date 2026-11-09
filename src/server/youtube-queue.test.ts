import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "../config/tuning.js";
import { YouTubeQueue, type YouTubeProgress } from "./youtube-queue.js";

test("YouTube queue estimates mixed jobs, dispatches FIFO, and rests after exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const queue = new YouTubeQueue(defaults);
  const signal = new AbortController().signal;
  const started: string[] = [];
  let finish!: () => void;
  const active = queue.enqueue(true, signal, 270_000, () => {
    started.push("active");
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  now = 10_000;
  const metadata = queue.enqueue(false, signal, 280_000, async () => {
    started.push("metadata");
  });
  let eta: YouTubeProgress | undefined;
  const transcript = queue.enqueue(
    true,
    signal,
    280_000,
    async () => {
      started.push("transcript");
    },
    (update) => {
      eta = update;
    },
  );
  assert.deepEqual(eta, { ahead: 2, startMs: 28_000, resultMs: 48_000 });

  finish();
  await active;
  await Promise.resolve();
  assert.deepEqual(started, ["active"]);
  now += 5_000;
  t.mock.timers.tick(5_000);
  await metadata;
  await Promise.resolve();
  assert.deepEqual(started, ["active", "metadata"]);
  now += 5_000;
  t.mock.timers.tick(5_000);
  await transcript;
  assert.deepEqual(started, ["active", "metadata", "transcript"]);
});

test("YouTube queue honors a longer Retry-After and rejects jobs that cannot fit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const queue = new YouTubeQueue(defaults);
  const signal = new AbortController().signal;
  assert.doesNotThrow(() => queue.coolDown(9e15));
  queue.coolDown(150_000);
  await assert.rejects(
    queue.enqueue(true, signal, 160_000, async () =>
      assert.fail("Must not dispatch"),
    ),
    { code: "local_rate_limit" },
  );
  let eta: YouTubeProgress | undefined;
  const queued = queue.enqueue(
    false,
    signal,
    270_000,
    async () => "ok",
    (update) => {
      eta = update;
    },
  );
  assert.deepEqual(eta, { ahead: 0, startMs: 150_000, resultMs: 158_000 });
  now = 150_000;
  t.mock.timers.tick(150_000);
  assert.equal(await queued, "ok");
});

test("aborting a waiting YouTube job removes it from the ETA", async () => {
  const queue = new YouTubeQueue(defaults);
  const activeController = new AbortController();
  let finish!: () => void;
  const active = queue.enqueue(
    true,
    activeController.signal,
    Infinity,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const canceled = new AbortController();
  const first = queue.enqueue(false, canceled.signal, Infinity, async () =>
    assert.fail("Must not dispatch"),
  );
  const follower = new AbortController();
  let ahead: number | undefined;
  const second = queue.enqueue(
    true,
    follower.signal,
    Infinity,
    async () => assert.fail("Must not dispatch"),
    (update) => {
      ahead = update.ahead;
    },
  );
  assert.equal(ahead, 2);
  canceled.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(ahead, 1);
  follower.abort();
  await assert.rejects(second, { name: "AbortError" });
  finish();
  await active;
});
