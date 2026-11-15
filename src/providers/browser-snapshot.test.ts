import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { messages } from "../config/messages.js";
import { browserSnapshots } from "./browser-snapshot.js";

const box = { x: 0, y: 0, width: 100, height: 20 };

function fakePage(trees: () => unknown[]) {
  const handlers = new Map<string, ((frame: unknown) => void)[]>();
  const main = { name: "main" };
  let loads = 0;
  const page = {
    on(event: string, handler: (frame: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    mainFrame: () => main,
    ariaSnapshotJSON: async () => trees(),
    evaluate: async () => ({ x: 0, y: 0, width: 800, height: 600 }),
    waitForLoadState: async () => {
      loads++;
    },
    getByRef: (ref: string) => ({ ref }),
  };
  const emit = (event: string, frame: unknown) =>
    handlers.get(event)?.forEach((handler) => handler(frame));
  return {
    page: page as unknown as Page,
    main,
    emit,
    loads: () => loads,
  };
}

test("iframe navigations keep the snapshot and its refs", async () => {
  const fake: ReturnType<typeof fakePage> = fakePage(() => {
    // An ad iframe navigates while the tree is being read.
    fake.emit("framenavigated", { name: "ad" });
    return [{ role: "button", name: "Go", ref: "e1", box }];
  });
  const snapshots = browserSnapshots(fake.page);
  const { text } = await snapshots.read();
  assert.match(text, /^e1 button "Go"$/);
  assert.equal(fake.loads(), 0);
  fake.emit("framenavigated", { name: "ad" });
  assert.deepEqual(snapshots.locator("e1"), { ref: "e1" });
});

test("a main-frame navigation mid-read retries once on the new page", async () => {
  let calls = 0;
  const fake: ReturnType<typeof fakePage> = fakePage(() => {
    calls++;
    if (calls === 1) {
      fake.emit("framenavigated", fake.main);
      return [{ role: "button", name: "Old", ref: "e1", box }];
    }
    return [{ role: "button", name: "New", ref: "e2", box }];
  });
  const snapshots = browserSnapshots(fake.page);
  const { text } = await snapshots.read();
  assert.match(text, /New/);
  assert.equal(fake.loads(), 1);
  // Refs from the abandoned read are not kept.
  assert.throws(() => snapshots.locator("e1"), {
    message: messages.browser.staleRef,
  });
  assert.deepEqual(snapshots.locator("e2"), { ref: "e2" });
  fake.emit("framenavigated", fake.main);
  assert.throws(() => snapshots.locator("e2"), {
    message: messages.browser.staleRef,
  });
});

test("a page that keeps navigating still reports the change", async () => {
  const fake: ReturnType<typeof fakePage> = fakePage(() => {
    fake.emit("framenavigated", fake.main);
    return [{ role: "button", name: "Go", ref: "e1", box }];
  });
  await assert.rejects(browserSnapshots(fake.page).read(), {
    code: "browser_navigation",
    message: messages.browser.changed,
  });
});
