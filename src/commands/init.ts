import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRuntime } from "../util/runtime.js";
import { grepathyPaths, GrepathyPaths } from "../util/paths.js";
import { defaultSharedConfig } from "../util/config.js";
import { ensureDir, writeFileAtomic } from "../util/fsx.js";
import { hookInvocation, hookFallback } from "../util/self.js";
import { hooksDir, trackedFilesUnder } from "../util/git.js";
import {
  ensureBlock,
  infoExcludePath,
  EXCLUDE_FENCE,
  CLAUDE_LOCAL_FENCE,
} from "../util/exclude.js";
import { say, warn } from "../util/log.js";
import { readState } from "../state/state.js";
import { discoverAndSync, sessionsNeedingDistill } from "../core/sweep.js";
import { isNonInteractive, promptYesNo } from "../util/tty.js";
import { distill } from "./distill.js";

const GREP_BEGIN = "# >>> grepathy managed >>>";
const GREP_END = "# <<< grepathy managed <<<";

export interface InitOptions {
  /** Personal mode: commit nothing, ignore artifacts via `.git/info/exclude`. */
  selfOnly?: boolean;
}

export async function init(opts: InitOptions = {}): Promise<number> {
  const rt = resolveRuntime();
  if (!rt) {
    warn("not inside a git repository. Run `git init` first, then `grepathy init`.");
    return 1;
  }
  const { repoRoot } = rt;
  const paths = grepathyPaths(repoRoot);
  const selfOnly = opts.selfOnly === true;

  // 1. Directories.
  ensureDir(paths.whyDir);
  ensureDir(paths.stateDir);
  ensureDir(paths.logsDir);
  const gitkeep = path.join(paths.whyDir, ".gitkeep");
  if (!fs.existsSync(gitkeep)) fs.writeFileSync(gitkeep, "");

  // 2 + 3. Config and ignoring. Self-only diverges here: nothing shared is
  // written or committed — the mode lives in local config and the artifacts are
  // ignored via the repo's private `.git/info/exclude`.
  if (selfOnly) {
    setupSelfOnly(repoRoot, paths);
  } else {
    setupShared(repoRoot, paths);
  }

  // 3b. Read-side pointer. Committed CLAUDE.md for teams; personal
  //     CLAUDE.local.md (git-excluded) in self-only mode.
  const claudeMdResult = selfOnly ? "CLAUDE.local.md (personal)" : ensureClaudeMd(repoRoot);

  // 4. Claude Code hooks (Stop + SessionEnd + PreToolUse context injection).
  const claudeResult = installClaudeHooks(repoRoot);

  // 5. Git pre-push hook.
  const prePushResult = installPrePushHook(repoRoot);

  // 6. Explain.
  say("");
  say(selfOnly ? "grepathy initialized (self-only, personal mode)." : "grepathy initialized.");
  say("");
  say("Installed:");
  if (selfOnly) {
    say(`  • .ai/why/            personal why-packs (never committed)`);
    say(`  • .git/info/exclude   ignores .ai/, CLAUDE.local.md, settings.local.json (private)`);
    say(`  • CLAUDE.local.md     ${claudeMdResult} (tells your agents to read .ai/why/)`);
  } else {
    say(`  • .ai/why/            shared why-packs (committed — this is what everyone reads)`);
    say(`  • .ai/grepathy/       local state (gitignored)`);
    say(`  • .grepathy.json      team config (committed — the only shared config)`);
    say(`  • CLAUDE.md pointer   ${claudeMdResult} (tells agents to read .ai/why/)`);
  }
  say(`  • Claude Code hooks   ${claudeResult} → .claude/settings.local.json (personal)`);
  say(`  • git pre-push hook   ${prePushResult}`);
  say("");
  if (selfOnly) {
    say("Self-only mode:");
    say("  Nothing grepathy produces is committed or shared. Why-packs are personal");
    say("  notes for you and your own future agents, ignored via .git/info/exclude.");
  } else {
    say("Privacy model:");
    say("  Your session transcript never leaves this machine. At session end (and as a");
    say("  catch-up at git push) Grepathy distills a privacy-filtered digest of the");
    say("  decisions — never your messages, never your questions — into .ai/why/. That");
    say("  markdown is the only shared artifact. Review before pushing; edits are kept.");
  }
  say("");
  say("Now just work. `claude`, let the agent commit, `git push`. That's it.");

  // 7. Offer to backfill from any prior local sessions for this repo.
  return offerBackfill(repoRoot);
}

