import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderPack,
  parsePack,
  mergePack,
  decisionToPackEntry,
  ParsedPack,
} from "../src/distiller/whypack.js";
import { DistilledPack } from "../src/distiller/model.js";
import { CLERK_PACK } from "./helpers.js";

const DATE = "2026-07-07";

function firstMerge(fresh: DistilledPack) {
  return mergePack("guest-access", null, undefined, fresh);
}

test("render/parse round-trips entries and intent", () => {
  const merged = firstMerge(CLERK_PACK);
  const md = renderPack(merged.pack, DATE);
  const reparsed = parsePack("guest-access", md);
  assert.equal(reparsed.intent, CLERK_PACK.intent);
  assert.equal(reparsed.entries.length, 2);
  assert.equal(reparsed.entries[0].title, "Guest identities are pre-created in Clerk");
  assert.ok(reparsed.entries[0].status.startsWith("agent-initiated"));
  assert.deepEqual(reparsed.entries[0].touches, ["lib/clerk/*", "db/schema/guests.ts"]);
});

test("first merge adds all decisions", () => {
  const merged = firstMerge(CLERK_PACK);
  assert.equal(merged.pack.entries.length, 2);
  assert.equal(merged.addedTitles.length, 2);
  assert.ok(merged.shadow.entries["guest-identities-are-pre-created-in-clerk"]);
});

test("re-distilling identical content produces no changes", () => {
  const first = firstMerge(CLERK_PACK);
  const md = renderPack(first.pack, DATE);
  const existing = parsePack("guest-access", md);
  const second = mergePack("guest-access", existing, first.shadow, CLERK_PACK);
  assert.equal(second.addedTitles.length, 0);
  assert.equal(second.updatedTitles.length, 0);
  assert.equal(renderPack(second.pack, DATE), md);
});

test("human edits to a generated entry are preserved on re-distill", () => {
  const first = firstMerge(CLERK_PACK);
  const md = renderPack(first.pack, DATE);
  // Human edits the body of the Clerk entry on disk.
  const editedMd = md.replace(
    "The agent inferred this approach to simplify downstream auth checks.",
    "HUMAN NOTE: we confirmed with security this is fine.",
  );
  const existing = parsePack("guest-access", editedMd);
  const second = mergePack("guest-access", existing, first.shadow, CLERK_PACK);
  const out = renderPack(second.pack, DATE);
  assert.ok(out.includes("HUMAN NOTE: we confirmed with security"));
  // Grepathy did not overwrite it back to the generated text.
  assert.ok(!out.includes("The agent inferred this approach to simplify downstream auth checks."));
});

test("human deletion of an entry is not resurrected", () => {
  const first = firstMerge(CLERK_PACK);
  // Human deletes the JWT entry: existing has only the Clerk entry.
  const existing: ParsedPack = {
    slug: "guest-access",
    intent: CLERK_PACK.intent,
    entries: [decisionToPackEntry(CLERK_PACK.decisions[0])],
  };
  const second = mergePack("guest-access", existing, first.shadow, CLERK_PACK);
  const titles = second.pack.entries.map((e) => e.title);
  assert.ok(!titles.includes("JWT expiry set to 15 minutes for guest tokens"));
});

test("materially changed decision on a human-owned entry is appended, not overwritten", () => {
  const first = firstMerge(CLERK_PACK);
  const md = renderPack(first.pack, DATE);
  const editedMd = md.replace("simplify downstream auth checks", "HUMAN OWNED EDIT");
  const existing = parsePack("guest-access", editedMd);
  // New distillation of the same decision, but materially different body.
  const evolved: DistilledPack = {
    intent: CLERK_PACK.intent,
    decisions: [
      {
        ...CLERK_PACK.decisions[0],
        body: "The approach changed: guests now use a dedicated table, not Clerk pre-creation.",
      },
    ],
  };
  const second = mergePack("guest-access", existing, first.shadow, evolved);
  const titles = second.pack.entries.map((e) => e.title);
  assert.ok(titles.includes("Guest identities are pre-created in Clerk"), "human version kept");
  assert.ok(titles.some((t) => t.endsWith("(updated)")), "material update appended");
});

