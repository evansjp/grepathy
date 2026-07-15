import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/util/config.js";
import { init } from "../src/commands/init.js";
import { sync } from "../src/commands/sync.js";
import { uninstall } from "../src/commands/uninstall.js";
import { status } from "../src/commands/status.js";
import { doctor } from "../src/commands/doctor.js";

function git(cwd: string, args: string[]): string {
  return (spawnSync("git", args, { cwd, encoding: "utf8" }).stdout ?? "").trim();
}

/** Fresh repo with one commit. Returns dir; caller chdir's as needed. */
function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grepathy-so-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.co"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

function read(dir: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return "";
  }
}

/** Run `fn` with cwd set to `dir` and stdout/stderr captured. */
async function inRepo<T>(dir: string, fn: () => T | Promise<T>): Promise<{ out: string; err: string; result: T }> {
  const cwd = process.cwd();
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  (process.stdout as any).write = (s: string) => ((out += s), true);
  (process.stderr as any).write = (s: string) => ((err += s), true);
  process.chdir(dir);
  try {
    const result = await fn();
    return { out, err, result };
  } finally {
    process.chdir(cwd);
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
  }
}

test("loadConfig: selfOnly forces effective sync to manual even when shared says auto", () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, ".grepathy.json"), JSON.stringify({ sync: "auto" }));
  fs.mkdirSync(path.join(dir, ".ai", "grepathy"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".ai", "grepathy", "config.json"), JSON.stringify({ selfOnly: true }));

  const cfg = loadConfig(dir);
  assert.equal(cfg.selfOnly, true);
  assert.equal(cfg.sync, "manual");
});

test("loadConfig: without selfOnly, configured sync is honored", () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, ".grepathy.json"), JSON.stringify({ sync: "auto" }));
  const cfg = loadConfig(dir);
  assert.equal(cfg.selfOnly, false);
  assert.equal(cfg.sync, "auto");
});

test("init --self-only: excludes artifacts privately and touches no shared file", async () => {
  const dir = tempRepo();
  await inRepo(dir, () => init({ selfOnly: true }));

  const excl = read(dir, ".git/info/exclude");
  assert.ok(excl.includes(".ai/"), "exclude ignores .ai/");
  assert.ok(excl.includes("CLAUDE.local.md"), "exclude ignores CLAUDE.local.md");
  assert.ok(excl.includes(".claude/settings.local.json"), "exclude ignores the personal hooks file");

  // Nothing grepathy wrote shows up as committable in git status.
  assert.equal(git(dir, ["status", "--porcelain"]), "", "no grepathy artifacts left visible to git");

  assert.ok(read(dir, "CLAUDE.local.md").includes(".ai/why/"), "personal pointer written");

  // No shared/committable files created or modified.
  assert.ok(!fs.existsSync(path.join(dir, ".grepathy.json")), "no shared config");
  assert.ok(!read(dir, "CLAUDE.md").includes("grepathy:begin"), "committed CLAUDE.md untouched");
  assert.ok(!read(dir, ".gitignore").includes(".ai/grepathy/"), "shared .gitignore untouched");

  // Mode persisted locally; hooks still installed.
  assert.equal(JSON.parse(read(dir, ".ai/grepathy/config.json")).selfOnly, true);
  assert.ok(fs.existsSync(path.join(dir, ".claude", "settings.local.json")), "hooks installed");
});

test("init (normal): still writes the shared artifacts and no exclude block", async () => {
  const dir = tempRepo();
  await inRepo(dir, () => init());

  assert.ok(fs.existsSync(path.join(dir, ".grepathy.json")), "shared config written");
  assert.ok(read(dir, ".gitignore").includes(".ai/grepathy/"), "shared gitignore written");
  assert.ok(read(dir, "CLAUDE.md").includes("grepathy:begin"), "committed pointer written");
  assert.ok(!read(dir, ".git/info/exclude").includes("grepathy self-only"), "no private exclude");
});

