import { test } from "node:test";
import assert from "node:assert/strict";
import { distillEvents } from "../src/distiller/index.js";
import { DEFAULT_CONFIG } from "../src/util/config.js";
import { DelayMock, chunkyEvents } from "./helpers.js";

// Small chunkChars so events split into many chunks; low concurrency so timing
// is predictable.
const cfg = (over: Partial<typeof DEFAULT_CONFIG.distiller> = {}) => ({
  ...DEFAULT_CONFIG,
  chunkChars: 60,
  distiller: { ...DEFAULT_CONFIG.distiller, concurrency: 1, ...over },
});

function packFor(i: number): string {
  return JSON.stringify({ intent: "", decisions: [{ title: `decision-${i}`, status: "directed", touches: ["a.ts"], body: `body ${i}` }] });
}

test("a deadline truncates mid-session: partial pack, truncated flag, not every chunk called", async () => {
  const events = chunkyEvents(8); // -> 8 chunks at chunkChars 60
  const backend = new DelayMock((user) => ({ delayMs: 20, body: packFor(parseChunkIndex(user)) }));
  // 8 chunks * 20ms = 160ms of work, but only ~90ms of budget.
  const outcome = await distillEvents(events, cfg(), backend, { deadline: Date.now() + 90 });

  assert.equal(outcome.truncated, true, "flagged truncated");
  assert.equal(outcome.ok, true, "the chunks that finished are a valid partial pack");
  assert.ok(backend.calls >= 1 && backend.calls < 8, `distilled some but not all chunks (was ${backend.calls})`);
  assert.equal(outcome.pack.decisions.length, backend.calls, "one decision per completed chunk");
});

test("chunks merge in transcript order even when they finish out of order", async () => {
  const events = chunkyEvents(2); // -> exactly 2 chunks
  // Chunk 1 (index 1) is slow, chunk 2 is fast, run concurrently -> 2 finishes first.
  const backend = new DelayMock((user) => {
    const idx = parseChunkIndex(user); // 1-based "part N of M"
    return { delayMs: idx === 1 ? 40 : 5, body: packFor(idx) };
  });
  const outcome = await distillEvents(events, cfg({ concurrency: 2 }), backend);

  assert.equal(outcome.ok, true);
  assert.deepEqual(
    outcome.pack.decisions.map((d) => d.title),
    ["decision-1", "decision-2"],
    "order follows chunk index, not completion time",
  );
});

test("per-call timeout shrinks to the remaining budget (never blows the deadline)", async () => {
  const events = chunkyEvents(1); // one chunk, one call
  const backend = new DelayMock(() => ({ body: packFor(1) }));

  await distillEvents(events, cfg(), backend, { deadline: Date.now() + 500 });
  assert.ok(backend.timeouts[0] <= 500, `timeout clamped to remaining budget, got ${backend.timeouts[0]}`);
  assert.ok(backend.timeouts[0] > 0);

  const backend2 = new DelayMock(() => ({ body: packFor(1) }));
  await distillEvents(events, cfg(), backend2); // no deadline
  assert.ok(backend2.timeouts[0] > 100_000, "no deadline -> full per-call timeout");
});

/** The distiller prompt labels multi-chunk parts "This is part N of M". */
function parseChunkIndex(user: string): number {
  const m = user.match(/part (\d+) of/i);
  return m ? parseInt(m[1], 10) : 1;
}
