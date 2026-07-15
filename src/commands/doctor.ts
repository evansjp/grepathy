import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRuntime, isInitialized } from "../util/runtime.js";
import { isDisabled } from "../util/config.js";
import { readState } from "../state/state.js";
import { discoverAndSync, sessionsNeedingDistill } from "../core/sweep.js";
import { claudeProjectDirFor } from "../util/paths.js";
import { hooksDir } from "../util/git.js";
import { whyPackGitStatus } from "../core/autocommit.js";
import { spawnSync } from "node:child_process";
import { say, warn } from "../util/log.js";

const OK = "✓";
const BAD = "✗";
const MEH = "•";

/** `grepathy doctor` — health check. */
export function doctor(): number {
  const rt = resolveRuntime();
  if (!rt) {
    warn("not inside a git repository.");
    return 1;
  }

  let problems = 0;
  const line = (mark: string, msg: string) => say(`  ${mark} ${msg}`);

  say("grepathy doctor");
  say("");

  // Initialized?
  if (isInitialized(rt.paths)) line(OK, "initialized (.ai/ present)");
  else {
    line(BAD, "not initialized — run `grepathy init`");
    problems++;
  }

  // Disabled?
  if (isDisabled(rt.paths)) line(MEH, "hooks currently DISABLED (`grepathy on` to re-enable)");

  // Claude Code hooks.
  const claude = claudeHooksInstalled(rt.repoRoot);
  if (claude.stop && claude.sessionEnd && claude.preToolUse) {
    line(OK, "Claude Code hooks installed (Stop, SessionEnd, PreToolUse)");
  } else {
    line(
      BAD,
      `Claude Code hooks missing (Stop:${claude.stop ? "y" : "n"} SessionEnd:${claude.sessionEnd ? "y" : "n"} PreToolUse:${claude.preToolUse ? "y" : "n"}) — re-run init`,
    );
    problems++;
  }

  // CLAUDE.md pointer (the read-side trigger for explain/review moments).
  try {
    if (fs.readFileSync(path.join(rt.repoRoot, "CLAUDE.md"), "utf8").includes("grepathy:begin")) {
      line(OK, "CLAUDE.md points agents at .ai/why/");
    } else {
      line(MEH, "CLAUDE.md has no grepathy pointer — re-run init so agents know to read .ai/why/");
    }
  } catch {
    line(MEH, "no CLAUDE.md — agents won't be told to read .ai/why/; re-run init");
  }

  // git pre-push hook.
  if (prePushInstalled(rt.repoRoot)) line(OK, "git pre-push hook installed");
  else {
    line(BAD, "git pre-push hook missing — re-run init");
    problems++;
  }

  // Transcripts discoverable?
  const dir = claudeProjectDirFor(rt.repoRoot);
  if (fs.existsSync(dir)) line(OK, `transcripts directory found (${dir})`);
  else line(MEH, "no Claude Code transcripts found for this repo yet");

  // State health.
  const { state, corrupt } = readState(rt.paths);
  if (corrupt) {
    line(BAD, "state file is corrupt — run `grepathy repair`");
    problems++;
  } else {
    discoverAndSync(rt.repoRoot, state);
    const total = Object.values(state.sessions).filter((r) => r.repo === rt.repoRoot).length;
    const dirty = sessionsNeedingDistill(rt.repoRoot, state).length;
    line(dirty > 0 ? MEH : OK, `${total} session(s) known, ${dirty} needing distill`);
  }

  // Why-pack git freshness — the two axes that let GitHub silently lag.
  const g = whyPackGitStatus(rt.repoRoot);
  if (g.uncommitted === 0 && g.unpushed === 0) {
    line(OK, "why-pack committed and pushed");
  } else {
    const bits: string[] = [];
    if (g.uncommitted > 0) bits.push(`${g.uncommitted} uncommitted`);
    if (g.unpushed > 0) bits.push(`${g.unpushed} unpushed`);
    line(MEH, `why-pack: ${bits.join(", ")} — \`grepathy sync\` then \`git push\` to catch up`);
  }

  // Backend availability.
  const backend = backendStatus();
  line(backend.ok ? OK : MEH, backend.msg);

  say("");
  if (problems === 0) say("All good.");
  else say(`${problems} problem(s) found.`);
  return problems === 0 ? 0 : 1;
}

function claudeHooksInstalled(repoRoot: string): { stop: boolean; sessionEnd: boolean; preToolUse: boolean } {
  // Hooks live in settings.local.json; also check settings.json for robustness
  // (older installs / hand edits).
  const has = (event: string, marker: string) =>
    ["settings.local.json", "settings.json"].some((name) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude", name), "utf8"));
        return (s.hooks?.[event] ?? []).some((g: any) =>
          g.hooks?.some((h: any) => String(h.command).includes(marker)),
        );
      } catch {
        return false;
      }
    });
  return {
    stop: has("Stop", "hook stop"),
    sessionEnd: has("SessionEnd", "hook session-end"),
    preToolUse: has("PreToolUse", "hook pre-tool-use"),
  };
}

function prePushInstalled(repoRoot: string): boolean {
  const hd = hooksDir(repoRoot);
  if (!hd) return false;
  try {
    return fs.readFileSync(path.join(hd, "pre-push"), "utf8").includes("grepathy managed");
  } catch {
    return false;
  }
}

function backendStatus(): { ok: boolean; msg: string } {
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, msg: "distiller backend: ANTHROPIC_API_KEY present" };
  const res = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5000 });
  if (res.status === 0) return { ok: true, msg: `distiller backend: claude CLI (${(res.stdout || "").trim().split("\n")[0]})` };
  return { ok: false, msg: "distiller backend: no `claude` CLI and no ANTHROPIC_API_KEY — distillation will fail" };
}