/**
 * If this machine already has undistilled Claude sessions for the repo (the
 * common "adopting Grepathy on an existing project" case), offer to distill
 * them now. Interactive + default No: init stays fast and idempotent unless the
 * human explicitly opts in, and never runs a slow LLM job on CI or a stray key.
 * We distill into the working tree only — reviewing and committing stays the
 * human's call, exactly like the pre-push flow. Never commits, never stages.
 */
async function offerBackfill(repoRoot: string): Promise<number> {
  // Cheap: discover lists transcript files and stats sizes — no parsing, no LLM.
  const { state } = readState(grepathyPaths(repoRoot));
  discoverAndSync(repoRoot, state);
  const pending = sessionsNeedingDistill(repoRoot, state);
  if (pending.length === 0) return 0;

  const n = pending.length;
  const plural = n === 1 ? "session" : "sessions";
  if (isNonInteractive()) {
    say("");
    say(`grepathy: found ${n} prior Claude ${plural} for this repo not yet distilled.`);
    say("  Run `grepathy distill` to seed the why-pack from your local history.");
    return 0;
  }

  say("");
  const yes = promptYesNo(
    `grepathy: found ${n} prior Claude ${plural} for this repo.\n` +
      `  Distill them into a why-pack now? Runs the LLM locally, may take a few min.\n` +
      `  (Nothing is committed — you review .ai/why/ before sharing.) [y/N] `,
  );
  if (!yes) {
    say("  Skipped. Run `grepathy distill` whenever you're ready to backfill.");
    return 0;
  }

  say("");
  say(`grepathy: distilling ${n} ${plural}… (Ctrl-C to stop; partial progress is kept)`);
  const code = await distill({ allDirty: true });
  say("");
  say("grepathy: backfill done. Review .ai/why/ before you commit — nothing was staged.");
  return code;
}

/** Shared/team setup: committed config + local placeholder + shared gitignore. */
function setupShared(repoRoot: string, paths: GrepathyPaths): void {
  if (!fs.existsSync(paths.sharedConfigFile)) {
    writeFileAtomic(paths.sharedConfigFile, JSON.stringify(defaultSharedConfig(), null, 2) + "\n");
  }
  if (!fs.existsSync(paths.localConfigFile)) {
    writeFileAtomic(paths.localConfigFile, JSON.stringify({}, null, 2) + "\n");
  }
  ensureGitignore(repoRoot);
}

const CLAUDE_LOCAL_POINTER = [
  "## Design reasoning lives in `.ai/why/` (personal)",
  "",
  "grepathy runs here in self-only mode: it distills the *why* behind changes into",
  "`.ai/why/<branch>.md` as personal, git-excluded notes (never committed). Before",
  "working on unfamiliar code, run `grepathy context <file>` or grep `.ai/why/` to",
  "see the decisions that touch it.",
];

/**
 * Personal setup: persist the mode locally, ignore artifacts via the repo's
 * private `.git/info/exclude` at the highest-level dir (`.ai/`), and drop a
 * read-side pointer in CLAUDE.local.md. Writes nothing shared/committable.
 */
