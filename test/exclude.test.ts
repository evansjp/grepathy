import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureBlock, removeBlock, infoExcludePath, EXCLUDE_FENCE } from "../src/util/exclude.js";

function tmpFile(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-excl-"));
  const f = path.join(dir, "target");
  if (contents !== undefined) fs.writeFileSync(f, contents);
  return f;
}

function occurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

test("ensureBlock creates the file with a fenced block when absent", () => {
  const f = tmpFile();
  ensureBlock(f, EXCLUDE_FENCE, [".ai/", "CLAUDE.local.md"]);
  const out = fs.readFileSync(f, "utf8");
  assert.ok(out.includes(EXCLUDE_FENCE.begin));
  assert.ok(out.includes(EXCLUDE_FENCE.end));
  assert.ok(out.includes(".ai/"));
  assert.ok(out.includes("CLAUDE.local.md"));
});

test("ensureBlock is idempotent — one block after repeated calls", () => {
  const f = tmpFile();
  ensureBlock(f, EXCLUDE_FENCE, [".ai/"]);
  ensureBlock(f, EXCLUDE_FENCE, [".ai/"]);
  const out = fs.readFileSync(f, "utf8");
  assert.equal(occurrences(out, EXCLUDE_FENCE.begin), 1);
});

test("ensureBlock refreshes an existing block's body in place", () => {
  const f = tmpFile();
  ensureBlock(f, EXCLUDE_FENCE, ["old-line"]);
  ensureBlock(f, EXCLUDE_FENCE, ["new-line"]);
  const out = fs.readFileSync(f, "utf8");
  assert.ok(out.includes("new-line"));
  assert.ok(!out.includes("old-line"));
  assert.equal(occurrences(out, EXCLUDE_FENCE.begin), 1);
});

test("ensureBlock preserves pre-existing content when appending", () => {
  const f = tmpFile("# git default exclude comment\n");
  ensureBlock(f, EXCLUDE_FENCE, [".ai/"]);
  const out = fs.readFileSync(f, "utf8");
  assert.ok(out.includes("# git default exclude comment"));
  assert.ok(out.includes(".ai/"));
});

test("removeBlock strips the block but keeps surrounding content", () => {
  const f = tmpFile("# keep me\n");
  ensureBlock(f, EXCLUDE_FENCE, [".ai/"]);
  removeBlock(f, EXCLUDE_FENCE);
  const out = fs.readFileSync(f, "utf8");
  assert.ok(out.includes("# keep me"));
  assert.ok(!out.includes(EXCLUDE_FENCE.begin));
  assert.ok(!out.includes(".ai/"));
});

test("removeBlock deletes the file when nothing else remains", () => {
  const f = tmpFile();
  ensureBlock(f, EXCLUDE_FENCE, [".ai/"]);
  removeBlock(f, EXCLUDE_FENCE);
  assert.ok(!fs.existsSync(f));
});

test("removeBlock is a no-op on a file without the block", () => {
  const f = tmpFile("unrelated\n");
  removeBlock(f, EXCLUDE_FENCE); // must not throw
  assert.equal(fs.readFileSync(f, "utf8"), "unrelated\n");
});

test("infoExcludePath resolves to the repo's private exclude file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-gitpath-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const p = infoExcludePath(dir);
  assert.ok(p, "returns a path inside a git repo");
  assert.ok(p!.endsWith(path.join("info", "exclude")));
});
