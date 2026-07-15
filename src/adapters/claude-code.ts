import * as fs from "node:fs";
import * as path from "node:path";
import {
  Adapter,
  DiscoveredSession,
  NormalizedEvent,
  ReadResult,
  TranscriptMeta,
} from "./types.js";
import { claudeProjectDirFor, claudeProjectsDir } from "../util/paths.js";

/** Tools whose file_path argument means "this session touched this file". */
const EDITING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Markers of slash-command / local-command scaffolding, not real user text. */
const COMMAND_MARKERS = [
  "<local-command-caveat>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<command-stdout>",
  "<command-stderr>",
  "<user-prompt-submit-hook>",
];

interface RawLine {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  gitBranch?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  /** Sibling object on tool_result lines: Bash carries stdout/stderr here. */
  toolUseResult?: any;
}

/**
 * Parse JSONL, tolerating a truncated final line (the power-loss / laptop-shut
 * case): unparseable trailing lines are skipped, everything before them is kept.
 */
function parseLines(raw: string): RawLine[] {
  const out: RawLine[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip any unparseable line. In practice only the final line of a
      // crashed session is truncated; a mid-file bad line is also survivable.
    }
  }
  return out;
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return nl === -1 ? s : s.slice(0, nl);
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function isCommandScaffolding(text: string): boolean {
  return COMMAND_MARKERS.some((m) => text.includes(m));
}

/** Summarize a tool_use block into a compact one-liner (no file bodies). */
function summarizeToolUse(name: string, input: any): { text: string; tool: string } {
  const p = input || {};
  switch (name) {
    case "Edit": {
      // Keep BOTH sides so "changed X from A to B" facts survive (before-values
      // are exactly what the distiller needs to report accurate deltas).
      const oldS = truncate(String(p.old_string ?? ""), 140);
      const newS = truncate(String(p.new_string ?? ""), 160);
      const change = oldS ? `${oldS} → ${newS}` : `new: ${newS}`;
      return { tool: name, text: `Edit ${p.file_path ?? "?"}${change ? ` — ${change}` : ""}` };
    }
    case "Write": {
      const body = truncate(String(p.content ?? ""), 200);
      return { tool: name, text: `Write ${p.file_path ?? "?"}${body ? ` — ${body}` : ""}` };
    }
    case "MultiEdit": {
      const edits = Array.isArray(p.edits) ? p.edits : [];
      const first = edits[0]
        ? ` — e.g. ${truncate(String(edits[0].old_string ?? ""), 80)} → ${truncate(String(edits[0].new_string ?? ""), 80)}`
        : "";
      return { tool: name, text: `MultiEdit ${p.file_path ?? "?"} (${edits.length} edits)${first}` };
    }
    case "NotebookEdit":
      return { tool: name, text: `NotebookEdit ${p.notebook_path ?? p.file_path ?? "?"}` };
    case "Read":
      return { tool: name, text: `Read ${p.file_path ?? "?"}` };
    case "Bash":
      return { tool: name, text: `Bash: ${truncate(firstLine(String(p.command ?? "")), 200)}` };
    case "Grep":
      return { tool: name, text: `Grep ${truncate(String(p.pattern ?? ""), 80)}` };
    case "Glob":
      return { tool: name, text: `Glob ${truncate(String(p.pattern ?? ""), 80)}` };
    case "Task":
      return { tool: name, text: `Task(${p.subagent_type ?? "agent"}): ${truncate(String(p.description ?? ""), 120)}` };
    case "WebFetch":
      return { tool: name, text: `WebFetch ${truncate(String(p.url ?? ""), 120)}` };
    case "WebSearch":
      return { tool: name, text: `WebSearch ${truncate(String(p.query ?? ""), 120)}` };
    default: {
      const keys = Object.keys(p).slice(0, 4);
      const preview = keys.map((k) => `${k}=${truncate(String(p[k]), 60)}`).join(", ");
      return { tool: name, text: `${name}(${preview})` };
    }
  }
}

/**
 * Compress a tool result to what's worth keeping. Only Bash results are kept —
 * that's where measured outcomes live (a size reduction, a benchmark, a test
 * count). Per the spec: exit/interrupted status + first and last lines, never
 * the full output. Other tools' results (file reads, greps) are pure noise.
 */
