import { resolveRuntime, isInitialized } from "../util/runtime.js";
import { StateFile, writeSession, clearSessions } from "../state/state.js";
import { discoverAndSync, sessionsNeedingDistill } from "../core/sweep.js";
import { selectBackend } from "../distiller/backends.js";
import { distillSession } from "../core/distillSession.js";
import { say, warn } from "../util/log.js";

/**
 * `grepathy repair` — rebuild state from the raw transcript history and
 * re-distill. Existing why-pack files and human edits survive: the shadow
 * record makes any human-touched entry look human-owned, so it is preserved.
 */
export async function repair(): Promise<number> {
  const rt = resolveRuntime();
  if (!rt) {
    warn("not inside a git repository.");
    return 1;
  }
  if (!isInitialized(rt.paths)) {
    warn("run `grepathy init` first.");
    return 1;
  }

  // Rebuild state from scratch: clear per-session files, rediscover every
  // transcript, reset offsets so the whole history is reprocessed.
  clearSessions(rt.paths);
  const state: StateFile = { version: 1, sessions: {} };
  const added = discoverAndSync(rt.repoRoot, state);
  for (const [id, rec] of Object.entries(state.sessions)) {
    rec.last_distilled_offset = 0;
    rec.status = "dirty";
    writeSession(rt.paths, id, rec);
  }
  say(`grepathy: rebuilt state from ${added} transcript(s). Re-distilling…`);

  const targets = sessionsNeedingDistill(rt.repoRoot, state);
  if (targets.length === 0) {
    say("grepathy: no transcripts to process.");
    return 0;
  }

  const backend = selectBackend(rt.cfg);
  let changed = 0;
  let failed = 0;
  for (const id of targets) {
    try {
      const res = await distillSession(rt.repoRoot, id, state, rt.cfg, backend);
      if (res.ok && res.changed) changed++;
      else if (!res.ok) failed++;
    } catch (e: any) {
      warn(`distill ${id} failed: ${e.message}`);
      failed++;
    }
  }
  say(`grepathy: repair complete — ${changed} why-pack(s) updated, ${failed} failed.`);
  return failed > 0 ? 1 : 0;
}
