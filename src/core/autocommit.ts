import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(repoRoot: string, args: string[], env?: NodeJS.ProcessEnv): Run {
  const res = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15_000,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    status: res.error ? 1 : res.status ?? 1,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

function absoluteGitDir(repoRoot: string): string | null {
  const r = run(repoRoot, ["rev-parse", "--absolute-git-dir"]);
  return r.status === 0 && r.stdout ? r.stdout : null;
}

/** Mid-merge / rebase / cherry-pick / revert / bisect — don't author commits into these. */
function operationInProgress(gitDir: string): boolean {
  const markers = [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
  ];
  return markers.some((m) => fs.existsSync(path.join(gitDir, m)));
}

export interface AutoCommitResult {
  committed: boolean;
  /** Why it did nothing (only set when committed is false). */
  reason?: string;
  sha?: string;
  branch?: string;
  /** Repo-relative paths that went into the commit. */
  files?: string[];
}

/**
 * Commit ONLY the current `.ai/why/` working-tree state on top of HEAD, using a
 * throwaway index (GIT_INDEX_FILE) — never the repo's real staging area. The
 * user's staged work (and any concurrent agent's) is never read, `git add`ed, or
 * swept in: this is the exact inverse of the "swept-cart" bug, so it must never
 * call plain `git add`/`git commit`.
 *
 * A local commit is not "sharing" — nothing leaves the machine — so this keeps
 * the review-before-share promise intact: the share moment is still `git push`,
 * still human-initiated, still guarded by the pre-push prompt (which now covers
 * any why-pack commit riding along).
 *
 * Fails open: any unusual repo state (detached HEAD, mid-merge/rebase, the human
 * mid-review with staged why-pack changes, a concurrent ref move) returns
 * `{committed:false}` and is simply retried at the next settle point.
 */
export function autoCommitWhyPack(repoRoot: string): AutoCommitResult {
  const gitDir = absoluteGitDir(repoRoot);
  if (!gitDir) return { committed: false, reason: "not a git repo" };
  if (operationInProgress(gitDir)) return { committed: false, reason: "repo mid-merge/rebase" };

  // Need a real branch to move; skip detached HEAD.
  const sym = run(repoRoot, ["symbolic-ref", "-q", "HEAD"]);
  if (sym.status !== 0 || !sym.stdout.startsWith("refs/heads/")) {
    return { committed: false, reason: "detached HEAD" };
  }
  const ref = sym.stdout;
  const branch = ref.slice("refs/heads/".length);

  // Anything to commit under .ai/why? `-uall` lists individual untracked files
  // rather than collapsing a wholly-untracked .ai/why/ (the first-ever pack) to
  // just the directory name, so `files` names the actual packs.
  const st = run(repoRoot, ["status", "--porcelain", "-uall", "--", ".ai/why"]);
  if (st.status !== 0) return { committed: false, reason: "git status failed" };
  if (!st.stdout) return { committed: false, reason: "nothing to commit" };
  const files = st.stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  // If the human has STAGED why-pack changes, they're mid-review — don't yank it
  // out from under them. Leave everything and try again next settle point.
  const staged = run(repoRoot, ["diff", "--cached", "--name-only", "--", ".ai/why"]);
  if (staged.status === 0 && staged.stdout) {
    return { committed: false, reason: "why-pack changes are staged (mid-review)" };
  }

  const head = run(repoRoot, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.stdout) return { committed: false, reason: "no HEAD (empty repo)" };
  const oldHead = head.stdout;

  // Build the commit through a scratch index so the real index is untouched.
  const scratch = path.join(os.tmpdir(), `grepathy-index-${process.pid}-${oldHead.slice(0, 8)}`);
  try {
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: scratch };
    if (run(repoRoot, ["read-tree", "HEAD"], env).status !== 0) {
      return { committed: false, reason: "read-tree failed" };
    }
    // -A picks up modifications, new packs, and deletions (e.g. an orphaned pack).
    if (run(repoRoot, ["add", "-A", "--", ".ai/why"], env).status !== 0) {
      return { committed: false, reason: "scratch add failed" };
    }
    const tree = run(repoRoot, ["write-tree"], env);
    if (tree.status !== 0 || !tree.stdout) return { committed: false, reason: "write-tree failed" };

    const headTree = run(repoRoot, ["rev-parse", "HEAD^{tree}"]);
    if (headTree.status === 0 && headTree.stdout === tree.stdout) {
      return { committed: false, reason: "no tree change" };
    }

    const msg = `grepathy: update why-pack (${branch})`;
    const commit = run(repoRoot, ["commit-tree", tree.stdout, "-p", oldHead, "-m", msg]);
    if (commit.status !== 0 || !commit.stdout) return { committed: false, reason: "commit-tree failed" };
    const newSha = commit.stdout;

    // Compare-and-swap: lose gracefully to a concurrent commit rather than clobber it.
    const upd = run(repoRoot, ["update-ref", ref, newSha, oldHead]);
    if (upd.status !== 0) return { committed: false, reason: "ref moved concurrently" };

    // Sync the REAL index's .ai/why entries up to the new commit so `git status`
    // reads clean — scoped to this pathspec, so other staged entries are untouched
    // and the working tree is never modified.
    run(repoRoot, ["reset", "-q", "--", ".ai/why"]);

    return { committed: true, sha: newSha, branch, files };
  } finally {
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export interface WhyPackGitStatus {
  /** .ai/why files with uncommitted (working-tree, staged, or untracked) changes. */
  uncommitted: number;
  /** Commits on HEAD not yet on the upstream that touch .ai/why. */
  unpushed: number;
  /** Whether the current branch has an upstream to compare against. */
  hasUpstream: boolean;
}

/**
 * The two git axes of why-pack staleness that `status` was previously blind to:
 * distilled-but-uncommitted, and committed-but-unpushed. Both are answerable
 * locally with plumbing, so "is GitHub current?" is always one command away
 * instead of a sniffing expedition.
 */
export function whyPackGitStatus(repoRoot: string): WhyPackGitStatus {
  const st = run(repoRoot, ["status", "--porcelain", "-uall", "--", ".ai/why"]);
  const uncommitted = st.status === 0 && st.stdout ? st.stdout.split("\n").filter(Boolean).length : 0;

  let hasUpstream = false;
  let unpushed = 0;
  const up = run(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (up.status === 0 && up.stdout) {
    hasUpstream = true;
    const cnt = run(repoRoot, ["rev-list", "--count", "@{upstream}..HEAD", "--", ".ai/why"]);
    if (cnt.status === 0) unpushed = parseInt(cnt.stdout, 10) || 0;
  }
  return { uncommitted, unpushed, hasUpstream };
}
