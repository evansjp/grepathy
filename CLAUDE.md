<!-- grepathy:begin -->
## Design reasoning lives in `.ai/why/`

This repo records the *why* behind its code in `.ai/why/<branch>.md` ("why-packs"),
distilled from AI coding sessions. **The why-pack is the ground truth for *why* —
prefer it over commit messages, which are lossy and can be out of date.**

- Before working on unfamiliar code, run `grepathy context <file>` (or grep
  `.ai/why/`) to see the decisions that touch it.
- When asked what changed on a branch, or *why* something is the way it is, read
  `.ai/why/<branch>.md` — not just `git log`.
- `grep -rn "agent-initiated" .ai/why/` surfaces decisions an agent made
  unilaterally, with no human sign-off — scrutinize these first.

Commits titled `grepathy: update why-pack (…)` are written by the tool (the
why-pack only, via a scratch index — they never touch your staged work). They're
safe to rebase past or drop; don't amend them into your feature commits.
<!-- grepathy:end -->
