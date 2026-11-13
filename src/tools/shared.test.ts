import { messages } from "../config/messages.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "../config/tuning.js";
import { AppError } from "../server/error.js";
import { writeProviderAttempt } from "../server/stats.js";
import { batch, toolResult } from "./shared.js";

test("batch starts every item at once and keeps original ordering", async () => {
  const started: number[] = [];
  const finish: (() => void)[] = [];
  const result = batch([0, 1, 2], async (index) => {
    started.push(index);
    await new Promise<void>((resolve) => {
      finish[index] = resolve;
    });
    return index;
  });
  assert.deepEqual(started, [0, 1, 2]);
  finish[1]!();
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
  assert(JSON.stringify(response.content).includes(messages.service.timeout));
  assert.equal(signal?.aborted, true);
});

test("a client that cancels stops the work and is logged with the credits spent", async (t) => {
  const rows: Record<string, unknown>[] = [];
  t.mock.method(console, "log", (line: string) => {
    rows.push(JSON.parse(line) as Record<string, unknown>);
  });
  const client = new AbortController();
  let work: AbortSignal | undefined;
  const result = toolResult(
    "fixture",
    (_, signal) => {
      work = signal;
      writeProviderAttempt({
        provider: "scrapfly",
        rung: "render",
        credits: 30,
        durationMs: 1,
        errorCode: null,
      });
      queueMicrotask(() => client.abort());
      return new Promise(() => {});
    },
    defaults,
    { signal: client.signal },
  );
  const response = await result;
  assert.equal(response.isError, true);
  assert(JSON.stringify(response.content).includes(messages.service.cancelled));
  assert.equal(work?.aborted, true);
  const row = rows.find(({ tool, event }) => tool === "fixture" && !event);
  assert.equal(row?.errorCode, "client_cancelled");
  assert.equal(row?.creditsSpent, 30);
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

test("a scrape batch deadline returns successes and item errors for work still pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started: number[] = [];
  const result = toolResult(
    "scrape_batch",
    (_, signal) =>
      batch(
        [0, 1, 2, 3],
        async (index) => {
          started.push(index);
          if (index === 0) return "completed";
          if (index === 1) throw new AppError("fixture_error", "Item failed.");
          return new Promise(() => {});
        },
        () => "same-host",
        undefined,
        signal,
      ),
    defaults,
    {
      partialOnTimeout: true,
      presentation: {
        operation: messages.operation.scrape,
        targets: ["first", "second", "third", "fourth"],
      },
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(defaults.toolDeadlineSeconds * 1_000);
  const response = await result;
  assert.equal(response.isError, undefined);
  assert.deepEqual(started, [0, 1, 2]);
  const itemContent = response.content[0];
  assert(itemContent?.type === "text");
  const items = (response.structuredContent as { items: unknown[] }).items;
  assert(response.content[2]?.type === "text");
  assert(response.content[2].text.includes(messages.service.batchTimeout));
  assert.deepEqual(
    (
      items as { index: number; result?: string; error?: { code: string } }[]
    ).map(
      ({
        index,
        result,
        error,
      }: {
        index: number;
        result?: string;
        error?: { code: string };
      }) => [index, result ?? error?.code],
    ),
    [
      [0, "completed"],
      [1, "fixture_error"],
      [2, "tool_timeout"],
      [3, "tool_timeout"],
    ],
  );
});
