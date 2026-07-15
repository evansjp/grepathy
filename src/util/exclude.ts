import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { writeFileAtomic } from "./fsx.js";

/** A pair of marker lines delimiting a grepathy-managed region of a text file. */
export interface Fence {
  begin: string;
  end: string;
}

/** Fence for `.git/info/exclude` (shell-style `#` comments). */
export const EXCLUDE_FENCE: Fence = {
  begin: "# >>> grepathy self-only >>>",
  end: "# <<< grepathy self-only <<<",
};

/** Fence for `CLAUDE.local.md` (markdown/HTML comments). */
export const CLAUDE_LOCAL_FENCE: Fence = {
  begin: "<!-- grepathy:self-only:begin -->",
  end: "<!-- grepathy:self-only:end -->",
};

/** Absolute path to this repo's private, per-machine exclude file. */
export function infoExcludePath(repoRoot: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  const p = r.stdout.trim();
  return p.startsWith("/") ? p : `${repoRoot}/${p}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ensure `file` holds exactly one fenced block wrapping `lines`. Idempotent:
 * creates the file if absent, replaces an out-of-date block in place, otherwise
 * appends after existing content. Never touches text outside the fence.
 */
export function ensureBlock(file: string, fence: Fence, lines: string[]): void {
  const block = [fence.begin, ...lines, fence.end].join("\n");
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    /* new file */
  }

  if (existing.includes(fence.begin)) {
    const re = new RegExp(`${escapeRe(fence.begin)}[\\s\\S]*?${escapeRe(fence.end)}`);
    const next = existing.replace(re, block);
    if (next !== existing) writeFileAtomic(file, next);
    return;
  }
  if (!existing) {
    writeFileAtomic(file, block + "\n");
    return;
  }
  const prefix = existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${prefix}\n${block}\n`);
}

/**
 * Remove the fenced block from `file` if present. If nothing but whitespace
 * remains afterwards, the file is deleted (a file that only ever held our block
 * shouldn't linger). Absent block or missing file: no-op.
 */
export function removeBlock(file: string, fence: Fence): void {
  let existing: string;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (!existing.includes(fence.begin)) return;

  const re = new RegExp(`\\n?${escapeRe(fence.begin)}[\\s\\S]*?${escapeRe(fence.end)}\\n?`, "g");
  const stripped = existing.replace(re, "\n").replace(/\n{3,}/g, "\n\n");
  if (!stripped.trim()) {
    try {
      fs.rmSync(file);
    } catch {
      /* ignore */
    }
    return;
  }
  writeFileAtomic(file, stripped.trimEnd() + "\n");
}
