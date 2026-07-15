#!/usr/bin/env node
import { init } from "./commands/init.js";
import { distill } from "./commands/distill.js";
import { status } from "./commands/status.js";
import { doctor } from "./commands/doctor.js";
import { repair } from "./commands/repair.js";
import { context } from "./commands/context.js";
import { sync } from "./commands/sync.js";
import { off, on } from "./commands/toggle.js";
import { uninstall } from "./commands/uninstall.js";
import { hookStop, hookSessionEnd, hookPrePush, hookPreToolUse } from "./commands/hook.js";

const VERSION = "1.0.0";

function parseFlags(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function usage(): void {
  process.stdout.write(`grepathy ${VERSION} — your agent writes down WHY, in the repo.

Usage:
  grepathy init                      Install hooks, create dirs/config (idempotent)
  grepathy distill [opts]            Distill sessions into why-packs
      --session <id>                   only this session
      --branch <name>                  attribute to this branch
      --all-dirty                      every dirty/stale session (default)
  grepathy status                    Sessions known/dirty, why-pack freshness
  grepathy sync                      Distill dirty sessions + commit the why-pack (no push)
  grepathy context <file-or-path>    Print why-pack entries touching a path
  grepathy doctor                    Health check
  grepathy repair                    Rebuild state + why-packs from transcripts
  grepathy off | on                  Disable / enable hooks without uninstalling
  grepathy uninstall                 Remove hooks + local state (keeps why-packs)

Hooks (invoked by Claude Code / git, not by hand):
  grepathy hook stop | session-end | pre-push
`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  switch (command) {
    case "init":
      return init();
    case "distill": {
      const { flags } = parseFlags(rest);
      return distill({
        session: typeof flags.session === "string" ? flags.session : undefined,
        branch: typeof flags.branch === "string" ? flags.branch : undefined,
        allDirty: flags["all-dirty"] === true,
        commit: flags.commit === true,
      });
    }
    case "status":
      return status();
    case "sync":
      return sync();
    case "context": {
      const { positional } = parseFlags(rest);
      if (!positional[0]) {
        process.stderr.write("usage: grepathy context <file-or-path>\n");
        return 1;
      }
      return context(positional[0]);
    }
    case "doctor":
      return doctor();
    case "repair":
      return repair();
    case "off":
      return off();
    case "on":
      return on();
    case "uninstall":
      return uninstall();
    case "hook": {
      const sub = rest[0];
      if (sub === "stop") return hookStop();
      if (sub === "session-end") return hookSessionEnd();
      if (sub === "pre-push") return hookPrePush();
      if (sub === "pre-tool-use") return hookPreToolUse();
      process.stderr.write(`unknown hook '${sub}'\n`);
      return 1;
    }
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;
    default:
      process.stderr.write(`grepathy: unknown command '${command}'\n\n`);
      usage();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`grepathy: ${err?.stack || err}\n`);
    process.exit(1);
  });
