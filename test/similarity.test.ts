import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameDecision, titleSimilarity } from "../src/distiller/similarity.js";
import { mergePack, parsePack, renderPack } from "../src/distiller/whypack.js";
import { DistilledPack, DecisionEntry } from "../src/distiller/model.js";

const DATE = "2026-07-07";

// The exact re-wording that produced a duplicate during dogfooding.
const A: DecisionEntry = {
  title: "Use claude -p backend with ANTHROPIC_API_KEY fallback",
  status: "directed",
  touches: ["src/distiller/backends.ts"],
  body: "Reuse Claude Code auth; fall back to the API.",
};
const B: DecisionEntry = {
  title: "Use claude -p as default backend; ANTHROPIC_API_KEY as fallback",
  status: "directed",
  touches: ["src/distiller/backends.ts"],
  body: "Default to claude -p, fall back to the direct API when a key is set.",
};

test("re-worded titles for the same decision are recognized as the same", () => {
  assert.ok(isSameDecision(A, B));
});

test("genuinely different decisions on the same file are NOT merged", () => {
  const other: DecisionEntry = {
    title: "Chunk long transcripts before distillation",
    status: "directed",
    touches: ["src/distiller/backends.ts"],
    body: "Split by size to fit the model.",
  };
  assert.ok(!isSameDecision(A, other), `similarity was ${titleSimilarity(A.title, other.title)}`);
});

test("mergePack collapses a re-worded decision into the existing entry (no duplicate)", () => {
  const first = mergePack("main", null, undefined, { intent: "x", decisions: [A] });
  const existing = parsePack("main", renderPack(first.pack, DATE));
  // Re-distillation words the same decision differently.
  const second = mergePack("main", existing, first.shadow, { intent: "x", decisions: [B] });
  assert.equal(second.pack.entries.length, 1, "should refresh in place, not append a near-duplicate");
  assert.equal(second.pack.entries[0].title, B.title, "content refreshed to the newer wording");
});

test("distinct decisions still accumulate as separate entries", () => {
  const distinct: DistilledPack = {
    intent: "x",
    decisions: [
      A,
      { title: "Preserve human edits via a shadow-hash record", status: "directed", touches: ["src/state/entries.ts"], body: "Track a hash per entry." },
    ],
  };
  const merged = mergePack("main", null, undefined, distinct);
  assert.equal(merged.pack.entries.length, 2);
});
