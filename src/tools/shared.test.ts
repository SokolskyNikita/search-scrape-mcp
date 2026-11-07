import assert from "node:assert/strict";
import { test } from "node:test";
import { batch, toolResult } from "./shared.js";

test("batch runs two items at once and keeps original ordering", async () => {
  const started: number[] = [];
  const finish: (() => void)[] = [];
  const result = batch([0, 1, 2], async (index) => {
    started.push(index);
    await new Promise<void>((resolve) => {
      finish[index] = resolve;
    });
    return index;
  });
  assert.deepEqual(started, [0, 1]);
  finish[1]!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  finish[2]!();
  finish[0]!();
  assert.deepEqual(
    await result,
    [0, 1, 2].map((index) => ({ index, result: index })),
  );
});

test("deadline aborts provider work and returns a tool error before 60 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  const result = toolResult("fixture", (_, deadline) => {
    signal = deadline;
    return new Promise(() => {});
  });
  t.mock.timers.tick(54_000);
  const response = await result;
  assert.equal(response.isError, true);
  assert.equal(signal?.aborted, true);
});
