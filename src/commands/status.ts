import * as fs from "node:fs";
import { resolveRuntime, isInitialized } from "../util/runtime.js";
import { readState } from "../state/state.js";
import { discoverAndSync } from "../core/sweep.js";
import { fileSize } from "../util/fsx.js";
import { whyPackPath, slugifyBranch } from "../util/paths.js";
import { currentBranch } from "../util/git.js";
import { whyPackGitStatus } from "../core/autocommit.js";
import { say, warn } from "../util/log.js";

/** `grepathy status` — sessions known/dirty, why-pack freshness. */
export function status(): number {
  const rt = resolveRuntime();
  if (!rt) {
    warn("not inside a git repository.");
    return 1;
  }
  if (!isInitialized(rt.paths)) {
    warn("not initialized here. Run `grepathy init`.");
    return 1;
  }

  const { state, corrupt } = readState(rt.paths);
  if (corrupt) warn("state file looks corrupt — run `grepathy repair`.");
  discoverAndSync(rt.repoRoot, state);

  const sessions = Object.entries(state.sessions).filter(([, r]) => r.repo === rt.repoRoot);
  const branch = currentBranch(rt.repoRoot);

  say(`Repo: ${rt.repoRoot}`);
  say(`Branch: ${branch ?? "(detached)"}`);
  say("");

  if (sessions.length === 0) {
    say("Sessions: none discovered yet.");
  } else {
    say(`Sessions (${sessions.length}):`);
    const unmatched: string[] = [];
    for (const [id, r] of sessions) {
      const grew = fileSize(r.transcript_path) > r.last_distilled_offset;
      const stateLabel = r.status === "dirty" || grew ? "DIRTY" : "distilled";
      const to = r.distilled_to?.length ? ` -> ${r.distilled_to.join(", ")}` : "";
      const seen = r.branches_seen.length ? r.branches_seen.join(",") : "(no branch recorded)";
      say(`  ${short(id)}  ${stateLabel.padEnd(9)} ${seen}${to}`);
      if (r.branches_seen.length === 0 && r.status !== "distilled") unmatched.push(id);
    }
    if (unmatched.length) {
      say("");
      say(`  ${unmatched.length} unmatched session(s) — no branch recorded yet; will attribute on distill.`);
    }
  }

  say("");
  const packs = listWhyPacks(rt.paths.whyDir);
  if (packs.length === 0) {
    say("Why-packs: none yet.");
  } else {
    say(`Why-packs (${packs.length}):`);
    for (const p of packs) say(`  .ai/why/${p}`);
  }

  // Freshness for the current branch.
  if (branch) {
    const pack = whyPackPath(rt.paths, branch);
    const exists = fs.existsSync(pack);
    const anyDirty = sessions.some(
      ([, r]) => (r.status === "dirty" || fileSize(r.transcript_path) > r.last_distilled_offset),
    );
    say("");
    if (!exists) say(`Current branch '${slugifyBranch(branch)}': no why-pack yet.`);
    else if (anyDirty) say(`Current branch '${slugifyBranch(branch)}': why-pack may be stale (dirty sessions).`);
    else say(`Current branch '${slugifyBranch(branch)}': up to date.`);
  }

  // Self-only: why-packs are personal and never committed, so the commit/push
  // freshness axes don't apply — report the mode instead of nagging.
  if (rt.cfg.selfOnly) {
    say("");
    say("  why-pack: self-only mode — personal notes, not committed or shared.");
    return 0;
  }

  // Git freshness: is the committed/pushed why-pack behind the working tree?
  // These two axes are what let GitHub silently lag — surface them so nobody has
  // to go sniffing. "grepathy sync" (or a plain commit + push) closes the gap.
  const g = whyPackGitStatus(rt.repoRoot);
  if (g.uncommitted > 0 || g.unpushed > 0) {
    say("");
    if (g.uncommitted > 0) say(`  ⚠ why-pack: ${g.uncommitted} uncommitted change(s) — \`grepathy sync\` to commit.`);
    if (g.unpushed > 0) say(`  ⚠ why-pack: ${g.unpushed} commit(s) not pushed — \`git push\` to share.`);
  } else if (rt.cfg.sync === "manual") {
    say("");
    say("  why-pack: committed and pushed (sync: manual).");
  }

  return 0;
}

function listWhyPacks(whyDir: string): string[] {
  try {
    return fs.readdirSync(whyDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

function short(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + "…" : id;
}