test("init --self-only: warns when .ai/ is already tracked but still proceeds", async () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, ".ai", "why"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".ai", "why", "old.md"), "# tracked\n");
  git(dir, ["add", ".ai/why/old.md"]);
  git(dir, ["commit", "-qm", "add why"]);

  const { err } = await inRepo(dir, () => init({ selfOnly: true }));
  assert.match(err, /track/i, "warns about already-tracked files");
  assert.ok(read(dir, ".git/info/exclude").includes(".ai/"), "still writes the exclude");
});

test("init --self-only is idempotent on re-run (no duplicate exclude block)", async () => {
  const dir = tempRepo();
  await inRepo(dir, () => init({ selfOnly: true }));
  await inRepo(dir, () => init({ selfOnly: true }));
  const excl = read(dir, ".git/info/exclude");
  assert.equal(excl.split(">>> grepathy self-only >>>").length - 1, 1, "exactly one block");
  assert.equal(JSON.parse(read(dir, ".ai/grepathy/config.json")).selfOnly, true);
});

test("sync under self-only: distills but never commits", async () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, ".ai", "grepathy"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".ai", "grepathy", "config.json"), JSON.stringify({ selfOnly: true }));
  fs.mkdirSync(path.join(dir, ".ai", "why"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".ai", "why", "main.md"), "# why\n");

  const head0 = git(dir, ["rev-parse", "HEAD"]);
  const { out } = await inRepo(dir, () => sync());
  const head1 = git(dir, ["rev-parse", "HEAD"]);

  assert.equal(head1, head0, "no commit created");
  assert.match(out, /self-only/i);
});

test("uninstall removes the private exclude and pointer blocks", async () => {
  const dir = tempRepo();
  await inRepo(dir, () => init({ selfOnly: true }));
  await inRepo(dir, () => uninstall());

  assert.ok(!read(dir, ".git/info/exclude").includes("grepathy self-only"), "exclude block gone");
  assert.ok(!fs.existsSync(path.join(dir, "CLAUDE.local.md")), "pointer-only file removed");
});

test("status under self-only reports the mode, not commit/push nags", async () => {
  const dir = tempRepo();
  await inRepo(dir, () => init({ selfOnly: true }));
  const { out } = await inRepo(dir, () => status());
  assert.match(out, /self-only/i);
  assert.ok(!/uncommitted change/i.test(out), "no uncommitted nag in self-only");
});

test("status under self-only warns instead of reassuring when .ai/ is already tracked", async () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, ".ai", "why"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".ai", "why", "old.md"), "# tracked\n");
  git(dir, ["add", ".ai/why/old.md"]);
  git(dir, ["commit", "-qm", "add why"]);

  await inRepo(dir, () => init({ selfOnly: true }));
  const { out } = await inRepo(dir, () => status());
  assert.match(out, /already.*git-tracked/i, "warns that the guarantee is broken");
  assert.ok(!/not committed or shared/i.test(out), "does not print the safe green line");
});

test("doctor under self-only reports OK when nothing is tracked", async () => {
  const dir = tempRepo();
  await inRepo(dir, () => init({ selfOnly: true }));
  const { out, result } = await inRepo(dir, () => doctor());
  assert.match(out, /self-only mode — why-packs are personal/i);
  assert.equal(result, 0);
});

test("doctor under self-only flags a problem when .ai/ is already tracked", async () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, ".ai", "why"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".ai", "why", "old.md"), "# tracked\n");
  git(dir, ["add", ".ai/why/old.md"]);
  git(dir, ["commit", "-qm", "add why"]);

  await inRepo(dir, () => init({ selfOnly: true }));
  const { out, result } = await inRepo(dir, () => doctor());
  assert.match(out, /already git-tracked/i, "flags the broken guarantee");
  assert.notEqual(result, 0, "reports a problem, not a clean bill of health");
});
