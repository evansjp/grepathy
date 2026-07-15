import { test } from "node:test";
import assert from "node:assert/strict";
import { distillEvents } from "../src/distiller/index.js";
import { coercePack } from "../src/distiller/model.js";
import { DEFAULT_CONFIG } from "../src/util/config.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { MockBackend, fixedPackBackend, readFixture, CLERK_PACK } from "./helpers.js";

const adapter = new ClaudeCodeAdapter();
const events = adapter.normalizeEvents(readFixture("clerk-session.jsonl"));

test("distillEvents flags the agent-initiated Clerk decision", async () => {
  const backend = fixedPackBackend(CLERK_PACK);
  const outcome = await distillEvents(events, DEFAULT_CONFIG, backend);
  assert.equal(outcome.ok, true);
  const clerk = outcome.pack.decisions.find((d) => d.title.includes("Clerk"));
  assert.ok(clerk);
  assert.equal(clerk!.status, "agent-initiated");
});

test("title-anchoring: the distiller is shown the branch's existing titles to reuse", async () => {
  let seen = "";
  const backend = new MockBackend((user) => {
    seen = user;
    return JSON.stringify(CLERK_PACK);
  });
  await distillEvents(events, DEFAULT_CONFIG, backend, {
    knownTitles: ["Guest identities are pre-created in Clerk"],
  });
  assert.match(seen, /reuse its EXACT title/i, "prompt instructs verbatim title reuse");
  assert.match(seen, /Guest identities are pre-created in Clerk/, "the existing title is listed");
});

test("business/financial narrative (no real Touches) is dropped; code decisions survive", async () => {
  // Regression fixture for the real leak class: the distiller emitted
  // business-context "decisions" with no concrete file — the shape the POL
  // session leaked (rendered as `Touches: (unspecified)`). The prompt now
  // forbids this outright, but the SCHEMA BACKSTOP is what we can verify
  // deterministically without a live model: a touchless entry is not a code
  // decision and never reaches the pack, regardless of what the prompt does.
  const leaky = {
    intent: "Fix product-sync pagination.",
    decisions: [
      { title: "Ship fast given pre-revenue runway", status: "discussed", touches: [],
        body: "Team is pre-revenue with no path to funding, so speed matters." },
      { title: "Honor the negotiated vendor discount", status: "discussed", touches: [],
        body: "Pricing was settled at a lower monthly rate." },
      { title: "Page until the cursor is empty", status: "directed", touches: ["src/sync/products.ts"],
        body: "The API paginates; loop until no next cursor is returned." },
    ],
  };
  const outcome = await distillEvents(events, DEFAULT_CONFIG, fixedPackBackend(leaky as any));
  assert.equal(outcome.ok, true);
  assert.deepEqual(
    outcome.pack.decisions.map((d) => d.title),
    ["Page until the cursor is empty"],
    "only the real code decision with a Touches path survives",
  );
});

test("coercePack blanks an intent carrying a money figure, keeps a clean one", () => {
  // The intent has no Touches backstop, so the deterministic finance guard lives
  // here — the POL leak was a money figure that rode into the intent field.
  assert.equal(
    coercePack({ intent: "Cut infra spend after $42/mo pricing proved too high", decisions: [] }).intent,
    "",
  );
  assert.equal(
    coercePack({ intent: "Evaluate local testing options for the messaging bot", decisions: [] }).intent,
    "Evaluate local testing options for the messaging bot",
  );
});

test("empty events short-circuit without calling the backend", async () => {
  const backend = new MockBackend(() => {
    throw new Error("should not be called");
  });
  const outcome = await distillEvents([], DEFAULT_CONFIG, backend);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.pack.decisions.length, 0);
  assert.equal(backend.calls, 0);
});

test("validator failure triggers exactly one retry, then succeeds", async () => {
  const leaky = JSON.stringify({
    intent: "x",
    decisions: [{ title: "t", status: "directed", touches: ["src/x.ts"], body: "the user was unsure here" }],
  });
  const clean = JSON.stringify(CLERK_PACK);
  const backend = new MockBackend((_u, call) => (call === 0 ? leaky : clean));
  const outcome = await distillEvents(events, DEFAULT_CONFIG, backend);
  assert.equal(outcome.ok, true);
  assert.equal(backend.calls, 2, "one distill + one retry");
});

test("persistent leak gives up (writes nothing)", async () => {
  const leaky = JSON.stringify({
    intent: "x",
    decisions: [{ title: "t", status: "directed", touches: ["src/x.ts"], body: "the user said do it this way" }],
  });
  const backend = new MockBackend(() => leaky);
  const outcome = await distillEvents(events, DEFAULT_CONFIG, backend);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? "", /validation failed/);
});
