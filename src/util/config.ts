import * as fs from "node:fs";
import { grepathyPaths, GrepathyPaths } from "./paths.js";

export type DistillerBackend = "claude" | "api";

export interface GrepathyConfig {
  /** Distiller backend + model. */
  distiller: {
    backend: DistillerBackend;
    /** Model alias for the claude CLI, or model id for the API backend. */
    model: string;
    /**
     * How many transcript chunks to distill concurrently. A big session is many
     * chunks, and one-at-a-time is what made the pre-push sweep blow its budget.
     * Kept low by default: the `claude` backend spawns a subprocess per call, so
     * 3 is a safe "usually finishes in budget" without thrashing. Heavy users on
     * `backend: "api"` (plain HTTP, no subprocess) can raise it.
     */
    concurrency: number;
  };
  /** Extra redaction regexes (source strings, applied case-insensitively). */
  redaction: string[];
  /** Hard wall-clock budget for the pre-push sweep, in milliseconds. */
  timeBudgetMs: number;
  /** Max characters of prepared transcript per LLM chunk. */
  chunkChars: number;
  /**
   * Debounced background distillation on the Stop hook, so the why-pack stays
   * current as you work — no push, no manual ask. Still post-hoc distillation
   * of the complete-so-far transcript (not in-flight logging); pre-push and
   * SessionEnd remain the backstops, so this errs quiet.
   */
  autoDistill: {
    enabled: boolean;
    /** Minimum time between background distills of a session. */
    minIntervalMs: number;
    /** Minimum new transcript bytes since last distill before firing. */
    minGrowthBytes: number;
  };
  /**
   * How the why-pack reaches git.
   * - "auto" (default): commit `.ai/why/` — never push — at settle points
   *   (session end and the pre-push sweep), built via a scratch index that never
   *   touches your staging area, so it rides your next push and GitHub stops
   *   silently lagging. A local commit isn't sharing; push stays the human gate.
   * - "manual": never commit; `status`/`doctor`/pre-push just report staleness
   *   loudly and you run `grepathy sync`. For shops where a tool authoring
   *   commits is a hard no (commit-signing, CI conventions).
   */
  sync: "auto" | "manual";
  /**
   * Personal mode (set by `grepathy init --self-only`, stored local-only). The
   * why-packs become private notes: nothing is committed and the artifacts are
   * ignored via `.git/info/exclude` rather than the shared `.gitignore`. When
   * true, effective `sync` is forced to "manual" so no code path commits.
   */
  selfOnly: boolean;
}

export const DEFAULT_CONFIG: GrepathyConfig = {
  distiller: {
    backend: "claude",
    model: "haiku",
    concurrency: 3,
  },
  redaction: [],
  timeBudgetMs: 60_000,
  chunkChars: 100_000,
  autoDistill: {
    enabled: true,
    minIntervalMs: 180_000, // 3 min
    minGrowthBytes: 15_360, // 15 KB
  },
  sync: "auto",
  selfOnly: false,
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function deepMerge<T>(base: T, override: Record<string, unknown> | null): T {
  if (!override) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === null || v === undefined) continue;
    if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof out[k] === "object" &&
      out[k] !== null &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Effective config = defaults <- committed .grepathy.json <- local
 * .ai/grepathy/config.json (machine-specific overrides).
 */
export function loadConfig(repoRoot: string): GrepathyConfig {
  const paths = grepathyPaths(repoRoot);
  let cfg = DEFAULT_CONFIG;
  cfg = deepMerge(cfg, readJson(paths.sharedConfigFile));
  cfg = deepMerge(cfg, readJson(paths.localConfigFile));
  // Self-only is a personal "never commit" mode: force sync to manual so no
  // settle-point or explicit commit path can fire, whatever the shared config says.
  if (cfg.selfOnly) cfg = { ...cfg, sync: "manual" };
  return cfg;
}

/** The team-shared config written by `init` (committed). */
export function defaultSharedConfig(): Record<string, unknown> {
  return {
    distiller: { backend: DEFAULT_CONFIG.distiller.backend, model: DEFAULT_CONFIG.distiller.model },
    redaction: [],
    timeBudgetMs: DEFAULT_CONFIG.timeBudgetMs,
    sync: DEFAULT_CONFIG.sync,
  };
}

export function isDisabled(paths: GrepathyPaths): boolean {
  return fs.existsSync(paths.disabledFlag);
}
