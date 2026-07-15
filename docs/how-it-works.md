# How it works

Grepathy has no server, no bot, and no accounts. It's a CLI, a few hooks, and a markdown
convention. Git is the transport.

The core idea: **the transcript is the source of truth.** Hooks are just convenience triggers,
and the pre-push sweep is the safety net. The system is eventually consistent, not
hook-perfect. The one invariant: *before code leaves the machine, Grepathy sweeps local
transcripts and catches up.* Distillation never runs in git's hot path, so commits stay fast.

## Install

```bash
npx grepathy init      # or: npm i -g grepathy && grepathy init
```

`init` is idempotent. It installs:

- The Claude Code `Stop`, `SessionEnd`, and `PreToolUse` hooks into
  `.claude/settings.local.json` — personal and gitignored, because the hook command embeds this
  machine's path to Grepathy and must not be shared.
- A git `pre-push` hook, chaining onto husky/lefthook rather than clobbering.
- `.ai/why/` (committed — the shared artifact) and `.ai/grepathy/` (gitignored local state).
- A shared `.grepathy.json` ([config](config.md)) and a pointer in `CLAUDE.md` telling agents to
  read the why-packs.

**Adopting on an existing project?** If this machine already has Claude sessions for the repo,
`init` offers to backfill them — distilling your local history so the pack is useful on day one.
It's opt-in (default No, skipped in CI), distills only *your* local transcripts, and never
commits: the result lands in `.ai/why/` for you to review.

## What's committed vs. what stays local

Three things travel through git: the why-packs (`.ai/why/`), the team config (`.grepathy.json`),
and the `CLAUDE.md` pointer. Everything else is per-machine and installed by `init` — the Claude
hooks, the git hook, and local state (`.ai/grepathy/`). A teammate runs `grepathy init` once on
their own machine; nothing about your setup leaks into the repo.

## The hooks

You don't run Grepathy by hand. It runs off hooks:

- **`Stop`** (every turn) records session state in <100 ms — no LLM, no network. Once a session
  has grown enough (~15 KB new) and enough time has passed (~3 min), it also fires a **debounced
  background distill**, so the why-pack stays current *as you work*, not only at push time.
- **`SessionEnd`** runs a final background distill, then **commits** the why-pack (see below) so
  it rides your next push instead of drifting uncommitted.
- **`PreToolUse`** (before an Edit/Write) injects the why-pack entries whose `Touches:` match the
  file into the agent's context — so it meets the reasoning *before* it changes the code. Additive,
  once per file per session, never blocking.
- **`pre-push`** is the recovery sweep and share gate: it catches anything missed (a session where
  you shut the laptop mid-flight, or one that ran in a *different worktree*), distills it, files
  decisions under the branch you're actually pushing, commits the why-pack, and at a terminal asks
  you to review before continuing.

**It never blocks a push.** Non-interactive/CI pushes warn and proceed. Distillation is resilient:
a slow or failing transcript chunk is skipped rather than losing the whole session; overlapping
distills of one session serialize via a lockfile; and `timeBudgetMs` is a **hard** cap — enforced
between *and within* sessions, so even one very large session can't make a push hang. Work that
doesn't fit is deferred with a visible message (run `grepathy sync` to finish it now, or it rides
your next push); a partially-distilled session keeps its progress and completes on the next run.

## Keeping git current

Distilling into your working tree isn't enough — if the file sits there uncommitted, GitHub
silently lags and you're left wondering "is this why-pack outdated?" So at settle points (session
end and the pre-push sweep) Grepathy **commits** the why-pack for you. **It never pushes.**

That split is deliberate and keeps the [privacy model](privacy.md) intact: **a local commit isn't
sharing.** Nothing has left your machine — a commit is as private as an unstaged file. The moment
content crosses the wire is `git push`, and that stays human-initiated and guarded by the pre-push
review prompt. Auto-*push* is deliberately not offered.

**One honest property of this:** a why-pack commit *created at push time* rides your **next** push,
not the current one — git has already locked which commits this push sends before the pre-push hook
runs, and the hook can't inject a new commit into a transfer already in flight. So there's a
one-push lag *when you push in the middle of a session*. Two things make it a non-issue in practice:
a session that **ends before you push** has already committed its why-pack (via `SessionEnd`), so
its reasoning ships *with* the code — zero lag; and when you do want the current session's reasoning
in *this* push, run `grepathy sync` first (it distills and commits before you push). The lag is
always visible in `grepathy status`, never silent.

The commit is a good citizen under parallel agents:

- **It never touches your staging area.** It's assembled on a throwaway `GIT_INDEX_FILE` via
  `commit-tree`, snapshotting *only* `.ai/why/` on top of `HEAD`. Your staged work — and any
  concurrent agent's — is never read, `git add`ed, or swept in.
- **It's its own isolated commit**, titled `grepathy: update why-pack (<branch>)` — safe to rebase
  past or drop. The `CLAUDE.md` pointer tells agents not to amend it into a feature commit.
- **It refuses in ambiguous states** — detached HEAD, mid-merge/rebase, or when *you've* staged
  why-pack changes (you're mid-review) — and retries at the next settle point.

`grepathy status` and `grepathy doctor` report the two axes that used to be invisible —
**uncommitted** why-pack changes and **unpushed** why-pack commits — so "is GitHub current?" is one
command away. `grepathy sync` is the manual one-shot: distill anything dirty, commit, done (still no
push). Teams that can't tolerate a tool authoring commits set `"sync": "manual"` in `.grepathy.json`.

## The read side: agents encounter the why, not just store it

Committed markdown is greppable by anyone:

```bash
grep -rn "agent-initiated" .ai/why/     # decisions nobody signed off on
grepathy context lib/clerk/guests.ts    # entries whose Touches: globs match a path
```

But grepping only helps if an agent *looks* — and left alone, an agent reaches for `git log`, not
the why-pack. Discretion is what killed the original prototype's write side ("please log your
decisions" lost to the task every time), so the read side is made mechanical the same way:

- **The `CLAUDE.md` pointer** (auto-loaded into every session) tells agents the *why* lives in
  `.ai/why/`, that it's the ground truth over commit messages, and to run `grepathy context <file>`
  on unfamiliar code. This covers the "what changed / explain / review" moment.
- **The edit-time `PreToolUse` hook** injects the matching entries right before an agent edits a
  file. This covers the "before you change this" moment, so a load-bearing decision surfaces before
  it gets refactored away.

Read-side triggers are per-tool; the format is universal. Claude Code gets the pointer + hooks
today; other tools fall back to the pointer and plain greppable markdown. A Codex adapter (its own
hooks + an `AGENTS.md` pointer) is a follow-up.
