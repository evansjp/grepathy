import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { repoRootFrom, currentBranch } from "../util/git.js";
import { grepathyPaths } from "../util/paths.js";
import { GrepathyPaths } from "../util/paths.js";
import { isDisabled, loadConfig } from "../util/config.js";
import { isInitialized } from "../util/runtime.js";
import { selfCliPath } from "../util/self.js";
import { isoNow, warn, say, appendLog } from "../util/log.js";
import { readState, upsertSession, writeSession, readSession } from "../state/state.js";
import { collectContext } from "./context.js";
import { fileSize } from "../util/fsx.js";
import { selectBackend } from "../distiller/backends.js";
import { distillSession } from "../core/distillSession.js";
import { discoverAndSync, sessionsNeedingDistill } from "../core/sweep.js";
import { autoCommitWhyPack, whyPackGitStatus } from "../core/autocommit.js";
import { matchSessionToBranches } from "../matching.js";
import { relative } from "node:path";
import { isNonInteractive, waitForEnter } from "../util/tty.js";

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; [k: string]: unknown };
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseHookInput(raw: string): HookInput {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * The branches being pushed, from git's pre-push stdin (one line per ref:
 * "<local ref> <local sha> <remote ref> <remote sha>"). This is free branch
 * attribution — we file distilled decisions under the ref you actually push,
 * not the session's last-seen branch. Deletions (all-zero local sha) are skipped.
 */
export function parsePushedBranches(stdin: string): string[] {
  const branches = new Set<string>();
  for (const line of stdin.split("\n")) {
    const [localRef, localSha] = line.trim().split(/\s+/);
    if (!localRef || !localRef.startsWith("refs/heads/")) continue;
    if (/^0+$/.test(localSha ?? "")) continue; // branch deletion
    branches.add(localRef.slice("refs/heads/".length));
  }
  return [...branches];
}

/**
 * The pre-push budget is a hard cap, so on a big backlog some work is
 * deliberately deferred. Say so, with a next step — silently-deferred work is
 * exactly the "why is the why-pack stale on GitHub?" surprise this tool exists
 * to kill. `grepathy sync` runs unbudgeted, so it's the way to finish now.
 */
function deferralMessage(deferred: number, budgetMs: number): string {
  const s = deferred === 1 ? "" : "s";
  const secs = Math.round(budgetMs / 1000);
  return `${deferred} session${s} not fully distilled within the ${secs}s budget — run \`grepathy sync\` to finish now, or they'll be caught on your next push. Not blocking.`;
}

/** Resolve repo + guard clauses shared by all hooks. Returns null to no-op. */
function hookContext(cwd: string) {
  // Never let a hook fire while we are ourselves distilling via `claude -p`
  // (breaks the distill→claude→SessionEnd→distill recursion at the source).
  if (process.env.GREPATHY_DISTILLING === "1") return null;
  const repoRoot = repoRootFrom(cwd);
  if (!repoRoot) return null;
  const paths = grepathyPaths(repoRoot);
  if (!isInitialized(paths)) return null;
  if (isDisabled(paths)) return null;
  return { repoRoot, paths };
}

/**
 * Spawn a detached background distill of one session. Fire-and-forget.
 * `commit` passes `--commit` so the distill commits the why-pack afterward — set
 * at settle points (SessionEnd), left off for the frequent auto-distill tick so
 * we don't spam commit history.
 */
