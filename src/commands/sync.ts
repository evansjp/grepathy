import { resolveRuntime, isInitialized } from "../util/runtime.js";
import { distill } from "./distill.js";
import { autoCommitWhyPack, whyPackGitStatus } from "../core/autocommit.js";
import { say, warn } from "../util/log.js";

/**
 * `grepathy sync` — the manual escape hatch: distill any dirty sessions, then
 * commit the why-pack. Explicit, so it commits regardless of the `sync` config
 * setting (that setting only governs the *automatic* settle-point commits). It
 * never pushes — push stays the human's call and the privacy gate. Handy when
 * `status` says the why-pack is uncommitted and you just want it caught up in
 * one command instead of hand-running git plumbing.
 */
export async function sync(): Promise<number> {
  const rt = resolveRuntime();
  if (!rt) {
    warn("not inside a git repository.");
    return 1;
  }
  if (!isInitialized(rt.paths)) {
    warn("run `grepathy init` first.");
    return 1;
  }

  // Catch up any undistilled sessions first (no commit here — we do it once below).
  const code = await distill({ allDirty: true });

  // Self-only mode never commits — sync stays useful as a distill-refresh only.
  // This is the one path that commits regardless of the `sync` setting, so it
  // has to check selfOnly explicitly.
  if (rt.cfg.selfOnly) {
    say("grepathy: self-only mode — refreshed why-packs, not committing.");
    return code;
  }

  const res = autoCommitWhyPack(rt.repoRoot);
  if (res.committed) {
    say(`grepathy: committed ${(res.files ?? []).join(", ")} (${res.branch}).`);
    const g = whyPackGitStatus(rt.repoRoot);
    if (g.unpushed > 0) {
      say(`grepathy: why-pack is ${g.unpushed} commit(s) ahead of ${g.hasUpstream ? "its upstream" : "origin"} — \`git push\` to share.`);
    }
  } else if (res.reason === "nothing to commit" || res.reason === "no tree change") {
    say("grepathy: why-pack already committed — nothing to sync.");
  } else {
    warn(`grepathy: did not commit the why-pack (${res.reason}). Left it in the working tree for you.`);
  }
  return code;
}
