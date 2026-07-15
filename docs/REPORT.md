# Does Grepathy actually work?

We ran a blind, pre-registered evaluation of Grepathy against an honest baseline — and
published all of it, including the parts where the tool lost. This is that report,
consolidated. If a claim here isn't backed by a number, treat it as opinion.

**Method.** Three roles kept separate to avoid grading our own homework:
- an **oracle** read raw session transcripts and wrote answer keys;
- **subjects** were fresh headless `claude -p` sessions that saw only a repo clone;
- a **judge** graded subject answers **blind to which condition produced them**.

**Conditions.** **B** = honest baseline (the repo as-is: code + commit messages, no `.ai/`).
**C** = Grepathy (committed why-pack + `CLAUDE.md` pointer + edit-time injection).

**Repos.** `grepathy` itself (a friendly ceiling) and **proof-of-life** ("POL"), a real,
messy side project used as the unfriendly case. Bars were registered before any run. Every
artifact was local-only; nothing was committed or pushed.

---

## The headline (produced by the machine, unprompted)

Claude Code deletes session transcripts after `cleanupPeriodDays` — **default 30**. That
cleanup ran the morning of the eval. Two of our own projects, built almost entirely in Claude
Code, had **every** session transcript deleted. Git history survived; the *reasoning* had a
30-day fuse and was gone.

That is the strongest argument for the tool, and we didn't construct it — we tripped over it.
**Commits survive; the "why" does not, unless something captures it before the fuse.** So
backfill isn't onboarding polish — it's a rescue with a deadline. (`grepathy init` now reads
the retention setting and offers to backfill sessions before they expire.)

---

## What we tested

### 1. Distiller quality — is the output any good?

Oracle audit of a real 74-entry why-pack against pre-registered bars:

| metric | result | bar | |
|---|---|---|---|
| Recall (real decisions captured) | ~0.85 | ≥0.70 | ✅ |
| Precision (entries that are real decisions) | ~0.65 | ≥0.60 | ✅ (soft) |
| Status-accuracy (`directed`/`discussed`/`agent-initiated` correct) | ~0.71 | ≥0.80 | ❌ miss |
| Hallucinations | 0 | 0 | ✅ |

