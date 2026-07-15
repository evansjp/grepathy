import * as fs from "node:fs";
import { grepathyPaths } from "../util/paths.js";
import { whyPackPath, slugifyBranch, lockFilePath } from "../util/paths.js";
import { GrepathyConfig } from "../util/config.js";
import { isoNow } from "../util/log.js";
import { writeFileAtomic, ensureDir, acquireLock } from "../util/fsx.js";
import { adapterFor } from "../adapters/index.js";
import {
  StateFile,
  SessionRecord,
  writeSession,
  upsertSession,
} from "../state/state.js";
import { ShadowStore, readShadow, writeShadow } from "../state/entries.js";
import { LLMBackend } from "../distiller/backends.js";
import { distillEvents } from "../distiller/index.js";
import { parsePack, mergePack } from "../distiller/whypack.js";
import { renderPack } from "../distiller/whypack.js";
import { currentBranch, branchExists } from "../util/git.js";

export interface DistillSessionResult {
  ok: boolean;
  sessionId: string;
  branch?: string;
  whyPack?: string;
  addedTitles: string[];
  updatedTitles: string[];
  changed: boolean;
  reason?: string;
  partialFailures?: number;
  /** The time budget was hit mid-session — a partial pack was written, the
   *  session stays dirty (offset intact) for a later unbudgeted distill. */
  truncated?: boolean;
}

/**
 * Distill one session incrementally (only new bytes since last_distilled_offset)
 * and merge the result into its branch's why-pack, preserving human edits.
 * Mutates `state`/`shadow` in memory and persists them. Never throws; failures
 * leave the session dirty for the next pre-push sweep to retry.
 */
export async function distillSession(
  repoRoot: string,
  sessionId: string,
  state: StateFile,
  cfg: GrepathyConfig,
  backend: LLMBackend,
  opts: { branchOverride?: string; deadline?: number } = {},
): Promise<DistillSessionResult> {
  const paths = grepathyPaths(repoRoot);
  const record = state.sessions[sessionId];
  const base: DistillSessionResult = {
    ok: false,
    sessionId,
    addedTitles: [],
    updatedTitles: [],
    changed: false,
  };

  if (!record) {
    return { ...base, reason: "unknown session" };
  }
  const adapter = adapterFor(record.tool);
  if (!adapter) {
    return { ...base, reason: `no adapter for tool '${record.tool}'` };
  }
  if (!fs.existsSync(record.transcript_path)) {
    return { ...base, reason: "transcript not found" };
  }

  // Serialize distills of the same session so Stop-auto / SessionEnd / pre-push
  // triggers can't run over each other. If another holds the lock, skip quietly.
  const releaseLock = acquireLock(lockFilePath(paths, sessionId));
  if (!releaseLock) {
    return { ...base, ok: true, changed: false, reason: "another distill in progress" };
  }

  try {
  let raw: string;
  let newOffset: number;
  try {
    const read = adapter.readTranscript(record.transcript_path, record.last_distilled_offset);
    raw = read.raw;
    newOffset = read.newOffset;
  } catch (e: any) {
    return { ...base, reason: `read failed: ${e.message}` };
  }

  // Refresh state metadata from whatever we just read (branches/files/times).
  const meta = adapter.extractMeta(raw);
  const now = isoNow();
  upsertSession(
    state,
    sessionId,
    {
      tool: record.tool,
      transcript_path: record.transcript_path,
      repo: record.repo,
      branches_seen: meta.branches,
      files_touched: meta.files,
      last_seen: meta.lastTs ?? now,
    },
    now,
  );

  if (!raw.trim()) {
    // Nothing new to distill; mark clean and move on.
    record.last_distilled_offset = newOffset;
    record.status = "distilled";
    writeSession(paths, sessionId, record);
    return { ...base, ok: true, changed: false, reason: "no new content" };
  }

  // Resolve the target branch and read its existing pack BEFORE distilling, so
  // the distiller can be shown the titles already recorded there and reuse them
  // verbatim for the same decision (title-anchored dedupe). Branch resolution
  // doesn't depend on the distiller output, so this reordering is safe.
  const branch = resolveBranch(repoRoot, record, opts.branchOverride);
  const slug = slugifyBranch(branch);
  const packPath = whyPackPath(paths, branch);
  const existing = fs.existsSync(packPath) ? parsePack(slug, fs.readFileSync(packPath, "utf8")) : null;
  const knownTitles = existing?.entries.map((e) => e.title) ?? [];

  const events = adapter.normalizeEvents(raw);
  const outcome = await distillEvents(events, cfg, backend, { knownTitles, deadline: opts.deadline });
  if (!outcome.ok) {
    // Stay dirty; retried at next pre-push. Push is never blocked by this.
    record.status = "dirty";
    writeSession(paths, sessionId, record);
    return { ...base, reason: outcome.reason ?? "distillation failed", truncated: outcome.truncated };
  }

  const shadow: ShadowStore = readShadow(paths);
  const merge = mergePack(slug, existing, shadow.packs[slug], outcome.pack);

  const rendered = renderPack(merge.pack, now.slice(0, 10));
  const previous = existing ? fs.readFileSync(packPath, "utf8") : "";
  const changed = rendered !== previous;

  if (changed) {
    ensureDir(paths.whyDir);
    writeFileAtomic(packPath, rendered);
  }
  shadow.packs[slug] = merge.shadow;
  writeShadow(paths, shadow);

  // On truncation the partial pack IS written (progress preserved), but the
  // session stays dirty with its offset UNCHANGED: a later unbudgeted distill
  // re-reads the same delta, re-distills every chunk, and merges — the redone
  // chunks dedupe in place via title-anchoring, so no duplicates, and the offset
  // only advances once the whole delta is distilled. Advancing here would strand
  // the chunks the deadline skipped.
  if (outcome.truncated) {
    record.status = "dirty";
  } else {
    record.last_distilled_offset = newOffset;
    record.status = "distilled";
  }
  record.distilled_to = [...new Set([...(record.distilled_to ?? []), branch])];
  writeSession(paths, sessionId, record);

  return {
    ok: true,
    sessionId,
    branch,
    whyPack: packPath,
    truncated: outcome.truncated,
    addedTitles: merge.addedTitles,
    updatedTitles: merge.updatedTitles,
    changed,
    partialFailures: outcome.partialFailures,
  };
  } finally {
    releaseLock();
  }
}

function resolveBranch(repoRoot: string, record: SessionRecord, override?: string): string {
  if (override) return override;
  // The branch checked out while the session was active, captured at hook time
  // (Stop/SessionEnd) while the repo was known to be on it. This is the reliable
  // signal for a no-commit session: its transcript stamps no gitBranch, so
  // without this it would fall through to whatever branch happens to be checked
  // out at background-distill time — filing an empty/misattributed pack.
  if (record.last_branch && branchExists(repoRoot, record.last_branch)) return record.last_branch;
  // Otherwise the most-recently-seen branch that STILL EXISTS. A session that
  // touched a since-deleted branch (its slug lingering at the tail of
  // branches_seen) must not resurrect that branch's orphaned why-pack on the
  // next auto-distill — pick the newest surviving branch instead.
  for (let i = record.branches_seen.length - 1; i >= 0; i--) {
    const b = record.branches_seen[i];
    if (branchExists(repoRoot, b)) return b;
  }
  return currentBranch(repoRoot) ?? "main";
}
