import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { readFixture, FIXTURES } from "./helpers.js";
import * as path from "node:path";

const adapter = new ClaudeCodeAdapter();

test("normalizeEvents keeps user/assistant/thinking/tool, drops noise", () => {
  const events = adapter.normalizeEvents(readFixture("clerk-session.jsonl"));
  const byKind = (k: string) => events.filter((e) => e.kind === k);

  // Real user prompt is kept; the isMeta command caveat is dropped.
  const userTexts = byKind("user_text").map((e) => e.text);
  assert.ok(userTexts.some((t) => t.includes("Add guest access")));
  assert.ok(!userTexts.some((t) => t.includes("local-command-caveat")));

  // Sidechain "user" (a subagent prompt, not the human) is excluded.
  assert.ok(!userTexts.some((t) => t.includes("subagent")));

  // Thinking preserved.
  assert.ok(byKind("thinking").some((e) => e.text.includes("pre-create guest") || e.text.includes("pre-create")));

  // Tool summaries present and compact.
  const tools = byKind("tool_call_summary").map((e) => e.text);
  assert.ok(tools.some((t) => t.startsWith("Write db/schema/guests.ts")));
  assert.ok(tools.some((t) => t.startsWith("Edit lib/clerk/guests.ts") && t.includes("new:")));

  // Bash summary keeps only the first line of the command.
  const bash = tools.find((t) => t.startsWith("Bash:"));
  assert.ok(bash && bash.includes("npm test") && !bash.includes("second line"));
});

test("extractMeta pulls branch, edited files, cwd", () => {
  const meta = adapter.extractMeta(readFixture("clerk-session.jsonl"));
  assert.deepEqual(meta.branches, ["guest-access"]);
  assert.equal(meta.cwd, "/repo");
  for (const f of ["db/schema/guests.ts", "lib/clerk/guests.ts", "lib/auth/tokens.ts"]) {
    assert.ok(meta.files.includes(f), `expected ${f} in files`);
  }
});

test("truncated final line is tolerated", () => {
  const raw = readFixture("truncated-session.jsonl");
  const events = adapter.normalizeEvents(raw);
  // The two complete lines parse; the truncated third is skipped (no throw).
  assert.ok(events.some((e) => e.kind === "user_text" && e.text.includes("Cache the config")));
  assert.ok(events.some((e) => e.kind === "tool_call_summary" && e.text.startsWith("Edit src/config.ts")));
});

test("edits keep before→after values, and Bash output preserves measured results", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "e1",
            name: "Edit",
            input: { file_path: "src/x.ts", old_string: "TIMEOUT = 90_000", new_string: "TIMEOUT = 150_000" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "du -sh dist" } }] },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] },
      toolUseResult: { stdout: "before: 2.1M\nafter: 210K (90% smaller)", stderr: "", interrupted: false },
    }),
  ].join("\n");

  const ev = adapter.normalizeEvents(raw);
  // The edit carries BOTH the before and after value (so deltas are grounded).
  assert.ok(ev.some((e) => e.text.includes("90_000") && e.text.includes("150_000")), "edit should show before→after");
  // The measured Bash result survives (this is the number a future agent needs).
  assert.ok(ev.some((e) => e.text.includes("90% smaller")), "bash measured result should be kept");
});

test("non-Bash tool results are dropped as noise", () => {
  const raw = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "big.ts" } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "...5000 lines of file...".repeat(50) }] } }),
  ].join("\n");
  const ev = adapter.normalizeEvents(raw);
  assert.ok(!ev.some((e) => e.tool === "ReadResult"), "Read result must not be surfaced");
});

test("incremental read returns only new bytes", () => {
  const full = readFixture("truncated-session.jsonl");
  const filePath = path.join(FIXTURES, "truncated-session.jsonl");
  const half = Math.floor(full.length / 2);
  const { raw, newOffset } = adapter.readTranscript(filePath, half);
  assert.equal(newOffset, Buffer.byteLength(full));
  assert.ok(raw.length < full.length);
});