test("title-anchoring: exact-title reuse updates a generated entry in place, but a human edit still wins", () => {
  const first = firstMerge(CLERK_PACK);
  const md = renderPack(first.pack, DATE);
  // The distiller re-encounters the same decision and (thanks to title-anchoring)
  // reuses the EXACT title, with an evolved body.
  const evolved: DistilledPack = {
    intent: CLERK_PACK.intent,
    decisions: [
      { ...CLERK_PACK.decisions[0], body: "Refined: guests are pre-created lazily on first link open." },
    ],
  };

  // Case A — the entry is still tool-generated: update in place, no duplicate.
  const a = mergePack("guest-access", parsePack("guest-access", md), first.shadow, evolved);
  assert.equal(
    a.pack.entries.filter((e) => e.title === CLERK_PACK.decisions[0].title).length,
    1,
    "exact-title reuse refreshes in place rather than appending a duplicate",
  );
  assert.ok(a.pack.entries.some((e) => e.body.includes("pre-created lazily")), "generated entry refreshed");

  // Case B — the same title now belongs to a HAND-EDITED entry: human wins, the
  // shadow-hash rules suppress the overwrite (edit-preservation, by design).
  const editedMd = md.replace(
    "The agent inferred this approach to simplify downstream auth checks.",
    "HUMAN NOTE: verified with security.",
  );
  const b = mergePack("guest-access", parsePack("guest-access", editedMd), first.shadow, evolved);
  assert.ok(renderPack(b.pack, DATE).includes("HUMAN NOTE: verified with security."), "human edit preserved");
});

test("a later substantive intent replaces an empty one (prompt returns '' when unclear)", () => {
  // An early/exploratory chunk correctly returned an empty intent.
  const empty: DistilledPack = { intent: "", decisions: CLERK_PACK.decisions };
  const first = mergePack("guest-access", null, undefined, empty);
  const existing = parsePack("guest-access", renderPack(first.pack, DATE));
  // A later distill establishes the real intent.
  const second = mergePack("guest-access", existing, first.shadow, CLERK_PACK);
  assert.equal(second.pack.intent, CLERK_PACK.intent);
});

test("an incremental substantive intent does not NARROW an existing broad one", () => {
  // Regression: a pre-push delta re-distill sees only the latest slice of the
  // session, so its (substantive but narrow) intent must not overwrite the
  // broad intent set by an earlier full distill.
  const first = firstMerge(CLERK_PACK); // broad intent
  const existing = parsePack("guest-access", renderPack(first.pack, DATE));
  const narrow: DistilledPack = { intent: "Shorten the guest token expiry.", decisions: CLERK_PACK.decisions };
  const second = mergePack("guest-access", existing, first.shadow, narrow);
  assert.equal(second.pack.intent, CLERK_PACK.intent);
});

test("an empty fresh intent does not clobber a good existing one", () => {
  const first = firstMerge(CLERK_PACK); // good intent
  const existing = parsePack("guest-access", renderPack(first.pack, DATE));
  const empty: DistilledPack = { intent: "", decisions: [] };
  const second = mergePack("guest-access", existing, first.shadow, empty);
  assert.equal(second.pack.intent, CLERK_PACK.intent);
});

test("safety net: a negation-prefixed intent is treated as no-answer, not emitted", () => {
  // If the model ignores the prompt and emits a non-answer sentence, the
  // general negation-prefix guard drops it — no phrase list required.
  for (const bad of ["No coding work performed here.", "Nothing of note.", "Not applicable."]) {
    const merged = mergePack("guest-access", null, undefined, { intent: bad, decisions: CLERK_PACK.decisions });
    assert.equal(merged.pack.intent, "", `should reject: ${bad}`);
    assert.ok(renderPack(merged.pack, DATE).includes("_No intent recorded yet._"));
  }
});

test("human-edited intent is preserved", () => {
  const first = firstMerge(CLERK_PACK);
  const md = renderPack(first.pack, DATE);
  const editedMd = md.replace(CLERK_PACK.intent, "Human-written intent that must survive.");
  const existing = parsePack("guest-access", editedMd);
  const second = mergePack("guest-access", existing, first.shadow, CLERK_PACK);
  assert.equal(second.pack.intent, "Human-written intent that must survive.");
});
