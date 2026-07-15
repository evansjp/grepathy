import * as fs from "node:fs";
import * as path from "node:path";
import { GrepathyPaths, sessionFilePath } from "../util/paths.js";
import { writeFileAtomic, ensureDir } from "../util/fsx.js";

export type SessionStatus = "dirty" | "distilled";

export interface SessionRecord {
  tool: string;
  transcript_path: string;
  repo: string;
  branches_seen: string[];
  /** Branch checked out when the Stop/SessionEnd hook last fired — the reliable
   *  attribution signal for a no-commit session whose transcript stamped no
   *  gitBranch (captured while the repo was known to be on it). */
  last_branch?: string;
  files_touched: string[];
  first_seen: string;
  last_seen: string;
  last_distilled_offset: number;
  status: SessionStatus;
  /** Branches this session's entries were written to (for status/repair). */
  distilled_to?: string[];
  /** ISO time of the last debounced background (Stop-hook) distill attempt. */
  last_auto_distill_at?: string;
  /** Repo-relative files this session already got why-pack context injected for
   *  (so the PreToolUse hook injects each file's entries at most once/session). */
  context_injected?: string[];
}

export interface StateFile {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

/**
 * State is stored as ONE JSON file per session under `.ai/grepathy/sessions/`.
 * Concurrent agents (several Claude sessions, or several git worktrees of the
 * same repo) each write only their own file, so no writer ever clobbers
 * another's record — the failure a single shared state.json would have.
 */

/**
 * Read all session records into an aggregate map. Corruption is isolated: a bad
 * per-session file is skipped, not fatal. Also performs a one-time migration
 * from the legacy single `state.json`.
 */
export function readState(paths: GrepathyPaths): { state: StateFile; corrupt: boolean } {
  migrateLegacyState(paths);

  const sessions: Record<string, SessionRecord> = {};
  let corrupt = false;
  let files: string[] = [];
  try {
    files = fs.readdirSync(paths.sessionsDir);
  } catch {
    // No sessions dir yet — fresh install.
    return { state: { version: 1, sessions }, corrupt: false };
  }
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const id = name.replace(/\.json$/, "");
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(paths.sessionsDir, name), "utf8"));
      if (rec && typeof rec === "object" && rec.tool && rec.transcript_path) {
        sessions[id] = rec as SessionRecord;
      } else {
        corrupt = true;
      }
    } catch {
      corrupt = true; // one bad file doesn't lose the rest
    }
  }
  return { state: { version: 1, sessions }, corrupt };
}

/** Persist a single session's record. Writers only ever touch their own file. */
export function writeSession(paths: GrepathyPaths, sessionId: string, record: SessionRecord): void {
  writeFileAtomic(sessionFilePath(paths, sessionId), JSON.stringify(record, null, 2));
}

/** Read one session's record directly (fast — no full-directory scan). */
export function readSession(paths: GrepathyPaths, sessionId: string): SessionRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(sessionFilePath(paths, sessionId), "utf8"));
    return rec && typeof rec === "object" ? (rec as SessionRecord) : null;
  } catch {
    return null;
  }
}

/** Remove a session's file (used by repair when rebuilding from scratch). */
export function deleteSession(paths: GrepathyPaths, sessionId: string): void {
  try {
    fs.rmSync(sessionFilePath(paths, sessionId));
  } catch {
    /* already gone */
  }
}

/** Clear every session record (repair rebuilds from transcripts). */
export function clearSessions(paths: GrepathyPaths): void {
  try {
    fs.rmSync(paths.sessionsDir, { recursive: true, force: true });
  } catch {
    /* nothing to clear */
  }
}

/**
 * Insert or update a session record in the in-memory map, merging seen
 * branches/files. Callers persist the touched session via `writeSession`.
 */
export function upsertSession(
  state: StateFile,
  sessionId: string,
  patch: Partial<SessionRecord> & Pick<SessionRecord, "tool" | "transcript_path" | "repo">,
  now: string,
): SessionRecord {
  const existing = state.sessions[sessionId];
  if (!existing) {
    const rec: SessionRecord = {
      tool: patch.tool,
      transcript_path: patch.transcript_path,
      repo: patch.repo,
      branches_seen: patch.branches_seen ?? [],
      last_branch: patch.last_branch,
      files_touched: patch.files_touched ?? [],
      first_seen: patch.first_seen ?? now,
      last_seen: patch.last_seen ?? now,
      last_distilled_offset: patch.last_distilled_offset ?? 0,
      status: patch.status ?? "dirty",
      distilled_to: patch.distilled_to,
    };
    state.sessions[sessionId] = rec;
    return rec;
  }
  existing.last_seen = patch.last_seen ?? now;
  existing.transcript_path = patch.transcript_path || existing.transcript_path;
  if (patch.branches_seen) existing.branches_seen = union(existing.branches_seen, patch.branches_seen);
  if (patch.last_branch) existing.last_branch = patch.last_branch;
  if (patch.files_touched) existing.files_touched = union(existing.files_touched, patch.files_touched);
  if (patch.last_distilled_offset !== undefined) existing.last_distilled_offset = patch.last_distilled_offset;
  if (patch.status) existing.status = patch.status;
  if (patch.distilled_to) existing.distilled_to = union(existing.distilled_to ?? [], patch.distilled_to);
  return existing;
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** One-time: split a legacy state.json into per-session files, then remove it. */
function migrateLegacyState(paths: GrepathyPaths): void {
  let legacy: any;
  try {
    legacy = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
  } catch {
    return; // no legacy file (the normal case)
  }
  if (legacy && legacy.sessions && typeof legacy.sessions === "object") {
    ensureDir(paths.sessionsDir);
    for (const [id, rec] of Object.entries(legacy.sessions)) {
      const target = sessionFilePath(paths, id);
      if (!fs.existsSync(target)) {
        try {
          writeFileAtomic(target, JSON.stringify(rec, null, 2));
        } catch {
          /* best effort */
        }
      }
    }
  }
  try {
    fs.rmSync(paths.stateFile);
  } catch {
    /* another process may have removed it already */
  }
}
