import { spawnSync } from "node:child_process";

function git(repoRoot: string, args: string[]): string | null {
  const res = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (res.status !== 0 || res.error) return null;
  return res.stdout.trim();
}

/** Absolute path to the repo root containing `cwd`, or null if not a repo. */
export function repoRootFrom(cwd: string): string | null {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export function isGitRepo(cwd: string): boolean {
  return repoRootFrom(cwd) !== null;
}

/**
 * All worktrees of the repo `repoRoot` belongs to (the "family"), as absolute
 * paths — the main worktree plus every linked worktree. This is how a session
 * that ran in one worktree is found when you push from another: the sweep scans
 * every family member's transcript directory, not just the cwd's. Falls back to
 * [repoRoot] if git can't list worktrees.
 */
export function listWorktrees(repoRoot: string): string[] {
  const out = git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!out) return [repoRoot];
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  return paths.length ? paths : [repoRoot];
}

export function currentBranch(repoRoot: string): string | null {
  const b = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!b || b === "HEAD") return null; // detached
  return b;
}

/** True if a local branch by this name still exists. */
export function branchExists(repoRoot: string, name: string): boolean {
  const res = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  return res.status === 0;
}

/**
 * Files changed on `branch` relative to its merge-base with the default trunk.
 * Falls back to the diff against the first available trunk ref, then to all
 * tracked files' recent changes. Returns repo-relative POSIX paths.
 */
export function branchDiffFiles(repoRoot: string, branch: string): string[] {
  const trunks = ["origin/main", "origin/master", "main", "master"];
  for (const trunk of trunks) {
    if (trunk === branch) continue;
    const base = git(repoRoot, ["merge-base", trunk, branch]);
    if (!base) continue;
    const out = git(repoRoot, ["diff", "--name-only", `${base}...${branch}`]);
    if (out !== null) {
      return out.split("\n").map((l) => l.trim()).filter(Boolean);
    }
  }
  // No trunk to diff against (e.g. main itself, or fresh repo): use last commit.
  const out = git(repoRoot, ["show", "--name-only", "--pretty=format:", "HEAD"]);
  if (out !== null) {
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  return [];
}

/** Git-tracked files matching `pathspec` (repo-relative POSIX paths). */
export function trackedFilesUnder(repoRoot: string, pathspec: string): string[] {
  const out = git(repoRoot, ["ls-files", "--", pathspec]);
  if (!out) return [];
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Stage the given files. Best-effort; ignores files that don't exist. */
export function stageFiles(repoRoot: string, files: string[]): void {
  if (files.length === 0) return;
  git(repoRoot, ["add", "--", ...files]);
}

export function gitConfig(repoRoot: string, key: string): string | null {
  return git(repoRoot, ["config", "--get", key]);
}

/** Where git stores hooks for this repo (honours core.hooksPath). */
export function hooksDir(repoRoot: string): string | null {
  const custom = git(repoRoot, ["config", "--get", "core.hooksPath"]);
  const gitDir = git(repoRoot, ["rev-parse", "--git-path", "hooks"]);
  if (custom) {
    // core.hooksPath may be relative to repo root.
    return custom.startsWith("/") ? custom : `${repoRoot}/${custom}`;
  }
  if (gitDir) return gitDir.startsWith("/") ? gitDir : `${repoRoot}/${gitDir}`;
  return null;
}