function setupSelfOnly(repoRoot: string, paths: GrepathyPaths): void {
  const local = readLocalConfig(paths);
  local.selfOnly = true;
  writeFileAtomic(paths.localConfigFile, JSON.stringify(local, null, 2) + "\n");

  // `.git/info/exclude` (like .gitignore) can't hide already-tracked files —
  // warn but proceed so the mode still applies to everything not yet committed.
  const tracked = trackedFilesUnder(repoRoot, ".ai");
  if (tracked.length) {
    warn(
      `${tracked.length} file(s) under .ai/ are already git-tracked; the self-only ` +
        "exclude can't hide them. Run `git rm --cached -r .ai` to untrack them yourself.",
    );
  }
  // Mirror the artifacts normal init would gitignore (.ai/ state + the personal
  // hooks file, which embeds machine paths), plus the personal pointer. `.claude/`
  // itself is NOT excluded — a repo may commit `.claude/settings.json`.
  const excl = infoExcludePath(repoRoot);
  if (excl) ensureBlock(excl, EXCLUDE_FENCE, [".ai/", "CLAUDE.local.md", ".claude/settings.local.json"]);
  else warn("could not resolve .git/info/exclude — artifacts were not ignored.");

  ensureBlock(path.join(repoRoot, "CLAUDE.local.md"), CLAUDE_LOCAL_FENCE, CLAUDE_LOCAL_POINTER);
}

function readLocalConfig(paths: GrepathyPaths): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.localConfigFile, "utf8"));
    // Guard against a hand-corrupted config (null/array/primitive) so setting
    // `.selfOnly` below can't throw and abort init.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ensureGitignore(repoRoot: string): void {
  const file = path.join(repoRoot, ".gitignore");
  // The state dir is local. The Claude hooks live in settings.local.json —
  // they bake this machine's path to grepathy, so they're personal, not shared.
  const wanted = [".ai/grepathy/", ".claude/settings.local.json"];
  let contents = "";
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    /* no gitignore yet */
  }
  const present = new Set(contents.split("\n").map((l) => l.trim()));
  const missing = wanted.filter((l) => !present.has(l));
  if (missing.length === 0) return;
  const prefix = contents && !contents.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(file, `${prefix}\n# Grepathy (local, per-machine)\n${missing.join("\n")}\n`);
}

const CLAUDE_MD_BEGIN = "<!-- grepathy:begin -->";
const CLAUDE_MD_END = "<!-- grepathy:end -->";
const CLAUDE_MD_BLOCK = `${CLAUDE_MD_BEGIN}
## Design reasoning lives in \`.ai/why/\`

This repo records the *why* behind its code in \`.ai/why/<branch>.md\` ("why-packs"),
distilled from AI coding sessions. **The why-pack is the ground truth for *why* —
prefer it over commit messages, which are lossy and can be out of date.**

- Before working on unfamiliar code, run \`grepathy context <file>\` (or grep
  \`.ai/why/\`) to see the decisions that touch it.
- When asked what changed on a branch, or *why* something is the way it is, read
  \`.ai/why/<branch>.md\` — not just \`git log\`.
- \`grep -rn "agent-initiated" .ai/why/\` surfaces decisions an agent made
  unilaterally, with no human sign-off — scrutinize these first.

Commits titled \`grepathy: update why-pack (…)\` are written by the tool (the
why-pack only, via a scratch index — they never touch your staged work). They're
safe to rebase past or drop; don't amend them into your feature commits.
${CLAUDE_MD_END}`;

/**
 * Point agents at the why-packs from CLAUDE.md — the file Claude Code auto-loads
 * into every session. This is the read-side trigger for the "explain / review /
 * what changed" moments, which are conversations, not edits, so no PreToolUse
 * hook fires. Idempotent; never clobbers existing content.
 */
