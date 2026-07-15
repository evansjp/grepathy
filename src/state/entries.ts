import * as fs from "node:fs";
import { GrepathyPaths } from "../util/paths.js";
import { writeFileAtomic } from "../util/fsx.js";

/**
 * Shadow record of the last generated form of each why-pack entry. This is how
 * human edits are preserved forever: on regeneration we compare the entry on
 * disk against the last thing Grepathy generated. If they differ, a human
 * touched it — we leave it alone. If a shadow entry has no counterpart on disk,
 * a human deleted it — we suppress it instead of resurrecting it.
 */
export interface ShadowEntry {
  title: string;
  status: string;
  touches: string[];
  /** Hash of the full generated markdown block, last time we wrote it. */
  generatedHash: string;
}

export interface ShadowPack {
  /** Hash of the generated Intent section, last time we wrote it. */
  intentHash: string;
  /** Keyed by normalized entry id. */
  entries: Record<string, ShadowEntry>;
}

export interface ShadowStore {
  version: 1;
  packs: Record<string, ShadowPack>;
}

const EMPTY: ShadowStore = { version: 1, packs: {} };

export function readShadow(paths: GrepathyPaths): ShadowStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.entriesFile, "utf8"));
    if (parsed?.version === 1 && parsed.packs) return parsed as ShadowStore;
  } catch {
    // fresh install or corruption — start empty (repair rebuilds)
  }
  return { version: 1, packs: {} };
}

export function writeShadow(paths: GrepathyPaths, store: ShadowStore): void {
  writeFileAtomic(paths.entriesFile, JSON.stringify(store, null, 2));
}

export function emptyStore(): ShadowStore {
  return { ...EMPTY, packs: {} };
}

/** Normalize a decision title into a stable id for dedupe across runs. */
export function entryId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}