function spawnBackgroundDistill(
  paths: GrepathyPaths,
  repoRoot: string,
  sessionId: string,
  opts: { commit?: boolean } = {},
): void {
  try {
    let logFd = "ignore" as unknown as number;
    try {
      logFd = fs.openSync(path.join(paths.logsDir, "distill.log"), "a");
    } catch {
      /* fall back to ignore */
    }
    const args = [selfCliPath(), "distill", "--session", sessionId];
    if (opts.commit) args.push("--commit");
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } catch (e: any) {
    appendLog(paths.logsDir, "distill.log", `background distill spawn failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Stop: fast state record (<100ms), plus a debounced background auto-distill so
// the why-pack stays current as you work — no push, no manual ask needed.
// ---------------------------------------------------------------------------

export function hookStop(): number {
  const input = parseHookInput(readStdin());
  const cwd = input.cwd || process.cwd();
  const ctx = hookContext(cwd);
  if (!ctx || !input.session_id || !input.transcript_path) return 0;

  const { state } = readState(ctx.paths);
  const now = isoNow();
  // Capture the checked-out branch now, while the repo is known to be on it. A
  // no-commit investigation session stamps no gitBranch in its transcript, so
  // without this the automatic path can't attribute it and distills an empty
  // pack under the wrong branch. currentBranch is null on detached HEAD (skip).
  const branch = currentBranch(ctx.repoRoot) ?? undefined;
  const rec = upsertSession(
    state,
    input.session_id,
    {
      tool: "claude-code",
      transcript_path: input.transcript_path,
      repo: ctx.repoRoot,
      status: "dirty",
      last_branch: branch,
    },
    now,
  );

  // Debounced background distill: only when enough new transcript has
  // accumulated AND enough time has passed since the last background attempt.
  // The distill itself is detached and lock-guarded, so this never blocks the
  // agent and never overlaps another distill. Pre-push/SessionEnd still backstop.
  let fire = false;
  try {
    const cfg = loadConfig(ctx.repoRoot);
    if (cfg.autoDistill.enabled) {
      const grew = fileSize(input.transcript_path) - rec.last_distilled_offset >= cfg.autoDistill.minGrowthBytes;
      const lastAuto = rec.last_auto_distill_at ? Date.parse(rec.last_auto_distill_at) : 0;
      const due = Date.now() - lastAuto >= cfg.autoDistill.minIntervalMs;
      if (grew && due) {
        rec.last_auto_distill_at = now; // record intent so we don't re-fire every turn
        fire = true;
      }
    }
  } catch {
    /* config trouble → skip auto-distill; never block the agent */
  }

  try {
    // Write only THIS session's file — concurrent sessions never collide.
    writeSession(ctx.paths, input.session_id, rec);
  } catch {
    /* never block the agent */
  }

  if (fire) spawnBackgroundDistill(ctx.paths, ctx.repoRoot, input.session_id);
  return 0;
}

// ---------------------------------------------------------------------------
// SessionEnd: kick off detached background distillation.
// ---------------------------------------------------------------------------

export function hookSessionEnd(): number {
  const input = parseHookInput(readStdin());
  const cwd = input.cwd || process.cwd();
  const ctx = hookContext(cwd);
  if (!ctx || !input.session_id) return 0;

  // Make sure the session is recorded even if Stop never fired.
  const { state } = readState(ctx.paths);
  if (input.transcript_path) {
    const rec = upsertSession(
      state,
      input.session_id,
      {
        tool: "claude-code",
        transcript_path: input.transcript_path,
        repo: ctx.repoRoot,
        status: "dirty",
        // Same rationale as Stop: pin the branch while the repo is still on it,
        // so a no-commit session is attributed correctly at background distill.
        last_branch: currentBranch(ctx.repoRoot) ?? undefined,
      },
      isoNow(),
    );
    try {
      writeSession(ctx.paths, input.session_id, rec);
    } catch {
      /* ignore */
    }
  }

  // Detached background distill; logs to .ai/grepathy/logs/distill.log. This is
  // a settle point, so it commits the why-pack (if sync:"auto") — the distill
  // finishes, then commits, so the why-pack rides your next push instead of
  // sitting uncommitted until you happen to notice.
  spawnBackgroundDistill(ctx.paths, ctx.repoRoot, input.session_id, { commit: true });
  return 0;
}

// ---------------------------------------------------------------------------
// PreToolUse (Edit/Write): inject the why-pack entries touching the file about
// to be edited, so the agent encounters the "why" by mechanism, not by choosing
// to grep. Dumb-fast, LLM-free, once per file per session, never blocks.
// ---------------------------------------------------------------------------

export function hookPreToolUse(): number {
  const input = parseHookInput(readStdin());
  const cwd = input.cwd || process.cwd();
  const ctx = hookContext(cwd); // guards: distilling, not-a-repo, uninitialized, disabled
  if (!ctx || !input.session_id) return 0;

  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!file) return 0;
  const rel = path
    .relative(ctx.repoRoot, path.isAbsolute(file) ? file : path.join(ctx.repoRoot, file))
    .split(path.sep)
    .join("/");

  try {
    // Once per file per session: don't re-inject the same entries on every edit
    // (that trains the model to skim past them — banner blindness).
    const rec = readSession(ctx.paths, input.session_id);
    if (rec?.context_injected?.includes(rel)) return 0;

    const entries = collectContext(ctx.paths, ctx.repoRoot, rel);
    if (!entries) return 0; // nothing touches this file — stay silent, don't mark

    if (rec) {
      rec.context_injected = [...(rec.context_injected ?? []), rel];
      writeSession(ctx.paths, input.session_id, rec);
    }
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `Recorded design reasoning (why-pack) for ${rel} — consider before editing:\n\n${entries}`,
        },
      }),
    );
  } catch {
    /* additive context only — any error is a silent no-op, never block an edit */
  }
  return 0;
}

// ---------------------------------------------------------------------------
// pre-push: recovery sweep + share gate. Fails open, always.
// (isNonInteractive / waitForEnter now live in ../util/tty.js.)
// ---------------------------------------------------------------------------

export async function hookPrePush(): Promise<number> {
  // Git pipes the ref list on stdin — the branches actually being pushed.
  const pushed = parsePushedBranches(readStdin());
  const cwd = process.cwd();
  const ctx = hookContext(cwd);
  if (!ctx) return 0;

  // Attribute to the pushed ref(s); fall back to the current branch if git
  // didn't hand us any (e.g. a manual invocation).
  const targetBranches = pushed.length ? pushed : [currentBranch(ctx.repoRoot)].filter(Boolean) as string[];

  const cfg = loadConfig(ctx.repoRoot);
  const deadline = Date.now() + cfg.timeBudgetMs;

  try {
    const { state } = readState(ctx.paths);
    discoverAndSync(ctx.repoRoot, state); // finds sessions across all worktrees

    const ids = sessionsNeedingDistill(ctx.repoRoot, state);
    let distilledCount = 0;
    let deferred = 0; // sessions not fully distilled within the budget

    // Distill any dirty sessions (skipped entirely when there are none — but we
    // must NOT return early here: even with nothing to distill, a background
    // distill may have left the why-pack uncommitted, and the commit step below
    // is what actually gets it into git. Returning early on ids.length===0 was
    // the bug that let the working-tree why-pack outrun GitHub.
    if (ids.length > 0) {
      const backend = selectBackend(cfg);
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        if (Date.now() > deadline) {
          deferred += ids.length - k; // this one and the rest are untouched
          break;
        }
        // Decide which branch this session's decisions belong to: a pushed branch
        // it matches (recorded branch or file overlap), or — if exactly one branch
        // is being pushed — that one. Otherwise leave it for auto-distill/SessionEnd.
        const rec = state.sessions[id];
        const matches = targetBranches.length ? matchSessionToBranches(ctx.repoRoot, rec, targetBranches) : [];
        let branch: string | undefined;
        if (matches.length) branch = matches[0].branch;
        else if (targetBranches.length === 1) branch = targetBranches[0];
        else continue;

        let res;
        try {
          // Hard wall-clock cap: distillEvents stops between chunks past the
          // deadline and shrinks each call's timeout to the budget that remains,
          // so one big session can't blow the pre-push budget (the bug that made a
          // push hang for ~2 min). A truncated session stays dirty for later.
          res = await distillSession(ctx.repoRoot, id, state, cfg, backend, { branchOverride: branch, deadline });
        } catch (e: any) {
          appendLog(ctx.paths.logsDir, "prepush.log", `distill ${id} failed: ${e.message}`);
          continue;
        }
        if (res.ok && res.whyPack) distilledCount++;
        if (res.truncated) deferred++;
      }
    }
    const ranOutOfTime = deferred > 0;

    // Commit ANY uncommitted why-pack state, not only what THIS run distilled.
    // Frequent background (Stop-hook) distills write the pack but don't commit
    // (no history spam), so by push time the working-tree why-pack is usually
    // ahead of git. If we committed only this run's fresh distills, that
    // already-written change would sit uncommitted and GitHub would silently lag
    // — exactly the staleness this tool exists to kill. autoCommitWhyPack no-ops
    // when the pack is already clean, so this is safe to always attempt. It never
    // `git add`s: the commit is built on a scratch index, so a concurrent agent's
    // staged work is never swept in. git locked this push's refs before the hook
    // ran, so the commit rides your NEXT push (status shows it unpushed until then).
    let committedSomething = false;
    if (cfg.sync === "auto") {
      const res = autoCommitWhyPack(ctx.repoRoot);
      if (res.committed) {
        committedSomething = true;
        const files = (res.files ?? []).join(", ");
        say(
          distilledCount > 0
            ? `grepathy: distilled ${distilledCount} session${distilledCount === 1 ? "" : "s"} → committed ${files}. Rides your next push.`
            : `grepathy: committed ${files} (why-pack was ahead of git). Rides your next push.`,
        );
      } else if (res.reason && res.reason !== "nothing to commit" && res.reason !== "no tree change") {
        say(`grepathy: why-pack has uncommitted changes but couldn't auto-commit (${res.reason} — \`grepathy sync\` when ready).`);
      }
    } else if (whyPackGitStatus(ctx.repoRoot).uncommitted > 0) {
      // sync:"manual" — never commit; just make the staleness loud.
      committedSomething = true; // (reuse the review-gate path below)
      say("grepathy: why-pack has uncommitted changes (not staged — `grepathy sync` or commit when ready).");
    }

    if (ranOutOfTime) warn(deferralMessage(deferred, cfg.timeBudgetMs));
    if (committedSomething && !isNonInteractive()) {
      waitForEnter("grepathy: press Enter to continue the push (Ctrl-C to stop and review)… ");
    }
  } catch (e: any) {
    // Fail open, always.
    appendLog(ctx.paths.logsDir, "prepush.log", `pre-push sweep error: ${e.message}`);
  }
  return 0;
}
