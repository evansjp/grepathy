import * as fs from "node:fs";
import * as path from "node:path";

/** User-facing stdout line (kept terse — hooks print into git output). */
export function say(msg: string): void {
  process.stdout.write(msg + "\n");
}

/** Non-fatal warning to stderr. */
export function warn(msg: string): void {
  process.stderr.write(`grepathy: ${msg}\n`);
}

/**
 * Append a line to a background log file. Used by detached distill runs whose
 * stdout/stderr nobody is watching. Never throws.
 */
export function appendLog(logsDir: string, name: string, msg: string): void {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const line = `${isoNow()} ${msg}\n`;
    fs.appendFileSync(path.join(logsDir, name), line);
  } catch {
    // logging must never break the caller
  }
}

/**
 * ISO timestamp helper. Isolated here so tests can reason about it; real time
 * is fine in production (unlike workflow scripts, the CLI may read the clock).
 */
export function isoNow(): string {
  return new Date().toISOString();
}
