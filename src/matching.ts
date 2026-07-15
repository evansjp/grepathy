import { SessionRecord } from "./state/state.js";
import { branchDiffFiles } from "./util/git.js";

export interface BranchMatch {
  branch: string;
  reason: "branch-recorded" | "file-overlap";
  score: number;
}

/**
 * Which branch(es) a session's decisions belong to (§5). A session matches a
 * branch when (a) the transcript recorded that branch during the session, or
 * (b) files the session edited overlap the branch's diff. When ambiguous, all
 * candidates are returned; the caller may attribute to all with a note.
 */
export function matchSessionToBranches(
  repoRoot: string,
  session: SessionRecord,
  candidateBranches: string[],
): BranchMatch[] {
  const matches: BranchMatch[] = [];
  // The transcript's gitBranch(es), plus the branch checked out at hook time —
  // the latter is the only recorded signal for a no-commit session.
  const recorded = new Set(session.branches_seen);
  if (session.last_branch) recorded.add(session.last_branch);
  const touched = new Set(session.files_touched);

  for (const branch of candidateBranches) {
    if (recorded.has(branch)) {
      matches.push({ branch, reason: "branch-recorded", score: 1 });
      continue;
    }
    if (touched.size === 0) continue;
    const diff = branchDiffFiles(repoRoot, branch);
    const overlap = diff.filter((f) => touched.has(f)).length;
    if (overlap > 0) {
      const score = overlap / Math.max(touched.size, 1);
      matches.push({ branch, reason: "file-overlap", score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches;
}

/**
 * Best branch for a session given a single target branch context (pre-push):
 * prefer a recorded-branch match, else the highest file-overlap, else fall back
 * to the session's own recorded branch, else the target.
 */
export function resolveBranchForSession(
  repoRoot: string,
  session: SessionRecord,
  targetBranch: string,
): { branch: string; matched: boolean } {
  const matches = matchSessionToBranches(repoRoot, session, [targetBranch]);
  if (matches.length) return { branch: matches[0].branch, matched: true };
  if (session.branches_seen.length === 1) {
    return { branch: session.branches_seen[0], matched: true };
  }
  return { branch: targetBranch, matched: false };
}