export function ensureClaudeMd(repoRoot: string): string {
  const file = path.join(repoRoot, "CLAUDE.md");
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    /* no CLAUDE.md yet */
  }
  if (existing.includes(CLAUDE_MD_BEGIN)) {
    // Refresh the managed block in place if it's out of date (e.g. this machine
    // upgraded grepathy). Only our marked region is touched; the rest is the
    // user's. Idempotent when already current.
    const re = new RegExp(`${escapeRe(CLAUDE_MD_BEGIN)}[\\s\\S]*?${escapeRe(CLAUDE_MD_END)}`);
    const current = existing.match(re)?.[0];
    if (current === CLAUDE_MD_BLOCK) return "already present";
    writeFileAtomic(file, existing.replace(re, CLAUDE_MD_BLOCK));
    return "updated";
  }
  if (!existing.trim()) {
    fs.writeFileSync(file, CLAUDE_MD_BLOCK + "\n");
    return "created";
  }
  const prefix = existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${prefix}\n${CLAUDE_MD_BLOCK}\n`);
  return "appended";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ClaudeSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  [k: string]: unknown;
}

function installClaudeHooks(repoRoot: string): string {
  const dir = path.join(repoRoot, ".claude");
  ensureDir(dir);
  // Hooks go in settings.local.json (personal, gitignored): the fallback
  // command embeds this machine's absolute path to grepathy, so it must not be
  // committed and shared with the team. .grepathy.json carries shared config.
  const file = path.join(dir, "settings.local.json");
  let settings: ClaudeSettings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      warn("existing .claude/settings.local.json is not valid JSON — leaving it untouched.");
      return "SKIPPED (settings.local.json unparseable)";
    }
  }
  settings.hooks = settings.hooks ?? {};

  const added = [
    addClaudeHook(settings, "Stop", hookInvocation("hook stop"), "hook stop"),
    addClaudeHook(settings, "SessionEnd", hookInvocation("hook session-end"), "hook session-end"),
    // PreToolUse: inject why-pack entries touching the file being edited, so the
    // agent encounters the "why" before it changes code — mechanically, not by
    // choosing to look. Additive context only; never blocks the edit.
    addClaudeHook(settings, "PreToolUse", hookInvocation("hook pre-tool-use"), "hook pre-tool-use", "Edit|Write|MultiEdit"),
  ];

  writeFileAtomic(file, JSON.stringify(settings, null, 2) + "\n");
  return added.some(Boolean) ? "installed (Stop, SessionEnd, PreToolUse)" : "already present";
}

/** Add a hook command idempotently; returns true if newly added. */
function addClaudeHook(
  settings: ClaudeSettings,
  event: string,
  command: string,
  marker: string,
  matcher?: string,
): boolean {
  const groups = settings.hooks![event] ?? (settings.hooks![event] = []);
  const already = groups.some((g) => g.hooks?.some((h) => h.command?.includes(marker)));
  if (already) return false;
  groups.push(matcher ? { matcher, hooks: [{ type: "command", command }] } : { hooks: [{ type: "command", command }] });
  return true;
}

function installPrePushHook(repoRoot: string): string {
  const hd = hooksDir(repoRoot);
  if (!hd) return "SKIPPED (no hooks dir)";
  ensureDir(hd);
  const file = path.join(hd, "pre-push");

  const managed = [
    GREP_BEGIN,
    "if command -v grepathy >/dev/null 2>&1; then",
    "  grepathy hook pre-push || true",
    "else",
    `  ${hookFallback("hook pre-push")} || true`,
    "fi",
    GREP_END,
    "",
  ].join("\n");

  let existing = "";
  if (fs.existsSync(file)) existing = fs.readFileSync(file, "utf8");

  if (existing.includes(GREP_BEGIN)) {
    return "already present";
  }

  let out: string;
  let verb: string;
  if (!existing.trim()) {
    out = `#!/bin/sh\n${managed}`;
    verb = "installed";
  } else {
    // Chain: append our guarded block to the existing hook, never clobber.
    const prefix = existing.endsWith("\n") ? "" : "\n";
    out = `${existing}${prefix}\n${managed}`;
    verb = "chained onto existing hook";
  }
  writeFileAtomic(file, out);
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* best effort */
  }

  const managers: string[] = [];
  if (fs.existsSync(path.join(repoRoot, ".husky"))) managers.push("husky");
  if (
    fs.existsSync(path.join(repoRoot, "lefthook.yml")) ||
    fs.existsSync(path.join(repoRoot, "lefthook.yaml"))
  )
    managers.push("lefthook");
  if (managers.length) {
    say(`  (detected ${managers.join(", ")} — grepathy's block was chained; keep it if you re-run their install)`);
  }

  return verb;
}
