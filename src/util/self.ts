import { fileURLToPath } from "node:url";
import * as path from "node:path";

/** Absolute path to this package's built CLI entry (dist/cli.js). */
export function selfCliPath(): string {
  const here = fileURLToPath(import.meta.url); // dist/util/self.js
  return path.resolve(path.dirname(here), "..", "cli.js");
}

export function nodeBin(): string {
  return process.execPath;
}

/**
 * Shell command that runs a grepathy subcommand, preferring a `grepathy` on
 * PATH and falling back to invoking this exact CLI via node. Used inside hook
 * scripts so they work whether or not grepathy is globally installed.
 */
export function hookInvocation(sub: string): string {
  return `command -v grepathy >/dev/null 2>&1 && grepathy ${sub} || ${hookFallback(sub)}`;
}

/** Just the node-based fallback invocation (no PATH lookup). */
export function hookFallback(sub: string): string {
  return `"${nodeBin()}" "${selfCliPath()}" ${sub}`;
}
