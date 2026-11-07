import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "../config/tuning.js";
import { AppError } from "../server/error.js";
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
  const result = toolResult(
    "fixture",
    (_, deadline) => {
      signal = deadline;
      return new Promise(() => {});
    },
    { ...defaults, toolDeadlineSeconds: 32 },
  );
  t.mock.timers.tick(32_000);
  const response = await result;
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /32-second deadline/);
  assert.equal(signal?.aborted, true);
});

test("same-host batch items wait while other hosts can proceed", async () => {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const inputs = ["same/1", "same/2", "other/3"];
  const results = batch(
    inputs,
    async (item) => {
      started.push(item);
      await new Promise<void>((resolve) => finish.set(item, resolve));
      return item;
    },
    (item) => item.split("/")[0],
  );
  assert.deepEqual(started, ["same/1", "other/3"]);
  finish.get("other/3")!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["same/1", "other/3"]);
  finish.get("same/1")!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["same/1", "other/3", "same/2"]);
  finish.get("same/2")!();
  assert.deepEqual(
    await results,
    inputs.map((result, index) => ({ index, result })),
  );
});

test("batch items log independent outcomes and the returned batch is successful", async (t) => {
  const logger = t.mock.method(console, "log", () => {});
  const tool = "test_batch";
  await toolResult(tool, (attempt) =>
    batch(
      [true, false],
      async (ok, recordAttempt) => {
        recordAttempt("fixture");
        if (!ok) throw new AppError("fixture_error", "Fixture failed.");
        return "ok";
      },
      undefined,
      { tool, attempt, settings: defaults },
    ),
  );
  const records = logger.mock.calls.map(({ arguments: [line] }) =>
    JSON.parse(String(line)),
  );
  assert.deepEqual(
    records.map(({ itemIndex, ok, attempts, errorCode }) => [
      itemIndex,
      ok,
      attempts,
      errorCode,
    ]),
    [
      [0, true, 1, null],
      [1, false, 1, "fixture_error"],
      [undefined, true, 2, null],
    ],
  );
});