Two real weaknesses surfaced, both since fixed (see [What we fixed](#what-we-fixed)):
- **Precision** was dragged down by near-duplicate entries that a re-distill failed to merge.
- **Status-accuracy** missed because the distiller **over-labeled approved changes as
  `agent-initiated`** — diluting the one signal nothing else provides.

**Privacy.** 0 secrets and **0 intimate-conversational leaks** in either pack — the operator's
actual questions, uncertainty, and back-and-forth never appeared. But on the real (POL) data,
the pack **did** leak a named third party plus the operator's financial constraints, in two
entries that weren't even code decisions. Third-person *business* narrative slipped past both
the secret regex and the first-person narrative filter. (Fixed and re-verified below.)

### 2. Is it a refactor guardrail? — No.

We told a fresh agent to "simplify" load-bearing code and scored, blind, whether the reasoning
in the why-pack stopped it. Pre-registered bar: C protects ≥3 of 5 cases that B destroys.

**C protected 1 of 3 eligible cases. Bar missed.** Grepathy is **not** a reliable refactor
guardrail, and we don't claim it is. One honest asymmetry did show up, and it pointed at the
next test: under refactor pressure, baseline B twice **invented a wrong rationale**
("it's cosmetic") to justify deleting code; C always cited the real one.

### 3. Does it answer "why?" better? — Yes, but narrowly.

Six "why" questions, fresh session per question per condition, blind-judged for correctness
and hallucinated intent:

| | code-inferable questions | the one traceless question | hallucinated intent |
|---|---|---|---|
| **B** baseline | 5/5 correct | **1/2** | **1** |
| **C** grepathy | 5/5 correct | **2/2** | **0** |

The entire gap is the one question whose answer **leaves no footprint in the code** (a CDN was
*considered and rejected* — nothing in the diff shows it). There, baseline invented a
plausible code-derived reason and got flagged for hallucinating; Grepathy recovered the real
fact from the pack. On all five code-inferable questions the two were identical — POL's code is
self-documenting, so a careful agent recovers most "whys" unaided.

**So the explainer value is real but precisely located:** it matters for reasoning that is
*traceless in code* — provenance and considered-but-rejected alternatives — which on a clean
repo is a small fraction of questions (~1/6 here) and would be larger on a gnarly, comment-free
codebase. Elsewhere its edge over a diligent code-reader is near zero.

### 4. Do agents stop re-learning known lessons? — Not shown on this test.

A "warm-start" test: an agent learns a lesson (an undocumented API quirk), Grepathy distills
it, then a fresh agent builds adjacent code — does the pack stop it re-hitting the quirk? Bars
were not met, for three converging reasons that are themselves the finding:
1. **Code carries the lesson.** When the prior session left working code for the quirk, a fresh
   agent just reads it — the pack is redundant.
2. **The lessons were generically defensible.** Dedupe-by-id, null-guard, page-until-empty are
   habits a competent agent applies by default; baseline re-hit them only ~1/3 of the time
   *with zero knowledge*. Little gap for the pack to close.
3. **The lessons this test manufactured were too textbook.** A genuine warm-start win needs a
   *counter-intuitive, traceless* lesson, which this harness didn't produce.

Consistent with test 3: Grepathy's value is on non-obvious, traceless knowledge — not on
lessons a competent agent already applies or can copy from nearby code.

---

## The honest one-liner

> **Grepathy demonstrably rescues design reasoning that Claude Code otherwise deletes on a
> 30-day fuse, and it makes an agent's "why" answers correct and hallucination-free
> specifically for the reasoning that leaves no trace in code — provenance and
> considered-but-rejected alternatives a careful reader cannot reconstruct. It is NOT a
> reliable refactor guardrail, and it does not make agents smarter where the code already
> answers the question.**

---

## What we fixed

The eval surfaced five distiller bugs. We fixed each at the layer that won't rot — **the LLM
makes the judgment call at generation time; a deterministic check enforces it downstream** —
and then re-verified the privacy fix against the real POL transcripts rather than trusting that
"the prompt now says not to."

1. **No-commit sessions produced empty packs.** A pure-investigation session (no commit, so no
   branch stamped in the transcript) couldn't be attributed and distilled to nothing. Fixed:
   the hooks record the checked-out branch while the repo is on it, and attribution uses that.
2. **`agent-initiated` over-flagging.** Bias inverted: the distiller defaults to `discussed`
   and emits `agent-initiated` only when it can affirmatively confirm no user turn touched the
   decision — so the marquee signal stops crying wolf.
3. **Business-narrative leak.** Two layers: the prompt now forbids commercial/financial
   narrative outright (revenue, funding, third-party names, deals) in every field; and
   structurally, an entry with no real `Touches:` path is dropped — "a code decision names
   code." The two leaked entries were exactly that shape, so they're removed deterministically.
4. **Intent-field money leak** (found *while verifying* the fix above). With the decisions
   cleaned, the model relocated the pricing figures into the intent field, which has no
   `Touches:` backstop. Fixed with a deterministic currency detector: a money figure is a
   bounded surface form (like the secret regexes), so a money-laden intent is blanked and
   figures anywhere else fail the validator.
5. **Cross-pass duplicates.** The distiller is now shown the branch pack's existing titles and
   reuses the exact one for the same decision, so a re-distill updates in place instead of
   piling up a near-duplicate. (An earlier stopword-list attempt was reverted as brittle.)

### The re-run earned its keep

Verifying by re-distillation, not by prompt wording, caught a regression a prompt-only fix
would have shipped:

| | touchless business entries | named third party | pricing figures |
|---|---|---|---|
| original (leaked) | 2 | yes | ⟨redacted monthly + setup figures⟩ |
| after touchless-drop + prompt | **0** | **gone** | **moved into the intent field** |
| after the currency backstop | **0** | **gone** | **gone** |

**Final re-distill of the real POL sessions:** 0 touchless entries, 12 clean code decisions,
intent is a pure feature description, and the privacy scanner reports 0 secrets, 0 session
narrative, and only benign overlap with the app's own shipped message strings.

**One honest residual:** the deterministic layer catches the *hard* signals (money figures,
named third parties in non-code entries). Money-free business *tone* — an intent like "for the
bootstrapped experiment," no number, no name — still rides on the prompt, because that's the
fuzzy part a regex can't judge without becoming brittle. For that, the guarantee is the human
review-before-push gate, which is Grepathy's design regardless.

---

## What to believe, and what not to

- **Lead with:** rescue (reasoning has a 30-day fuse) and the traceless-why explainer. Both are
  demonstrated.
- **Don't oversell:** guardrail behavior (it's not one) or general "smarter agents" (where the
  code answers the question, agents don't need the pack).
- **Untested honestly:** "why-pack vs. disciplined commit hygiene." POL's commits were too terse
  to compare against, so whether automatic capture beats a team that writes great commits and
  ADRs by hand is the open question — and the one that decides how big the tool really is.

**Caveats.** Small n (one real repo, six why-questions, three guardrail scenarios) — treat as
directional, not conclusive. Same-family bias (Claude judging Claude) is mitigated by blind,
binary grading. The synthetic warm-start quirks were too textbook to be a fair test of the
learning claim.
