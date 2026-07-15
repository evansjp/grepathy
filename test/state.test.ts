import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { grepathyPaths } from "../src/util/paths.js";
import { readState, writeSession, upsertSession, SessionRecord, StateFile } from "../src/state/state.js";
import { writeFileAtomic } from "../src/util/fsx.js";

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-state-"));
}

function rec(id: string): SessionRecord {
  return {
    tool: "claude-code",
    transcript_path: `/tmp/${id}.jsonl`,
    repo: "/repo",
    branches_seen: [id],
    files_touched: [],
    first_seen: "2026-07-08T00:00:00Z",
    last_seen: "2026-07-08T00:00:00Z",
    last_distilled_offset: 0,
    status: "dirty",
  };
}

test("per-session writes round-trip through readState", () => {
  const repo = tmpRepo();
  const paths = grepathyPaths(repo);
  writeSession(paths, "aaa", rec("aaa"));
  writeSession(paths, "bbb", rec("bbb"));
  const { state, corrupt } = readState(paths);
  assert.equal(corrupt, false);
  assert.deepEqual(Object.keys(state.sessions).sort(), ["aaa", "bbb"]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("two concurrent writers do not clobber each other's records", () => {
  const repo = tmpRepo();
  const paths = grepathyPaths(repo);
  // Simulate two sessions each reading state, then each writing only its own file.
  const a = readState(paths).state;
  const ra = upsertSession(a, "sessA", rec("sessA"), "2026-07-08T00:00:00Z");
  writeSession(paths, "sessA", ra);

  const b = readState(paths).state; // b sees sessA already
  const rb = upsertSession(b, "sessB", rec("sessB"), "2026-07-08T00:00:00Z");
  writeSession(paths, "sessB", rb);

  // A now advances its own session without knowing about B, and writes only A.
  ra.last_distilled_offset = 999;
  writeSession(paths, "sessA", ra);

  const final = readState(paths).state;
  assert.equal(final.sessions.sessA.last_distilled_offset, 999, "A's advance persisted");
  assert.ok(final.sessions.sessB, "B was not clobbered by A's write");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a corrupt per-session file is skipped, not fatal", () => {
  const repo = tmpRepo();
  const paths = grepathyPaths(repo);
  writeSession(paths, "good", rec("good"));
  fs.writeFileSync(path.join(paths.sessionsDir, "bad.json"), "{ not json");
  const { state, corrupt } = readState(paths);
  assert.equal(corrupt, true);
  assert.ok(state.sessions.good, "the good session still loads");
  assert.ok(!state.sessions.bad, "the corrupt one is skipped");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("legacy state.json is migrated to per-session files and removed", () => {
  const repo = tmpRepo();
  const paths = grepathyPaths(repo);
  const legacy: StateFile = { version: 1, sessions: { one: rec("one"), two: rec("two") } };
  writeFileAtomic(paths.stateFile, JSON.stringify(legacy));

  const { state } = readState(paths);
  assert.deepEqual(Object.keys(state.sessions).sort(), ["one", "two"]);
  assert.ok(!fs.existsSync(paths.stateFile), "legacy state.json is removed after migration");
  assert.ok(fs.existsSync(path.join(paths.sessionsDir, "one.json")), "per-session file written");
  fs.rmSync(repo, { recursive: true, force: true });
});