function summarizeToolResult(toolName: string, block: any, toolUseResult: any): string {
  if (toolName !== "Bash") return "";
  let stdout = "";
  let stderr = "";
  let interrupted = false;
  if (toolUseResult && typeof toolUseResult === "object") {
    stdout = String(toolUseResult.stdout ?? "");
    stderr = String(toolUseResult.stderr ?? "");
    interrupted = !!toolUseResult.interrupted;
  } else if (typeof block.content === "string") {
    stdout = block.content;
  } else if (Array.isArray(block.content)) {
    stdout = block.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
  }

  const parts: string[] = [];
  if (interrupted) parts.push("interrupted");
  const outLines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (outLines.length === 1) {
    parts.push(truncate(outLines[0], 160));
  } else if (outLines.length === 2) {
    parts.push(truncate(outLines[0], 140), truncate(outLines[1], 140));
  } else if (outLines.length > 2) {
    parts.push(
      truncate(outLines[0], 140),
      `… (+${outLines.length - 2} lines) …`,
      truncate(outLines[outLines.length - 1], 140),
    );
  }
  const errLine = stderr.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  if (errLine) parts.push(`stderr: ${truncate(errLine, 120)}`);
  if (block.is_error) parts.push("(error)");

  const body = parts.join(" | ");
  return body ? `Bash output: ${body}` : "";
}

export class ClaudeCodeAdapter implements Adapter {
  readonly tool = "claude-code";

  discoverSessions(repoPath: string): DiscoveredSession[] {
    const dir = claudeProjectDirFor(repoPath);
    const out: DiscoveredSession[] = [];
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      out.push({
        sessionId: name.replace(/\.jsonl$/, ""),
        transcriptPath: path.join(dir, name),
        repo: repoPath,
      });
    }
    return out;
  }

  readTranscript(transcriptPath: string, fromOffset = 0): ReadResult {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (fromOffset >= size) return { raw: "", newOffset: size };
      const length = size - fromOffset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, fromOffset);
      return { raw: buf.toString("utf8"), newOffset: size };
    } finally {
      fs.closeSync(fd);
    }
  }

  normalizeEvents(raw: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const toolNames = new Map<string, string>(); // tool_use_id -> tool name
    for (const line of parseLines(raw)) {
      const ts = line.timestamp;
      const content = line.message?.content;

      if (line.type === "user") {
        if (line.isMeta) continue;
        if (typeof content === "string") {
          // In a sidechain, the "user" is the parent agent, not the human.
          if (line.isSidechain) continue;
          if (isCommandScaffolding(content)) continue;
          const text = content.trim();
          if (text) events.push({ kind: "user_text", text, timestamp: ts });
          continue;
        }
        // Array content = tool results. Keep compressed Bash output so measured
        // outcomes (sizes, benchmarks, test counts) survive for the distiller.
        if (Array.isArray(content)) {
          for (const block of content as any[]) {
            if (block?.type !== "tool_result") continue;
            const name = toolNames.get(block.tool_use_id) ?? "";
            const summary = summarizeToolResult(name, block, line.toolUseResult);
            if (summary) {
              events.push({ kind: "tool_call_summary", tool: `${name || "Tool"}Result`, text: summary, timestamp: ts });
            }
          }
        }
        continue;
      }

      if (line.type === "assistant" && Array.isArray(content)) {
        for (const block of content as any[]) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && block.text?.trim()) {
            events.push({ kind: "assistant_text", text: block.text.trim(), timestamp: ts });
          } else if (block.type === "thinking" && block.thinking?.trim()) {
            events.push({ kind: "thinking", text: block.thinking.trim(), timestamp: ts });
          } else if (block.type === "tool_use") {
            if (block.id) toolNames.set(String(block.id), String(block.name ?? ""));
            const { text, tool } = summarizeToolUse(String(block.name ?? "Tool"), block.input);
            events.push({ kind: "tool_call_summary", text, tool, timestamp: ts });
          }
        }
      }
    }
    return events;
  }

  extractMeta(raw: string): TranscriptMeta {
    const branches = new Set<string>();
    const files = new Set<string>();
    let cwd: string | undefined;
    let firstTs: string | undefined;
    let lastTs: string | undefined;

    for (const line of parseLines(raw)) {
      if (line.gitBranch) branches.add(line.gitBranch);
      if (line.cwd && !cwd) cwd = line.cwd;
      if (line.timestamp) {
        if (!firstTs) firstTs = line.timestamp;
        lastTs = line.timestamp;
      }
      const content = line.message?.content;
      if (line.type === "assistant" && Array.isArray(content)) {
        for (const block of content as any[]) {
          if (block?.type === "tool_use" && EDITING_TOOLS.has(block.name)) {
            const fp = block.input?.file_path ?? block.input?.notebook_path;
            if (typeof fp === "string") files.add(fp);
          }
        }
      }
    }

    return {
      branches: [...branches],
      files: [...files],
      cwd,
      firstTs,
      lastTs,
    };
  }
}

/** True if a project dir under ~/.claude/projects exists at all. */
export function claudeProjectsAvailable(): boolean {
  return fs.existsSync(claudeProjectsDir());
}
