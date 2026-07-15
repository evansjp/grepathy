import * as fs from "node:fs";
import { resolveRuntime, isInitialized } from "../util/runtime.js";
import { ensureDir } from "../util/fsx.js";
import { say, warn } from "../util/log.js";

/** `grepathy off` — disable hooks without uninstalling. */
export function off(): number {
  const rt = guard();
  if (!rt) return 1;
  ensureDir(rt.paths.stateDir);
  fs.writeFileSync(rt.paths.disabledFlag, `disabled ${new Date().toISOString()}\n`);
  say("grepathy: hooks disabled. They stay installed but no-op until `grepathy on`.");
  return 0;
}

/** `grepathy on` — re-enable hooks. */
export function on(): number {
  const rt = guard();
  if (!rt) return 1;
  try {
    fs.rmSync(rt.paths.disabledFlag);
  } catch {
    /* already enabled */
  }
  say("grepathy: hooks enabled.");
  return 0;
}

function guard() {
  const rt = resolveRuntime();
  if (!rt) {
    warn("not inside a git repository.");
    return null;
  }
  if (!isInitialized(rt.paths)) {
    warn("not initialized here. Run `grepathy init`.");
    return null;
  }
  return rt;
}
