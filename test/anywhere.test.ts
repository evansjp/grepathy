import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parsePushedBranches } from "../src/commands/hook.js";
import { acquireLock } from "../src/util/fsx.js";
import { DEFAULT_CONFIG } from "../src/util/config.js";

test("parsePushedBranches extracts branch names from git's pre-push stdin", () => {
  const stdin = [
    "refs/heads/main abc123 refs/heads/main def456",
    "refs/heads/feature-x aaa111 refs/heads/feature-x bbb222",
  ].join("\n");
  assert.deepEqual(parsePushedBranches(stdin).sort(), ["feature-x", "main"]);
});

test("parsePushedBranches skips branch deletions (all-zero local sha)", () => {
  const stdin = "refs/heads/gone 0000000000000000000000000000000000000000 refs/heads/gone abc123";
  assert.deepEqual(parsePushedBranches(stdin), []);
});

test("parsePushedBranches ignores tag/other refs and empty input", () => {
  assert.deepEqual(parsePushedBranches("refs/tags/v1 abc refs/tags/v1 def"), []);
  assert.deepEqual(parsePushedBranches(""), []);
});

test("acquireLock is exclusive and releasable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-lock-"));
  const lock = path.join(dir, "sub", "sess.lock");

  const release1 = acquireLock(lock);
  assert.ok(release1, "first acquire succeeds");
  assert.equal(acquireLock(lock), null, "second acquire is blocked while held");

  release1!();
  const release2 = acquireLock(lock);
  assert.ok(release2, "acquire succeeds again after release");
  release2!();

  fs.rmSync(dir, { recursive: true, force: true });
});

test("acquireLock reclaims a stale lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-lock-"));
  const lock = path.join(dir, "sess.lock");
  fs.writeFileSync(lock, "99999 0"); // pretend-held by a dead process
  // Backdate its mtime well past the stale window.
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old);

  const release = acquireLock(lock, 60_000); // 1-min stale threshold
  assert.ok(release, "a lock older than staleMs is reclaimed");
  release!();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auto-distill is on by default with a generous debounce", () => {
  assert.equal(DEFAULT_CONFIG.autoDistill.enabled, true);
  assert.ok(DEFAULT_CONFIG.autoDistill.minIntervalMs >= 60_000, "at least a minute between background distills");
  assert.ok(DEFAULT_CONFIG.autoDistill.minGrowthBytes >= 4096, "meaningful growth required before firing");
});
