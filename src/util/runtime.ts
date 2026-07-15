import * as fs from "node:fs";
import { repoRootFrom } from "./git.js";
import { grepathyPaths, GrepathyPaths } from "./paths.js";
import { GrepathyConfig, loadConfig } from "./config.js";

export interface Runtime {
  repoRoot: string;
  paths: GrepathyPaths;
  cfg: GrepathyConfig;
}

/** Resolve the repo + config for the current working directory. */
export function resolveRuntime(cwd = process.cwd()): Runtime | null {
  const repoRoot = repoRootFrom(cwd);
  if (!repoRoot) return null;
  return { repoRoot, paths: grepathyPaths(repoRoot), cfg: loadConfig(repoRoot) };
}

/** True if `grepathy init` has been run in this repo. */
export function isInitialized(paths: GrepathyPaths): boolean {
  return fs.existsSync(paths.stateDir) || fs.existsSync(paths.whyDir);
}
