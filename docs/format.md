# The why-pack format

One rolling file per branch: `.ai/why/<branch-slug>.md` (`main` sessions → `.ai/why/main.md`).
Plain markdown, boring on purpose — optimized for `grep` and human skimming.

Each decision is one entry:

```markdown
### Guest identities are pre-created in Clerk
Status: agent-initiated — not requested in plan or prompts
Touches: `lib/clerk/*`, `db/schema/guests.ts`

The agent inferred this approach to simplify downstream auth checks.
No explicit rationale was discussed.

Considered/rejected: none found in session.
Risk: guest users diverge from the normal signup path.
Reviewer attention: confirm whether guests should be modeled as normal users.
```

- **Heading** — an imperative, specific title for the decision.
- **`Status:`** — provenance, the point of the tool:
  - `directed` — you explicitly asked for it.
  - `discussed` — surfaced in conversation, or a plain consequence of your direction. The default.
  - `agent-initiated` — the agent chose it with no user turn touching it. Emitted only when that's
    affirmatively true, so `grep agent-initiated` stays a trustworthy list of decisions nobody
    signed off on.
- **`Touches:`** — the files/globs the decision affects, so the entry is greppable and so the
  edit-time hook can match it. Every entry names at least one; an entry that can't isn't a code
  decision and is dropped.
- **Body** — 1–5 sentences of *why*.
- **Optional lines** — `Considered/rejected:`, `Risk:`, `Reviewer attention:` when the session
  warrants them.

## What it records, and won't invent

It captures the concrete facts actually in the session — rejected alternatives, and measured
results or before/after values when the transcript shows them — but **never invents a number or a
rationale that isn't there.** If a decision has no discernible reason, it says so plainly rather
than manufacturing a plausible one.

## Merge, dedupe, and your edits

Entries are merged across sessions, not blindly appended. When a later run re-derives a decision
already in the pack, the distiller is shown the existing titles and reuses the exact one, so the
entry updates in place instead of piling up a near-duplicate.

**Your edits win.** Edit or delete an entry and later distillations respect it — tracked by a
content-hash "shadow" record, so Grepathy knows the difference between "the human changed this"
(leave it alone, forever) and "I generated this last time" (safe to refresh).
