import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test, type TestContext } from "node:test";
import { OutputFiles } from "./output-files.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "search-scrape-output-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const directory = join(root, "output");
  return { directory, files: new OutputFiles(directory), root };
}

test("overflow saves complete Markdown with a short preview, counts, and a safe-use hint", (t) => {
  const { directory, files } = fixture(t);
  files.cleanup();
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(files.spill("short", 5), undefined);

  rmSync(directory, { recursive: true });
  const markdown = "😀 heading\n".repeat(80) + "Last line";
  const result = files.spill(markdown, 30);
  assert(result);
  assert(isAbsolute(result.path));
  assert.equal(dirname(result.path), directory);
  assert.match(result.path, /page-[a-f0-9-]{36}\.md$/);
  assert.equal(statSync(result.path).mode & 0o777, 0o600);
  assert.equal(readFileSync(result.path, "utf8"), markdown);
  assert.equal(
    result.preview,
    Array.from(markdown).slice(0, 600).join("").trimEnd(),
  );
  assert.equal(result.characters, Array.from(markdown).length);
  assert.equal(result.approxTokens, Math.ceil(result.characters / 4));
  assert.equal(result.lines, 81);
  assert.match(
    result.hint,
    /read or search.*file tools.*untrusted web content/i,
  );
});

test("spill refuses a symlink or an insecure output folder", (t) => {
  const { directory, files, root } = fixture(t);
  const target = join(root, "target");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, directory);
  assert.throws(() => files.spill("content", 1), { code: "output_directory" });
  rmSync(directory);
  mkdirSync(directory, { mode: 0o755 });
  assert.throws(() => files.cleanup(), { code: "output_directory" });
});

test("cleanup expires old spills and evicts the oldest file to make room", (t) => {
  const { files } = fixture(t);
  const expired = files.spill("expired", 1)!;
  const oldest = files.spill("oldest", 1)!;
  const newest = files.spill("newest", 1)!;
  const past = (hours: number) => new Date(Date.now() - hours * 60 * 60_000);
  utimesSync(expired.path, past(5), past(5));
  files.cleanup();
  assert(!existsSync(expired.path));
  truncateSync(oldest.path, 64 * 1024 * 1024);
  utimesSync(oldest.path, past(1), past(1));
  const saved = files.spill("fresh", 1)!;
  assert(!existsSync(oldest.path));
  assert(existsSync(newest.path));
  assert(existsSync(saved.path));
});

test("binary files have private permissions and share spill retention", (t) => {
  const { files } = fixture(t);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const saved = files.saveBinary({ bytes, mimeType: "image/jpeg" });
  assert.match(saved.path, /\.jpg$/);
  assert.equal(saved.bytes, bytes.length);
  assert.deepEqual(readFileSync(saved.path), bytes);
  assert.equal(statSync(saved.path).mode & 0o777, 0o600);
  const expired = new Date(Date.now() - 5 * 60 * 60_000);
  utimesSync(saved.path, expired, expired);
  files.cleanup();
  assert(!existsSync(saved.path));
});
