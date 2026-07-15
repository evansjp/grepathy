import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { distillSession } from "../src/core/distillSession.js";
import { StateFile } from "../src/state/state.js";
import { DEFAULT_CONFIG } from "../src/util/config.js";
import { grepathyPaths } from "../src/util/paths.js";
import { fixedPackBackend, DelayMock, FIXTURES, CLERK_PACK } from "./helpers.js";

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-test-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  // Give the repo the branch the session worked on, so resolveBranch (which now
  // skips since-deleted branches) attributes to it. Needs an initial commit
  // before a branch can be created.
  fs.writeFileSync(path.join(dir, ".keep"), "");
  spawnSync("git", ["add", ".keep"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
  spawnSync("git", ["branch", "guest-access"], { cwd: dir });
  return dir;
}

function stateWith(repo: string, sessionId: string): StateFile {
  return {
    version: 1,
    sessions: {
      [sessionId]: {
        tool: "claude-code",
        transcript_path: path.join(FIXTURES, "clerk-session.jsonl"),
        repo,
        branches_seen: [],
        files_touched: [],
        first_seen: "2026-07-07T14:00:00Z",
        last_seen: "2026-07-07T14:05:00Z",
        last_distilled_offset: 0,
        status: "dirty",
      },
    },
  };
}

test("end-to-end: distill a session into a why-pack that flags agent-initiated", async () => {
  const repo = tempRepo();
  const id = "sess-1";
  const state = stateWith(repo, id);
  const backend = fixedPackBackend(CLERK_PACK);

  const res = await distillSession(repo, id, state, DEFAULT_CONFIG, backend);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.branch, "guest-access");
  assert.ok(res.changed);

  const packPath = path.join(grepathyPaths(repo).whyDir, "guest-access.md");
  const md = fs.readFileSync(packPath, "utf8");
  assert.match(md, /# Why: guest-access/);
  assert.match(md, /Status: agent-initiated/);
  assert.match(md, /Guest identities are pre-created in Clerk/);
  assert.match(md, /lib\/clerk/);

  // The definition-of-done grep works.
  const grep = spawnSync("grep", ["-r", "agent-initiated", path.join(repo, ".ai", "why")], { encoding: "utf8" });
  assert.equal(grep.status, 0);
  assert.match(grep.stdout, /agent-initiated/);

  // State advanced: session is now distilled with a non-zero offset.
  assert.equal(state.sessions[id].status, "distilled");
  assert.ok(state.sessions[id].last_distilled_offset > 0);
  assert.deepEqual(state.sessions[id].distilled_to, ["guest-access"]);

  fs.rmSync(repo, { recursive: true, force: true });
});

test("a since-deleted seen branch does not resurrect its orphan pack", async () => {
  // Same fixture, but the branch it worked on (guest-access) no longer exists.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-test-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".keep"), "");
  spawnSync("git", ["add", ".keep"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: dir }); // on 'main' (or default)
  // NOTE: no guest-access branch created — it's "deleted".

  const id = "sess-orphan";
  const state = stateWith(dir, id);
  const res = await distillSession(dir, id, state, DEFAULT_CONFIG, fixedPackBackend(CLERK_PACK));

  assert.equal(res.ok, true, res.reason);
  const current = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  assert.equal(res.branch, current, "attributed to the surviving current branch");
  assert.ok(!fs.existsSync(path.join(grepathyPaths(dir).whyDir, "guest-access.md")), "no orphan pack recreated");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a no-commit session is attributed to its hook-recorded branch (last_branch)", async () => {
  // A pure-investigation session: the transcript stamps NO gitBranch (nothing was
  // committed, no edits), so branches_seen stays empty. Before the fix this fell
  // through to the current branch and filed an empty/misattributed pack. Now the
  // branch the Stop/SessionEnd hook captured (last_branch) drives attribution.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-test-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".keep"), "");
  spawnSync("git", ["add", ".keep"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
  spawnSync("git", ["branch", "investigate-sync"], { cwd: dir }); // the session's branch, still checked out elsewhere

  // Transcript with no gitBranch, no edits — the case that produced empty packs.
  const tp = path.join(dir, "invest.jsonl");
  fs.writeFileSync(
    tp,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "why does product sync drop the last page?" }, timestamp: "2026-07-07T14:00:00Z" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The cursor loop exits one page early." }] }, timestamp: "2026-07-07T14:01:00Z" }),
    ].join("\n") + "\n",
  );

  const id = "sess-invest";
  const state: StateFile = {
    version: 1,
    sessions: {
      [id]: {
        tool: "claude-code",
        transcript_path: tp,
        repo: dir,
        branches_seen: [],
        last_branch: "investigate-sync",
        files_touched: [],
        first_seen: "2026-07-07T14:00:00Z",
        last_seen: "2026-07-07T14:05:00Z",
        last_distilled_offset: 0,
        status: "dirty",
      },
    },
  };

  const res = await distillSession(dir, id, state, DEFAULT_CONFIG, fixedPackBackend(CLERK_PACK));
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.branch, "investigate-sync", "attributed to the hook-recorded branch, not the checked-out one");
  assert.ok(fs.existsSync(path.join(grepathyPaths(dir).whyDir, "investigate-sync.md")), "pack filed under last_branch");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a truncated session writes a partial pack, stays dirty, and completes later with no duplicates", async () => {
  const repo = tempRepo(); // has a guest-access branch
  // A transcript with many events so it splits into several chunks.
  const tp = path.join(repo, "big.jsonl");
  const lines = Array.from({ length: 8 }, (_, i) =>
    JSON.stringify({
      type: "user",
      gitBranch: "guest-access",
      message: { role: "user", content: `decision point ${i} ` + "x".repeat(80) },
      timestamp: `2026-07-07T14:00:0${i}Z`,
    }),
  );
  fs.writeFileSync(tp, lines.join("\n") + "\n");

  const id = "sess-trunc";
  const state: StateFile = {
    version: 1,
    sessions: {
      [id]: {
        tool: "claude-code",
        transcript_path: tp,
        repo,
        branches_seen: [],
        files_touched: [],
        first_seen: "2026-07-07T14:00:00Z",
        last_seen: "2026-07-07T14:00:07Z",
        last_distilled_offset: 0,
        status: "dirty",
      },
    },
  };
  const smallCfg = { ...DEFAULT_CONFIG, chunkChars: 60, distiller: { ...DEFAULT_CONFIG.distiller, concurrency: 1 } };
  const packPath = path.join(grepathyPaths(repo).whyDir, "guest-access.md");

  // Run 1: a slow backend under a tight budget truncates mid-session.
  const slow = new DelayMock(() => ({ delayMs: 25, body: JSON.stringify(CLERK_PACK) }));
  const r1 = await distillSession(repo, id, state, smallCfg, slow, { deadline: Date.now() + 70 });
  assert.equal(r1.ok, true, r1.reason);
  assert.equal(r1.truncated, true, "hit the budget mid-session");
  assert.equal(state.sessions[id].status, "dirty", "stays dirty");
  assert.equal(state.sessions[id].last_distilled_offset, 0, "offset intact so the full delta re-reads next time");
  assert.ok(fs.existsSync(packPath), "partial pack written — progress preserved");

  // Run 2: fast backend, no deadline -> completes, and the re-done chunks dedupe.
  const r2 = await distillSession(repo, id, state, smallCfg, fixedPackBackend(CLERK_PACK));
  assert.equal(r2.ok, true, r2.reason);
  assert.ok(!r2.truncated, "second pass completes");
  assert.equal(state.sessions[id].status, "distilled");
  assert.ok(state.sessions[id].last_distilled_offset > 0, "offset advances only on full completion");
  const decisionCount = (fs.readFileSync(packPath, "utf8").match(/^### /gm) || []).length;
  assert.equal(decisionCount, CLERK_PACK.decisions.length, "resume produced no duplicate entries");

  fs.rmSync(repo, { recursive: true, force: true });
});

test("re-distilling with no new transcript bytes makes no changes", async () => {
  const repo = tempRepo();
  const id = "sess-2";
  const state = stateWith(repo, id);
  const backend = fixedPackBackend(CLERK_PACK);

  await distillSession(repo, id, state, DEFAULT_CONFIG, backend);
  const packPath = path.join(grepathyPaths(repo).whyDir, "guest-access.md");
  const before = fs.readFileSync(packPath, "utf8");

  const second = await distillSession(repo, id, state, DEFAULT_CONFIG, backend);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(packPath, "utf8"), before);

  fs.rmSync(repo, { recursive: true, force: true });
});
