import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRuntime } from "../util/runtime.js";
import { hooksDir } from "../util/git.js";
import { writeFileAtomic } from "../util/fsx.js";
import {
  removeBlock,
  infoExcludePath,
  EXCLUDE_FENCE,
  CLAUDE_LOCAL_FENCE,
} from "../util/exclude.js";
import { say, warn } from "../util/log.js";

const GREP_BEGIN = "# >>> grepathy managed >>>";
const GREP_END = "# <<< grepathy managed <<<";

/**
 * `grepathy uninstall` — remove hooks and local state. Committed why-packs and
 * `.grepathy.json` are left in place (they're the shared artifact).
 */
export function uninstall(): number {
  const rt = resolveRuntime();
  if (!rt) {
    warn("not inside a git repository.");
    return 1;
  }

  removeClaudeHooks(rt.repoRoot);
  removePrePushBlock(rt.repoRoot);
  removeClaudeMdBlock(rt.repoRoot);
  removeSelfOnlyBlocks(rt.repoRoot);

  try {
    fs.rmSync(rt.paths.stateDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  say("grepathy: uninstalled hooks and removed local state (.ai/grepathy).");
  say("Committed why-packs (.ai/why) and .grepathy.json were left untouched.");
  return 0;
}

/**
 * Strip the self-only additions: our block in `.git/info/exclude` and the
 * personal pointer in CLAUDE.local.md. Harmless in non-self-only repos (the
 * blocks simply aren't there). Why-pack files are left on disk, as with the
 * shared uninstall.
 */
function removeSelfOnlyBlocks(repoRoot: string): void {
  const excl = infoExcludePath(repoRoot);
  if (excl) removeBlock(excl, EXCLUDE_FENCE);
  removeBlock(path.join(repoRoot, "CLAUDE.local.md"), CLAUDE_LOCAL_FENCE);
}

/** Strip the grepathy pointer block from CLAUDE.md; remove the file if empty. */
function removeClaudeMdBlock(repoRoot: string): void {
  const file = path.join(repoRoot, "CLAUDE.md");
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (!contents.includes("<!-- grepathy:begin -->")) return;
  const re = /\n?<!-- grepathy:begin -->[\s\S]*?<!-- grepathy:end -->\n?/g;
  const stripped = contents.replace(re, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!stripped) {
    try {
      fs.rmSync(file);
    } catch {
      /* ignore */
    }
    return;
  }
  writeFileAtomic(file, stripped + "\n");
}

function removeClaudeHooks(repoRoot: string): void {
  for (const name of ["settings.local.json", "settings.json"]) {
    const file = path.join(repoRoot, ".claude", name);
    if (!fs.existsSync(file)) continue;
    let settings: any;
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      warn(`.claude/${name} unparseable — left untouched.`);
      continue;
    }
    if (!settings.hooks) continue;
    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = (settings.hooks[event] as any[])
        .map((g) => ({
          ...g,
          hooks: (g.hooks ?? []).filter((h: any) => !String(h.command).includes("grepathy")),
        }))
        .filter((g) => (g.hooks ?? []).length > 0);
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeFileAtomic(file, JSON.stringify(settings, null, 2) + "\n");
  }
}

function removePrePushBlock(repoRoot: string): void {
  const hd = hooksDir(repoRoot);
  if (!hd) return;
  const file = path.join(hd, "pre-push");
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (!contents.includes(GREP_BEGIN)) return;

  const re = new RegExp(`\\n?${escapeRe(GREP_BEGIN)}[\\s\\S]*?${escapeRe(GREP_END)}\\n?`, "g");
  const stripped = contents.replace(re, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();

  // If nothing but a shebang remains, remove the file entirely.
  if (/^#!.*\n*$/.test(stripped + "\n") || stripped.trim() === "" || /^#![^\n]*$/.test(stripped.trim())) {
    try {
      fs.rmSync(file);
    } catch {
      /* ignore */
    }
    return;
  }
  writeFileAtomic(file, stripped + "\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
