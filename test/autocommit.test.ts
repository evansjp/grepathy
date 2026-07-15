import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { autoCommitWhyPack, whyPackGitStatus } from "../src/core/autocommit.js";

function git(cwd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
}

/** Fresh repo with an initial commit, a why-pack, and a config email/name. */
function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-ac-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.co"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

function writeWhy(dir: string, body: string): void {
  const whyDir = path.join(dir, ".ai", "why");
  fs.mkdirSync(whyDir, { recursive: true });
  fs.writeFileSync(path.join(whyDir, "main.md"), body);
}

test("commits only .ai/why and leaves the user's staged work untouched", () => {
  const dir = tempRepo();
  writeWhy(dir, "# why-pack\n\n### A decision\n");

  // The user has their own staged + unstaged work in flight.
  fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1;\n");
  git(dir, ["add", "app.ts"]); // staged
  fs.writeFileSync(path.join(dir, "notes.txt"), "scratch\n"); // untracked

  const before = git(dir, ["rev-parse", "HEAD"]).stdout;
  const res = autoCommitWhyPack(dir);

  assert.equal(res.committed, true);
  assert.equal(res.branch, "main");
  assert.deepEqual(res.files, [".ai/why/main.md"], "reported path keeps its leading dot");
  const after = git(dir, ["rev-parse", "HEAD"]).stdout;
  assert.notEqual(after, before, "HEAD advanced by one commit");

  // The commit contains ONLY the why-pack.
  const files = git(dir, ["show", "--name-only", "--pretty=format:", "HEAD"]).stdout.split("\n").filter(Boolean);
  assert.deepEqual(files, [".ai/why/main.md"]);
  assert.match(git(dir, ["log", "-1", "--pretty=%s"]).stdout, /^grepathy: update why-pack \(main\)$/);

  // The user's staged app.ts is STILL staged and STILL uncommitted.
  assert.equal(git(dir, ["diff", "--cached", "--name-only"]).stdout, "app.ts");
  // The untracked file is still untracked.
  assert.ok(git(dir, ["status", "--porcelain"]).stdout.includes("?? notes.txt"));
  // The why-pack now reads clean (index synced to the new commit).
  assert.equal(git(dir, ["status", "--porcelain", "--", ".ai/why"]).stdout, "");
});

test("commits a brand-new (untracked) why-pack file", () => {
  const dir = tempRepo();
  writeWhy(dir, "# fresh pack\n");
  const res = autoCommitWhyPack(dir);
  assert.equal(res.committed, true);
  const files = git(dir, ["show", "--name-only", "--pretty=format:", "HEAD"]).stdout.split("\n").filter(Boolean);
  assert.deepEqual(files, [".ai/why/main.md"]);
});

test("captures a why-pack deletion (orphan removal)", () => {
  const dir = tempRepo();
  // Commit two packs first, via the tool.
  writeWhy(dir, "# main\n");
  fs.writeFileSync(path.join(dir, ".ai", "why", "gone.md"), "# orphan\n");
  autoCommitWhyPack(dir);
  assert.ok(git(dir, ["ls-files", ".ai/why/gone.md"]).stdout.includes("gone.md"));

  // Now delete the orphan and auto-commit again.
  fs.rmSync(path.join(dir, ".ai", "why", "gone.md"));
  const res = autoCommitWhyPack(dir);
  assert.equal(res.committed, true);
  assert.equal(git(dir, ["ls-files", ".ai/why/gone.md"]).stdout, "", "orphan removed from the tree");
});

test("does nothing when there is no why-pack change", () => {
  const dir = tempRepo();
  writeWhy(dir, "# pack\n");
  assert.equal(autoCommitWhyPack(dir).committed, true);
  const res = autoCommitWhyPack(dir); // second call: nothing new
  assert.equal(res.committed, false);
  assert.equal(res.reason, "nothing to commit");
});

test("refuses when the human has staged why-pack changes (mid-review)", () => {
  const dir = tempRepo();
  writeWhy(dir, "# pack\n");
  git(dir, ["add", ".ai/why/main.md"]); // human staged it — they're reviewing
  const res = autoCommitWhyPack(dir);
  assert.equal(res.committed, false);
  assert.equal(res.reason, "why-pack changes are staged (mid-review)");
});

test("refuses on detached HEAD", () => {
  const dir = tempRepo();
  const head = git(dir, ["rev-parse", "HEAD"]).stdout;
  git(dir, ["checkout", "-q", head]); // detach
  writeWhy(dir, "# pack\n");
  const res = autoCommitWhyPack(dir);
  assert.equal(res.committed, false);
  assert.equal(res.reason, "detached HEAD");
});

test("refuses mid-merge", () => {
  const dir = tempRepo();
  // Fabricate a MERGE_HEAD marker to simulate an in-progress merge.
  const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]).stdout;
  fs.writeFileSync(path.join(gitDir, "MERGE_HEAD"), git(dir, ["rev-parse", "HEAD"]).stdout + "\n");
  writeWhy(dir, "# pack\n");
  const res = autoCommitWhyPack(dir);
  assert.equal(res.committed, false);
  assert.equal(res.reason, "repo mid-merge/rebase");
});

test("whyPackGitStatus reports uncommitted then unpushed", () => {
  const dir = tempRepo();
  // Stand up a bare 'origin' and an upstream so unpushed is measurable.
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-origin-"));
  git(origin, ["init", "-q", "--bare"]);
  git(dir, ["remote", "add", "origin", origin]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);

  // Uncommitted why-pack change.
  writeWhy(dir, "# pack\n");
  let g = whyPackGitStatus(dir);
  assert.equal(g.uncommitted, 1);
  assert.equal(g.unpushed, 0);

  // Commit it → now unpushed, not uncommitted.
  autoCommitWhyPack(dir);
  g = whyPackGitStatus(dir);
  assert.equal(g.uncommitted, 0);
  assert.equal(g.unpushed, 1);
  assert.equal(g.hasUpstream, true);

  // Push → clean on both axes.
  git(dir, ["push", "-q", "origin", "main"]);
  g = whyPackGitStatus(dir);
  assert.equal(g.uncommitted, 0);
  assert.equal(g.unpushed, 0);
});
