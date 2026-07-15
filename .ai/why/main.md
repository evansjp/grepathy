# Why: main

<!-- grepathy:v1 generated 2026-07-15 — review before sharing; edit freely, edits are preserved -->

## Intent
Implement Grepathy v1: a CLI and git hooks to distill AI agent session transcripts into privacy-safe, committed why-packs so future agents and humans can find reasoning without asking.

## Decisions

### Restructure from MCP-server prototype to single TypeScript package
Status: directed
Touches: `package.json`, `src/**`, `tsconfig.json`

The spec mandated a lightweight, portable single-package design distributed via npm (`npx grepathy init`), replacing the prior MCP-server + in-flight-logging prototype which the spec noted failed because logging competed with the task. Zero runtime dependencies; pure TypeScript.

### Build Claude Code adapter for JSONL transcript parsing
Status: directed
Touches: `src/adapters/claude-code.ts`, `src/adapters/types.ts`

The spec required an adapter interface with a Claude Code implementation normalized into common events. Built against the exact JSONL format on the dev machine by inspecting live transcripts. Tolerates truncated final lines (crash case), keeps user/assistant/thinking/tool-summaries, drops full file bodies and bash output.

### Use claude -p as default LLM backend with ANTHROPIC_API_KEY fallback
Status: directed
Touches: `src/distiller/backends.ts`

The spec specified `claude -p` (headless Claude Code) as default because it reuses the user's existing Claude Code auth, eliminating API-key setup for the core audience. ANTHROPIC_API_KEY fallback added for environments without Claude Code.

Considered/rejected: Direct ANTHROPIC_API_KEY only; rejected because local Claude Code users shouldn't require a second auth path.

### Implement privacy-contract distiller with regex-validator second layer
Status: directed
Touches: `src/distiller/prompt.ts`, `src/distiller/validator.ts`

The spec mandated the distiller be 'constitutionally incapable' of producing embarrassing output via the generation prompt first, with regex validation as a second layer. Prompt prohibits first/second-person user quotes, session narration, meta-conversation, and secrets. Validator re-prompts once on failure; anything remaining is logged with rejection count.

### Guard all hooks against infinite recursion during distillation
Status: agent-initiated — bug discovered and fixed during live smoke testing; not in spec
Touches: `src/distiller/backends.ts`, `src/commands/hook.ts`

During dogfooding, the distiller's own `claude -p` subprocess ran inside the repo, triggering its SessionEnd hook → spawning another distill → another `claude -p` → infinite recursion. Fixed by: (1) running subprocess in isolated temp cwd (transcripts never land in repo's project scan), (2) setting GREPATHY_DISTILLING=1 env var, (3) guarding all hooks to no-op when set.

Risk: Guards add complexity; if env var is lost, recursion could recur.

### Move intent-quality logic from phrase-guessing regexes to prompt contract
Status: agent-initiated — emerged from dogfooding; spec implied intent handling but not the approach
Touches: `src/distiller/model.ts`, `src/distiller/prompt.ts`

Initial approach used regex blocklists (NEGATIVE_INTENT, NULL_SIGNAL_INTENT) to filter junk intents like 'No decisions recorded.' This was non-generalizable — every session invents different null-signal wording. Fixed by moving contract to the prompt: model returns empty string when chunk establishes no intent, never describes the transcript or uses negation-framing.

Considered/rejected: Keep phrase-matching regexes; rejected because they don't generalize across repos.
Risk: Blank intent from all exploratory chunks reads as incomplete, though this is semantically correct.

### Implement semantic deduplication instead of exact-title matching
Status: agent-initiated — dogfooding revealed the need; spec mentioned dedupe but not semantic approach
Touches: `src/distiller/similarity.ts`, `src/distiller/whypack.ts`, `src/distiller/index.ts`

Exact title matching failed when the LLM re-phrased decisions between chunks ('Use claude -p backend with API fallback' vs 'Use claude -p as default; API as fallback'). Replaced with semantic matching: Jaccard token-overlap ≥0.6, or ≥0.4 with file-path overlap. Deterministic (no LLM merge pass) to avoid churning shadow hashes.

Considered/rejected: LLM merge pass over near-duplicates; rejected as nondeterministic and expensive.
Risk: Heuristic threshold (0.6/0.4) tuned on one real pack; may need adjustment across diverse repos.

### Drop LLM-based cross-chunk merge in favor of deterministic local merge
Status: agent-initiated — optimization emerged during dedupe overhaul
Touches: `src/distiller/index.ts`, `src/distiller/prompt.ts`

Initial design re-invoked LLM to merge per-chunk packs, but re-merging was nondeterministic — successive runs differed slightly, churning shadow hashes and defeating edit-preservation. Replaced with deterministic TypeScript merge: concat, semantic dedupe, prefer non-empty intent.

Considered/rejected: LLM merge for higher-quality cross-chunk synthesis; rejected because nondeterminism breaks edit-preservation contract.

### Install Claude hooks to .claude/settings.local.json instead of committed settings.json
Status: agent-initiated — design clarification during dogfooding; spec mentioned hooks but not config placement
Touches: `src/commands/init.ts`, `src/commands/doctor.ts`, `src/commands/uninstall.ts`

Initial design wrote hooks to `.claude/settings.json` (committed), but hooks embed machine-absolute node/cli paths. Changed to `.claude/settings.local.json` (personal, gitignored) so only team config (`.grepathy.json`) is committed. `doctor` and `uninstall` read both files for backwards-compatibility.

Risk: Breaking change for repos initialized with old config; `grepathy init` run again migrates cleanly.

### Make chunk-level distillation failures non-fatal with larger chunks and longer timeouts
Status: agent-initiated — robustness issue surfaced during dogfooding on large session (1.4MB, ~36 chunks)
Touches: `src/distiller/index.ts`, `src/commands/distill.ts`, `src/util/config.ts`

Dogfooding hit per-chunk timeouts, killing entire session. Fixed by: (1) tolerating individual chunk failures (log, skip, continue), (2) increasing chunk size from 40KB to 100KB (fewer chunks), (3) increasing per-call timeout from 90s to 150s.

Risk: Partial distillation (some chunks skip) is logged but may be missed by reviewer.

### Remove domain-specific (Clerk) examples from product code
Status: agent-initiated — correctness fix from user feedback on generalization
Touches: `src/distiller/model.ts`, `src/commands/context.ts`

Removed two Clerk-specific doc-comment examples from `src/`. The tool itself is domain-neutral; Clerk remains only in test fixtures and README story.

### Implement git hooks: Stop (state record), SessionEnd (background distill), pre-push (sweep + gate)
Status: directed
Touches: `src/commands/hook.ts`, `src/commands/init.ts`

The spec mandated three hooks per Design Principles. Stop records branch/files in state in <100ms (no LLM calls). SessionEnd spawns detached background distill. Pre-push sweeps for unmatched sessions (crash recovery), distills missing/stale, stages why-packs, prompts user (TTY) or warns (non-interactive), always fails open.

Reviewer attention: Verify hooks respect existing git/husky/lefthook hooks (never clobber).

### Design why-pack as plain markdown with decision entries and edit-preservation
Status: directed
Touches: `src/distiller/whypack.ts`, `src/state/entries.ts`, `.ai/why/`

The spec mandated one rolling markdown file per branch (`.ai/why/<branch-slug>.md`) with decision entries: title, Status, Touches, body, optional considered/rejected/risk/reviewer-attention. Deterministic render/parse for merge reliability. Edit-preservation via shadow-hash record: human edits/deletions survive re-distillation; material changes append new entry.

Risk: Markdown render/parse must stay synchronized; drift would corrupt merge logic.

### Stub Codex adapter to prove adapter interface seam
Status: directed
Touches: `src/adapters/codex.ts`

The spec required proving the adapter interface before a full Codex implementation. Stubbed adapter includes TODO and interface signature so the seam is proven; allows future contributor to implement without redesign.

### Build test suite with fixtures including truncated transcript and Clerk agent-initiated scenario
Status: directed
Touches: `test/fixtures/*`, `test/*.test.ts`

The spec (§7) mandated fixture transcripts including truncation (crash case) and the Clerk agent-initiated scenario. Test suite covers adapter parsing, merge/edit-preservation, validator, distiller, and end-to-end session distillation. 30 tests validated.

### Validate full pipeline via dogfooding on grepathy's own build session
Status: agent-initiated — critical validation step; not explicitly required but essential to catch integration bugs
Touches: `.ai/why/main.md`

After implementation, ran `grepathy distill` on repo's own build session (1.4MB, 2 sessions, ~20 decisions). This dogfood run surfaced four real bugs (recursion, intent filtering, semantic dedupe, non-fatal chunks) that unit tests alone would not have caught. Validated agent-initiated flags work correctly.

### Correct hallucinated numeric details in dogfood why-pack via human review
Status: agent-initiated — human review/QA of distiller output leveraging edit-preservation
Touches: `.ai/why/main.md`

Dogfood distillation produced correct decisions and reasoning but invented specific numbers (e.g., '70% token threshold' when actual is ≥0.6 Jaccard; '30s timeout' when actual is 90s→150s). Corrected four numeric entries as reviewer edits. Shadow-hash mechanism flagged these human-owned, preventing re-distillation from overwriting.

Reviewer attention: Verify shadow mechanism preserves these corrected entries across future distill cycles.

### Add guardrail to distiller prompt against fabricating specific numbers
Status: directed
Touches: `src/distiller/prompt.ts`

Instructs the distiller to state a precise value only if it appears explicitly in the transcript, otherwise describe qualitatively. Follows the same philosophy as the existing 'never invent a rationale' rule.

Risk: A prompt instruction to a haiku-class model shifts defaults but doesn't guarantee elimination of hallucination; human review remains the actual guarantee.

### Fix Edit summaries to preserve before→after values
Status: agent-initiated — Identified and fixed the root cause of hallucinated before-values
Touches: `src/adapters/claude-code.ts`

Edit summaries were dropping `old_string`, feeding the model only the new value (e.g., 'now 150_000') but never what was replaced (e.g., 'was 90_000'). This forced the model to guess the before-value. Now both sides are preserved, so 90→150 transitions are visible in the input the distiller sees.

Considered/rejected: Initial approach was to add a prompt guardrail forbidding number fabrication. The agent identified this as treating the symptom — the real issue was data starvation in input-prep, not model behavior.
Risk: None identified; this makes available data transparent to the model.

### Restore compressed Bash/tool output in transcript summaries
Status: agent-initiated — Implemented per-spec; surfaced by identifying gap in input-prep
Touches: `src/adapters/claude-code.ts`

Bash stdout was being completely discarded during filtering. Measured outcomes (e.g., 'reduced filesize by 90%') lived only in tool output and were structurally invisible to the distiller. Now preserves compressed Bash results: exit status plus first and last lines, allowing real measured facts to reach the summarizer.

Risk: Compression (first/last lines only) loses middle context; mitigated by the fact that most measured results appear at start or end of output. This tradeoff is per the original spec.

### Rebalance distiller prompt guardrail from 'omit over guess' to 'report real, never fabricate'
Status: discussed — Corrected after observation that guardrail would suppress real measured values the model was entitled to
Touches: `src/distiller/prompt.ts`

Original guardrail would advise omitting any number not certain. But measured results (benchmarks, size reductions, counts) *are* in the transcript and *are* load-bearing for future readers. Reframed to: capture concrete quantitative facts that appear in the transcript, describe qualitatively only when a value genuinely isn't there.

Considered/rejected: Treating number issues as purely a model-behavior problem (omit over guess). Actual root was data architecture — before-values and bash output were unavailable.

### Add test coverage for before→after edit capture and Bash output preservation
Status: agent-initiated
Touches: `test/adapter.test.ts`

Added focused test case exercising the new edit-summarization behavior (keeping `old_string` alongside `new_string`) and Bash output preservation (status + first/last lines), validating the input-prep fixes work end-to-end.

Risk: None; testing ensures the new behavior is retained through future edits.

### Refresh README to align with current hook location and behavior
Status: directed
Touches: `README.md`

README was stale regarding hook installation (said committed `settings.json` instead of personal `.claude/settings.local.json`), lacked explicit 'what's committed vs. local' section, and did not reflect the input-prep robustness changes. Updated to document current behavior: hooks go to `.claude/settings.local.json`, only `.ai/why/` and `.grepathy.json` are committed, distiller now captures real measured values and before→after transitions.

Risk: None; documentation is now accurate to code.

### Re-distill main.md with input-prep fixes in place
Status: directed
Touches: `.ai/why/main.md`

Clean-slate regeneration of the why-pack using the updated edit-summaries (before→after) and Bash-output preservation. Serves as a verification test: whether the distiller now captures real numbers accurately without hand-correction. Reviewer-edited entries are preserved via content-hash shadowing; only regenerated decisions refresh.

Risk: None; this is a validation check. If the distiller now reports numbers correctly from the source, it proves the input-prep fix worked.

### Rebuild from monorepo MCP prototype into single-package transcript distillation tool
Status: directed
Touches: `package.json`, `src/**/*.ts`, `test/**/*.ts`

The prior prototype (MCP server + in-flight logging) failed because logging competed with the coding task. The v1 architecture is post-hoc distillation: passive capture of complete transcripts, local distillation to privacy-filtered JSON, and committed markdown in the repo. This inverts the failure mode—no agent overhead, no session-side logging.

### Distiller runs in isolated cwd with GREPATHY_DISTILLING guard to prevent hook recursion
Status: agent-initiated — discovered during dogfood smoke test when distiller's own claude -p subprocess triggered the Stop and SessionEnd hooks, creating an infinite loop
Touches: `src/distiller/backends.ts`, `src/commands/hook.ts`

The distiller spawns `claude -p` which runs inside the repo, triggering grepathy's own hooks and re-spawning distill indefinitely. Defense: the subprocess runs in an isolated temporary directory so its transcript never lands in the repo's session scan, and all hooks check for GREPATHY_DISTILLING=1 and no-op if set. Prevented a destructive runaway loop during integration testing.

Risk: Isolated distiller temporary directories are never cleaned up; transcripts of distiller runs themselves accumulate under system temp.

### Intent merge uses prompt-first approach: ask model to return empty string when chunk establishes no clear intent
Status: discussed
Touches: `src/distiller/prompt.ts`, `src/distiller/model.ts`

Initial approach used phrase-guessing regexes to filter junk intents ('No decisions recorded', 'Transcript contains only…'), which failed to generalize to new model outputs. The fix moves the contract to the distiller prompt: return empty string when intent is unclear, never invent a sentence about the transcript. One structural safety net remains (negation-prefix = non-answer), no phrase blocklists.

Considered/rejected: Regex-based filtering of common null-signal phrasings; rejected as non-generalizable and hyper-specific to model wording.

### Semantic deduplication: match decisions by title-token Jaccard ≥0.6 or ≥0.4 + file overlap, not exact string
Status: discussed
Touches: `src/distiller/similarity.ts`, `src/distiller/whypack.ts`, `src/distiller/index.ts`

The LLM re-phrases decision titles between runs ('Use claude -p backend with API fallback' vs 'Use claude -p as default; API as fallback'), so exact-string matching created near-duplicates. Semantic matching recognizes re-worded versions of the same decision and updates in place rather than piling new entries. Verified on real dogfood pack: collapsed 4 duplicate clusters without over-merging distinct decisions. Also removed the nondeterministic LLM merge pass, keeping only deterministic local merging.

### Per-chunk distillation failures are non-fatal; one slow chunk no longer kills the whole session
Status: agent-initiated — discovered when regenerating main.md for dogfood—a large session exceeded per-chunk timeout, losing all decisions
Touches: `src/distiller/index.ts`, `src/util/config.ts`

Increased per-call timeout from 90s to 150s and chunk size from 40KB to 100KB to reduce call count. Crucially, a chunk that fails is skipped (its partial-failure count is tracked); the whole session is merged from the chunks that succeeded. This prevents one unlucky slow chunk from losing an entire session's reasoning.

Risk: Sessions with truly pathological transcripts may lose chunks; the partial-failure count alerts the user but doesn't guarantee 100% capture.

### Pre-push hook no longer auto-stages the why-pack; it writes and leaves staging to the user
Status: discussed
Touches: `src/commands/hook.ts`

The hook was running `git add` on the why-pack, which swept it into any concurrent agent's `git commit` unintentionally. This violates the principle that grepathy is a passive observer. The fix: write the why-pack to disk and stop. The file sits as a normal modified-tracked file, reviewed and staged alongside other changes. This removes grepathy as a source of unwanted bundling and aligns with the fail-open philosophy.

### State management uses per-session files instead of a single shared state.json
Status: discussed
Touches: `src/state/state.ts`, `src/util/paths.ts`

Multiple concurrent agents (via Stop and SessionEnd hooks, or background auto-distill) writing to a single state.json would cause last-writer-wins data loss. The fix: one file per session (.ai/grepathy/sessions/<id>.json), each written atomically. A corrupt session file is skipped (not fatal); legacy state.json migrates once and is removed. This enables N agents working in parallel without collision.

Considered/rejected: A single lockfile for state.json; rejected because locking adds latency to the fast Stop hook and complicates error recovery.

### Session discovery scans all worktrees of the repo family, not just the invoking directory
Status: discussed
Touches: `src/util/git.ts`, `src/core/sweep.ts`

The pre-push hook discovers sessions by cwd; pushing from a worktree other than where work happened would find no sessions. Fix: resolve the repo root to the family (Claude Code stores worktrees under .claude/worktrees/), then scan all transcripts for that repo family. This makes pushing from any worktree of the repo surface the correct sessions.

### Decisions are attributed to the branch actually being pushed, not the session's last-seen branch
Status: discussed
Touches: `src/commands/hook.ts`

Git pipes the pushed refs to the pre-push hook on stdin. Fix: parse the refs and file decisions under the pushed branch, not the session's recorded last-seen-branch (which may be stale if the working tree switched mid-session). This ensures decisions land in the correct per-branch why-pack.

### Debounced background auto-distill on Stop hook keeps why-pack current during work
Status: discussed
Touches: `src/commands/hook.ts`, `src/util/config.ts`

The pre-push hook fires only on push; sessions mid-work have stale why-packs. Fix: the Stop hook (which fires every turn) checks whether a session has grown enough (min 15KB new transcript) and it's been long enough (min 3 min since last distill); if so, spawns a detached background distill with a lockfile to prevent overlaps. This keeps the why-pack current as the agent works. Fail-silent: distill errors log but never block the agent.

Risk: Background distillation adds cost (mitigated by generous debounce and cheap Haiku). Overlapping distills are serialized via lockfile; if a lock is lost, concurrent distills could produce inconsistent writes (mitigated by per-session files).

### Distiller never invents specific numbers; only reports values explicitly in the transcript
Status: discussed
Touches: `src/distiller/prompt.ts`

The distiller was hallucinating specific numbers (sizes, timings, thresholds) not in the transcript. Guardrail: the prompt instructs the model to capture concrete quantitative facts (benchmarks, size reductions, test counts) that ARE in the transcript—especially before/after values from edits and measured results—but to describe qualitatively ('a longer timeout') when an exact value isn't present. This balances recording load-bearing numbers against fabricating specifics.

Considered/rejected: Omitting all numbers entirely; rejected because measured results are load-bearing for understanding a decision.

### Per-session distill lockfile prevents concurrent distills of the same session from stepping on each other
Status: agent-initiated
Touches: `src/util/paths.ts`, `src/core/distillSession.ts`

Multiple hooks (Stop-auto, SessionEnd, pre-push sweep) can fire simultaneously for the same session. A lockfile (created at start, deleted at end) serializes them so only one distill of a session runs at a time. This keeps the session record and why-pack consistent.

### All hooks are fail-silent and never block the agent or commit
Status: directed
Touches: `src/commands/hook.ts`

Per spec §3, any hook error (timeout, LLM failure, state corruption) is logged and the hook exits 0. Fail-open is the design: a broken why-pack system must never train users to use `git commit --no-verify`. Pre-push never prompts at TTY (though the code path exists for interactive use); it warns and proceeds.

### Test suite includes fixture JSONL transcripts covering truncated transcripts and agent-initiated decisions
Status: directed
Touches: `test/fixtures/clerk-session.jsonl`, `test/fixtures/truncated-session.jsonl`, `test/**/*.test.ts`

Per spec §7, fixtures cover crash-case truncated final line handling and a real scenario where the agent inferred an unplanned decision (Clerk guest pre-creation). Test suite grew from 3 initial tests to 41, covering adapter, why-pack merge/edit-preservation, validator, similarity matching, state concurrency, and end-to-end distillation.

### Replace shared state.json with per-session state files
Status: discussed
Touches: `.ai/grepathy/sessions/*`

Multiple agents and hooks were causing last-writer-wins data loss through a single shared state file. Per-session state files (`.ai/grepathy/sessions/<id>.json`) eliminate the race; corrupt files skip gracefully instead of crashing; legacy `state.json` migrates once on startup.

Considered/rejected: Lockfile-based synchronization rejected in favor of per-session file isolation.
Reviewer attention: Verify migration path from old state.json is robust and non-destructive.

### Remove git-index mutations from hooks
Status: discussed
Touches: `hooks/*`, `lib/distill.ts`

Pre-push hook was using `git add` to stage the why-pack, which silently swept it into whatever concurrent commit happened to fire. Changed to write to disk and leave staging to the user, keeping grepathy passive.

Risk: Why-pack is no longer auto-staged; users must explicitly commit it.

### Serialize concurrent hook execution with per-session lockfiles
Status: discussed
Touches: `hooks/*`, `.ai/grepathy/sessions/*`

Stop, SessionEnd, and pre-push hooks can fire simultaneously for the same session. Per-session distill lockfiles serialize access so only one hook mutates state at a time.

### Discover worktrees in repo family for session scanning
Status: discussed
Touches: `lib/session.ts`, `lib/worktree.ts`

Claude Code stores worktrees under `.claude/worktrees/`. Session scanning now resolves the whole repo family, so pushing from a different worktree than where work happened still finds the sessions.

### Attribute decisions to pushed branch via pre-push refs
Status: discussed
Touches: `hooks/pre-push`

Instead of using the session's possibly-stale last-seen branch, parse refs from pre-push stdin to identify the branch actually being pushed. Ensures decisions are filed under the correct branch.

### Add debounced background auto-distill on Stop hook
Status: discussed
Touches: `hooks/stop`, `lib/distill.ts`

Distill mid-work (when session grows ≥15KB new and ≥3 min elapsed) to keep why-packs current instead of only at push time. Fail-silent to avoid blocking session shutdown.

### Merge backfill-on-init onto concurrency-safe main
Status: discussed
Touches: `lib/init.ts`

Backfill feature (retroactively discovers sessions from git history) was developed on a feature branch. Now that main is concurrency-safe, merged in.

### Add CLAUDE.md instruction pointer
Status: discussed
Touches: `CLAUDE.md`

Instructs agents to prefer `.ai/why/` over commit messages when reading codebase reasoning. Makes the decision record the canonical source for understanding why code is the way it is.

### Inject why-pack context at edit time
Status: discussed
Touches: `lib/editor.ts`, `hooks/*`

Reasoning now surfaces automatically without requiring someone to remember to run `grepathy context`. Edit-time hooks inject why-pack content into the editor context.

### Document main's own build session in why-pack
Status: agent-initiated — Self-referential dogfooding not explicitly directed
Touches: `.ai/why/main.md`

The build session that produced these changes was itself captured and distilled, creating a self-referential why-pack that documents its own reasoning.

### Offer opt-in backfill prompt during grepathy init on projects with prior sessions
Status: discussed
Touches: `src/commands/init.ts`, `src/util/tty.ts`, `README.md`

When init runs on a project with existing local Claude session transcripts, it detects them and prompts the user with a default-No option to distill them immediately into the working tree. This makes the why-pack useful from day one for existing projects, while respecting the user's control flow (they must review before committing). Non-interactive mode (CI/scripted) never prompts, just prints a hint to run grepathy distill explicitly.

Considered/rejected: An alternative was to keep init pure and suggest a separate grepathy distill --backfill command. The prompt approach provides better discoverability by surfacing the option at init's natural entry point.
Risk: Running the distiller's LLM during init makes the command slow and blocking for users who have many prior sessions; the default-No and non-interactive guard minimize surprise, but adoption may suffer if users don't discover the option.
Reviewer attention: Verify that init never auto-stages or auto-commits the backfill result — the why-pack lands in the working tree only, and the human decides whether to commit. Confirm that non-interactive mode (GREPATHY_NONINTERACTIVE=1 or CI) never prompts or distills.

### Extract TTY utilities to shared src/util/tty.ts module
Status: agent-initiated — Architectural refactoring to enable code reuse between pre-push hook and init backfill
Touches: `src/util/tty.ts`, `src/commands/hook.ts`

TTY-detection and prompt logic (ttyAvailable, isNonInteractive, waitForEnter, promptYesNo) were extracted from hook.ts into a shared utility module. This allows init to reuse the same TTY-handling mechanisms and guarantees consistent non-interactive detection across the codebase.

Considered/rejected: Could have duplicated the logic or left it private to hook.ts, but extraction to a shared module prevents divergence and makes the behavior contract explicit.
Reviewer attention: Confirm that promptYesNo correctly defaults to false (No) on EOF, empty input, or unreadable /dev/tty; verify that both hook.ts and init.ts use the helpers consistently.

### Set promptYesNo default to No for safer user interaction
Status: discussed
Touches: `src/util/tty.ts`

The promptYesNo helper defaults to false (No) for empty input, EOF, or unreadable tty. This ensures init never auto-starts a multi-minute LLM distill by accident; users must explicitly type 'y' or 'yes' to opt in.

Risk: Reduces discoverability of the backfill feature; users may miss the prompt or skip it without understanding the benefit.
Reviewer attention: Verify that the prompt message clearly indicates [y/N] with N capitalized to show it's the default.

### Update README to document init's backfill offer for existing projects
Status: directed
Touches: `README.md`

Added a line to the install section noting that when init runs on an existing project, it will offer to backfill prior local Claude sessions. This documentation helps users discover the feature.

Reviewer attention: Confirm the README note mentions that backfill is optional and safe to skip.

### Commit distilled reasoning via scratch GIT_INDEX_FILE and commit-tree plumbing, never plain `git add`
Status: agent-initiated — implementation approach chosen, not explicitly requested in transcript
Touches: `pre-push hook`, `.ai/why/main.md`

The auto-commit mechanism uses git plumbing (commit-tree) with a scratch GIT_INDEX_FILE rather than `git add`. This design isolates distilled-reasoning commits from uncommitted working-tree changes, preventing accidental sweep of pending work into the why-pack commit.

Risk: Swept-cart bug: improper index state management could still cause unexpected files to be included in the commit.

### Commit only at SessionEnd and pre-push; auto-distill tick does not commit
Status: discussed
Touches: `src/commands/settlePoint.ts`

To avoid spamming commit history, the agent restricted auto-commit to two settle points: SessionEnd and pre-push. The background 3-minute auto-distill tick runs distillation and updates main.md but does not commit, keeping history clean while keeping why-pack current on disk.

Considered/rejected: Committing on every distill tick rejected due to commit spam and unnecessary history noise.
Reviewer attention: Confirm that distill and commit are truly independent operations and the 3-minute tick is only updating the working-tree file.

### Add sync: "auto" | "manual" config option, default auto
Status: directed
Touches: `src/util/config.ts`

Allows teams with strict commit-signing or CI conventions to opt out of tool-authored commits entirely. Teams that cannot tolerate auto-commits get `sync: manual`, which disables auto-commit and falls back to loud-status behavior instead.

### Provide grepathy sync escape-hatch command
Status: directed
Touches: `src/commands/sync.ts`, `src/cli.ts`

Gives users explicit manual control outside the automatic flow: distill all dirty sessions, then commit the why-pack, but never push. Acts as an opt-in alternative when users want to commit without relying on hooks.

### Freshness reporting on both git axes (uncommitted vs. unpushed) in status and doctor
Status: discussed
Touches: `src/commands/status.ts`, `src/commands/doctor.ts`

Reports whether the why-pack is committed and pushed, visible in one command regardless of sync config. Even with auto-commit enabled, unpushed can occur (e.g., via --no-verify plumbing), so both axes are always meaningful and worth exposing.

### Fix: skip deleted branches in resolution
Status: agent-initiated — bug discovered and fixed during development without explicit request
Touches: `branch resolution logic`

Discovered and fixed a bug where deleted branches were not being skipped during resolution, which caused failures when attempting to reason about removed branches.

### Document grepathy's commits in CLAUDE.md as safe to rebase past
Status: directed
Touches: `src/commands/init.ts`, `CLAUDE.md`

Marks commits titled 'grepathy: update why-pack' as tool-authored, safe to rebase past, and unsuitable for amendment into feature commits. Prevents the mirror-image of the swept-cart bug: an agent 'helpfully' squashing the tool's commit into its own and losing metadata.

### ensureClaudeMd now refreshes outdated CLAUDE.md blocks in place
Status: agent-initiated — quality-of-life improvement discovered during implementation
Touches: `src/commands/init.ts`

Changed initialization logic from early-exit ('already present, skip') to in-place refresh ('update if out of date'). Allows seamless tool upgrades: machines running an older grepathy binary can upgrade and have their CLAUDE.md blocks auto-refresh without user intervention.

### Implement autoCommitWhyPack plumbing with scratch GIT_INDEX_FILE + commit-tree
Status: discussed — contract converged externally
Touches: `src/commands/settlePoint.ts`, `src/plumbing/*`

The agent implemented auto-commit by using a scratch GIT_INDEX_FILE and commit-tree plumbing rather than git add against the user's working index, preventing accidental sweep of staged work by the agent or parallel operations. The implementation uses compare-and-swap update-ref to lose gracefully to concurrent commits. Guards include detached HEAD, mid-merge/rebase state, and detection of user mid-review (staged why-pack), all causing backoff and retry at the next settle point.

Considered/rejected: Direct git add approach rejected because it risks sweeping staged work from the user or concurrent agents.
Risk: Commits created during pre-push cannot ride that same push (git has already fixed refs), so they ride the next push instead. Status now makes this eventual-consistency model visible.
Reviewer attention: Verify that the scratch index never touches the user's real staging area, and that update-ref compare-and-swap actually loses gracefully when concurrent commits occur.

### Push operations remain human-gated; auto-push not offered
Status: discussed
Touches: `src/commands/sync.ts`, `src/config/defaults.ts`

The agent confirmed that auto-push is not offered as a feature. Commits land locally via auto-commit, but pushing is always manual. A sync configuration option of "manual" provides an off-switch for teams that prefer no auto-commit either.

Reviewer attention: Confirm that no code path auto-pushes and that sync='manual' actually disables auto-commit.

### Add visibility of uncommitted and unpushed why-pack via status and doctor
Status: agent-initiated
Touches: `src/commands/status.ts`, `src/commands/doctor.ts`

The agent enhanced status and doctor commands to report two axes previously invisible: whether the why-pack has uncommitted changes and whether it has unpushed commits. This makes the eventual-consistency model visible to users.

Reviewer attention: Verify that status/doctor correctly detect uncommitted and unpushed why-pack states and report them clearly.

### Consolidate and push straggler session to main.md, delete orphan backfill-on-init.md
Status: agent-initiated
Touches: `main.md`, `backfill-on-init.md`

The agent performed immediate cleanup: consolidated straggler session distillations into main.md (growing 38 to 52 decisions), scanned for secrets (clean), deleted orphan backfill-on-init.md, and committed and pushed via commit 7eddc25. GitHub is now current.

Reviewer attention: Verify that main.md is properly formatted and secret-scan was indeed clean.

### Re-enable hooks after build and ensure auto-commit fires at SessionEnd
Status: agent-initiated
Touches: `.githooks/*`

The agent had disabled hooks during plumbing development. After build completion, hooks were re-enabled to allow the settle-point commit logic to fire, providing dogfood proof that auto-commit works in this session's own lifecycle.

Reviewer attention: Confirm that hooks are properly re-enabled and SessionEnd will trigger the why-pack commit for this session.

### Document auto-commit feature and decisions in README and CLAUDE.md
Status: agent-initiated
Touches: `README.md`, `CLAUDE.md`

The agent updated documentation to explain the new auto-commit plumbing, settle points, sync configuration, and the reasoning behind pushing being human-gated.

Reviewer attention: Confirm documentation is clear on the eventual-consistency model and manual push gate.

### Add 8 new tests for auto-commit plumbing and 1 for branch resolution fix
Status: agent-initiated
Touches: `test/*`

The agent added 8 new tests covering the autoCommitWhyPack plumbing, settle points, and edge cases (detached HEAD, mid-merge, concurrent commits), plus 1 test for the branch resolution fix. All 54 tests pass.

Reviewer attention: Verify that edge-case coverage (detached HEAD, mid-merge, concurrent commits) is thorough and tests actually exercise the guard conditions.

### Add -uall flag to git status to list individual untracked files
Status: agent-initiated — bug discovered and fixed unilaterally during testing
Touches: `src/core/autocommit.ts`

When the .ai/why/ directory is wholly untracked (first-ever why-pack), `git status --porcelain` collapses it to the directory name instead of listing individual files within it. This caused res.files to report '.ai/why/' rather than the actual pack file path. Adding the -uall flag forces git to list individual untracked files, ensuring the file path is correctly reported.

Risk: Minor: -uall may increase git status output for very large untracked directory trees, though this is only called once during autocommit.

### Add test assertion to verify committed file paths preserve leading dot
Status: agent-initiated — assertion added to investigate and expose underlying bug
Touches: `test/autocommit.test.ts`

Added a deepEqual assertion to verify res.files correctly reports file paths with their leading dot (e.g., '.ai/why/main.md' rather than 'ai/why'). This test exposed the underlying bug in git status handling for untracked directories, which was then fixed by adding -uall.

### Auto-commit at settle points creates efficient delta-compressed storage
Status: agent-initiated — empirical investigation of actual repo behavior; approach was not requested
Touches: `.ai/why/main.md`, `.git/`

The agent measured that six revisions of main.md (156KB raw) compress to 18.5KB in a packed repository due to git delta compression. Each settle-commit appending or distilling near-identical text creates negligible overhead; churn is essentially free from a git storage perspective. At current intensity (~2KB per settle-commit), the pack reaches GitHub's soft limits only north of 20,000 commits.

Considered/rejected: Linear storage growth assumption was the initial worry; actual delta compression behavior invalidates it.
Risk: Risk analysis assumes distillation works; if it fails, linear growth resumes.

### Token cost, not git storage, becomes the real constraint at scale
Status: agent-initiated — constraint identified through independent analysis; not raised in question
Touches: `.ai/why/main.md`

Current HEAD size (38.9KB ≈ 10K tokens) surfaces the token-cost problem before any git limits bite. When agents full-read the pack into context, size becomes expensive per-request long before reaching GitHub's 50MB file warning. The design implication is that pack access must remain grep-scoped to relevant sections rather than bulk-loading.

Risk: Unbounded full-pack reads into context windows will consume tokens faster than storage grows; this becomes the scalability ceiling if distillation keeps HEAD bounded.

### Distillation mechanism is the critical control for unbounded growth
Status: agent-initiated — identified as the single lever through analysis of growth rates
Touches: `.ai/why/main.md`

The agent identified that whether pack HEAD growth plateaus or climbs linearly hinges entirely on distillation behavior. Without distillation: ~2KB per settle-commit yields 10MB/year on a 5-dev team. With distillation working (observed in log), growth plateaus. This is the single load-bearing invariant for long-term viability.

Risk: If distillation triggers become stale or are removed, HEAD size grows unbounded, eventually hitting the token-cost ceiling and then GitHub's 50MB warning.
Reviewer attention: Verify that distillation has working size and staleness triggers on main.md and actually compacts the file periodically, not just appends forever. This is the invariant the entire scalability claim rests on.

### Merge conflict risk on shared main.md for concurrent team auto-commits
Status: agent-initiated — workflow risk identified through architecture review
Touches: `.ai/why/main.md`

Per-branch pack files (.ai/why/<branch>.md) prevent conflicts on feature branches, but all branches distill into main.md. Concurrent auto-commits from multiple developers updating main.md simultaneously can collide. This is a workflow papercut rather than a storage problem, but noteworthy for CI commit ordering and team coordination.

Risk: Frequent merge conflicts on main.md if distillation and settle-point commits are not serialized or ordered.

### Back up all surviving project transcripts to prevent loss from automatic retention cleanup
Status: agent-initiated — Not in the eval plan; became critical when reconnaissance discovered that retention cleanup runs daily and target transcripts (28–32 days old) were hours from deletion on 2026-07-09.
Touches: `~/.claude/projects/*`, `~/grepathy-evals/transcript-backup-20260709/`

Claude Code's default automatic retention cleanup (cleanupPeriodDays: 30) deletes full session transcripts daily. Cleanup executed on 2026-07-09; oldest surviving transcripts in proof-of-life, [redacted], [redacted], and [redacted] repos were 28–32 days old and at imminent risk of deletion. Agent backed up all 106 surviving transcripts (~65 MB) to `~/grepathy-evals/transcript-backup-20260709/` to prevent permanent loss of irreplaceable evaluation material.

Considered/rejected: Delaying backup pending eval plan decisions; this would result in data loss regardless of subsequent choices.
Risk: Without backup, all eval transcripts older than 30 days are permanently deleted; this would have lost multiple repos' session data within hours.
Reviewer attention: Verify backup integrity. Determine whether an off-machine backup of ~/.claude from before July 2026 exists (cloud sync, external drive, archived copy); if yes, recovery of [redacted] and [redacted] transcripts (eval plan's primary and secondary repos) should be prioritized, as their full transcripts were auto-deleted by cleanup and only prompt-text history survives. Reconnaissance found only proof-of-life (2 sessions) has both code and transcripts on disk; the plan's target of ≥5 sessions per repo is not met for any surviving repo. Consider increasing cleanupPeriodDays in ~/.claude/settings.json to prevent loss of evaluation material during subsequent phases.

### Increase transcript retention period to 365 days
Status: directed
Touches: `~/.claude/settings.json`

The discovery that Claude Code deletes transcripts after 30 days by default renders all agent reasoning ephemeral while commit histories survive. Setting cleanupPeriodDays to 365 preserves the eval corpus and prevents ongoing loss of reasoning artifacts that form Grepathy's core value proposition.

Risk: Disk space accumulates over time; requires manual cleanup or architecture review once retention windows stabilize across multiple projects.

### Design two-pass privacy scanner with conversational-text isolation
Status: agent-initiated — implementation strategy for privacy auditing was agent's elaboration
Touches: `~/grepathy-evals/scripts/privacy_scan.py`, `~/grepathy-evals/scripts/privacy_scan2.py`

To audit whether why-packs leak intimate conversational content, the agent built a two-pass scanner: first detects all n-gram overlaps against raw transcripts, then narrows to conversational-only text to isolate genuine leakage from pasted-spec vocabulary. This controls for the confound that legitimate technical terms appear in both transcripts and why-packs.

Considered/rejected: Single-pass overlap detection would not separate pasted specs from conversational content; manual review would not scale. Automated approach enables repeatable privacy validation across many sessions.
Reviewer attention: Verify that conversational-text isolation correctly filters pasted content and that the 6-gram threshold is appropriate for this corpus.

### Compress transcripts to readable oracle input
Status: agent-initiated
Touches: `~/grepathy-evals/scripts/extract_convo.py`

The largest session is 7.9 MB (≈163k tokens uncompressed). Rather than burden oracle evaluation with token limits, the agent wrote a transcript extractor that preserves user prompts, assistant reasoning, and tool-use patterns while truncating repetitive output, reducing the input to readable length without losing decision flow.

Considered/rejected: Sampling or truncation would preserve token efficiency but lose context; full transcripts would exceed oracle limits. Lossless semantic compression balances both constraints.

### Scope retrospective evaluation to proof-of-life
Status: agent-initiated — plan mentioned two candidates; agent selected based on availability and decision density
Touches: `~/Dev/proof-of-life`

[redacted] has no recoverable remote repository, limiting it to transcript-based eval only; proof-of-life is on-disk with decision-dense code (webhooks, state reconciliation, timezone edge-cases, asset branding), enabling both backfill-cost measurement and behavioral bulldozer scenarios. The choice reflects prioritizing scenarios that test real tradeoffs over archived sessions.

Considered/rejected: [redacted] was backup if proof-of-life lacked decision density; proof-of-life's accessible implementation and multiple constraint types made it preferable.

### Run backfill on proof-of-life with full repo restoration
Status: discussed
Touches: `~/Dev/proof-of-life`

The agent initialized grepathy on proof-of-life, ran distill backfill on 4 prior sessions, captured the resulting why-pack, then restored the repository to pristine state (unstaging changes, reverting .gitignore modifications). This measured practical backfill cost (176 seconds for 4 sessions, producing 15 entries, 1 chunk skipped) without polluting the working repo.

Risk: Backfill found 1 distillation failure (chunk skipped), indicating partial recall coverage on some sessions. The distilled why-pack later showed overprecision: non-code business context (named third parties, financial constraints) leaked into entries despite having no code touches, representing both a precision miss and privacy weak point when human review is the only gate.

### Build isolated bulldozer clones with B (baseline) and C (with why-pack) conditions
Status: discussed
Touches: `~/grepathy-evals/bulldozer/pol-B`, `~/grepathy-evals/bulldozer/pol-C`

Two independent clones of proof-of-life were prepared: condition B runs without grepathy (baseline, commit-message reasoning only); condition C includes the why-pack plus a PreToolUse hook injecting it before the agent begins editing. This isolates why-pack effect by holding task and agent constant while varying available context.

Reviewer attention: Verify that the PreToolUse injection correctly surfaces the why-pack without over-constraining the agent's search space or inadvertently revealing the answer.

### Select three bulldozer scenarios spanning constraint visibility
Status: agent-initiated
Touches: `~/grepathy-evals/bulldozer/tasks/S1.txt`, `~/grepathy-evals/bulldozer/tasks/S2.txt`, `~/grepathy-evals/bulldozer/tasks/S3.txt`, `~/grepathy-evals/bulldozer/answer-keys.md`

Three scenarios test different constraint profiles: S1 (elimination webhook flow) has invisible constraints (deferred announcement, state reconciliation) absent from code; S2 (timezone DST handling) has visible constraints (documented in code comment); S3 (avatar self-hosting) has deliberate tradeoffs (rejected CDN, yellow-gradient branding). This design tests whether the why-pack adds value precisely where inline code documentation is sparse.

Considered/rejected: Scenarios were grounded in proof-of-life's real decision history rather than synthetic; synthetic tasks would simplify grading but would not test whether the tool improves reasoning on decisions the author actually faced.

### Implement blind-judging with condition-stripped, shuffled diffs
Status: discussed
Touches: `~/grepathy-evals/results/bulldozer/judge/**`

The agent assembled scenario bundles that show only the scenario, the resulting code diff, and a constraint-answer key, never revealing which condition (B vs C) produced each diff or in what order. Shuffling and anonymization prevent the judge from pattern-matching based on why-pack presence or ordering.

Reviewer attention: Confirm shuffle is effective and that the judge cannot reverse-engineer condition membership from diff style, agent reasoning patterns, or scenario sequence.

### Repeat flagship scenario for n=2 replication
Status: agent-initiated — noise-reduction decision made during eval execution, not pre-planned
Touches: `~/grepathy-evals/bulldozer/pol-B`, `~/grepathy-evals/bulldozer/pol-C`

After the first S1 run showed why-pack improving reasoning quality without flipping constraint preservation, the agent launched a second independent S1 run (S1b) on both conditions to check whether this pattern was robust or a single-run outlier. This provides n=2 for the flagship scenario.

### Conduct S1 variance verification with n=2 re-runs
Status: agent-initiated — not in original evaluation plan
Touches: `grepathy-evals/results/bulldozer`

The agent commissioned two additional S1 bulldozer runs to distinguish stable signal from noise in the flagship test. Both re-runs confirmed the pattern: baseline B consistently invented a false rationale (called safety guards "cosmetic"), while grepathy C sourced the documented why and explicitly labeled the constraint load-bearing. The stability confirmation raised confidence in Phase 3 findings.

Risk: Delayed Phase 2 launch, though agent overlapped the time to begin Phase 2 infrastructure setup.

### Pivot evaluation focus to Phase 2 as the critical measurement
Status: agent-initiated — prioritization shift based on Phase 3 results
Touches: `grepathy-evals/reviewer`

The agent identified that Phase 3's most significant finding — baseline B hallucinates intent when under simplification pressure, while grepathy C sources its reasoning — suggests hallucinated-intent rate (not guardrail strength) is the key differentiator. Phase 2 was elevated to measure this directly by asking neutral "explain why" questions rather than decision-making under pressure.

Considered/rejected: Continued focus on guardrail effectiveness (Phase 3's original ≥3/5 flip bar); grepathy missed that bar (1/3 flips), but the data suggested explaining reasoning rather than preventing collapse was grepathy's actual strength.
Risk: Phase 2 measures a different hypothesis than initially pre-registered; results cannot validate the original guardrail claim.

### Build Phase 2 read-only reviewer test harness with parallel lanes
Status: agent-initiated
Touches: `grepathy-evals/reviewer`, `grepathy-evals/reviewer/driver.sh`, `grepathy-evals/reviewer/Q*.txt`

The agent stood up a new test infrastructure with isolated reviewer clones (no hooks, read-only execution) running explanation questions sequentially on identical code snippets in two parallel lanes (baseline B and grepathy C conditions). This isolated measurement of "why-attentiveness" from decision-making pressure.

Reviewer attention: The shift to read-only reviewers vs. the bulldozer's edit-under-pressure context means Phase 2 measures a different capability; baseline B correctly inferred intent when asked neutrally to explain, unlike its bulldozer performance. Conclusions should account for this context change.

### Reframe grepathy value proposition from guardrail to explainer
Status: agent-initiated — interpretive reframing after Phase 3 missed pre-registered bar
Touches: (unspecified)

The agent reframed grepathy's evaluated capability from "prevents DESTROYED classifications" to "reduces hallucinated intent and sources reasoning." This became necessary because both conditions (B and C) identically collapsed S1 despite grepathy citing the why-pack, and because baseline B demonstrated correct reasoning when asked neutrally rather than under simplification pressure, indicating the value lies in transparency and sourcing rather than decision preservation.

Considered/rejected: Continue evaluating against the original ≥3/5 flip bar; the data clearly showed grepathy achieved ~1.7/5 extrapolated and the blind judge confirmed 1 of 3 scenario flips on the narrowed set.
Risk: The reframed hypothesis (explainer value) is post-hoc to the pre-registered guardrail measurement; Phase 2 results will be more compelling as independent verification than validation of an existing claim.

### Reposition Grepathy as reasoning rescue, not refactor guardrail
Status: agent-initiated — Core evaluation verdict; unprompted validation when [redacted]/[redacted] transcripts auto-deleted
Touches: `~/grepathy-evals/REPORT.md`, `memory/eval-verdict-2026-07.md`

Evaluation confirmed Grepathy's strongest value is rescuing code decision reasoning before Claude Code's 30-day transcript deletion cycle wipes it. This thesis was validated unprompted when target projects' session transcripts were automatically purged during the eval run. Lead positioning with the TTL-rescue and explainer story, not guardrail.

Considered/rejected: Guardrail positioning; testing showed preservation rate fell short (1/3 vs design bar ≥3/5)
Risk: Moving away from guardrail narrative may disappoint users expecting refactor prevention

### Constrain business narrative entries to code decisions; add proper-name detection
Status: agent-initiated — Privacy finding; blocking issue for ship
Touches: `grepathy/*`

Privacy audit of evaluation data found business narrative entries leaked named third parties and financial information despite automated filtering. Non-code entries must be restricted to code-decision context and proper-name detection added before shipping to prevent confidential data leakage.

Risk: Overly restrictive sanitization could exclude legitimate decision rationale; must validate business-context terms aren't incorrectly filtered
Reviewer attention: Audit privacy failures in detail; verify restricted entry format still captures load-bearing context

### Reduce provenance label over-flagging; improve accuracy from ~71%
Status: agent-initiated — Phase 0 finding; revalidated in evaluation
Touches: `grepathy/*`

Provenance labels (agent-initiated vs directed vs discussed) are Grepathy's most differentiated output but achieved only ~71% accuracy, systematically over-marking decisions as unilateral. Accuracy must improve substantially before this marquee feature justifies inclusion in the why-pack.

Risk: Unreliable provenance labels undermine trust in reasoning annotations across all decisions

### Implement cross-pass deduplication as pre-ship fix
Status: agent-initiated
Touches: `grepathy/*`

Evaluation identified duplicate and near-duplicate decision entries across multiple passes. Cross-pass deduplication is a prerequisite fix before release.

Risk: Aggressive merging could conflate distinct decisions with superficially similar text

### Grepathy's explainer margin is narrow; value limited to traceless decisions
Status: agent-initiated — Blind-judged Phase 2 finding
Touches: `~/grepathy-evals/REPORT.md`

Blind evaluation (why-pack C vs code-only B) showed baseline agent recovered 11/12 correctness on reviewer questions; Grepathy improved to 12/12. The entire margin concentrated on Q6, the sole question whose answer is traceless in code (CDN considered and rejected). On all five code-inferable or code-commented questions (Q1–Q5), both achieved identical 2/2 correctness. Grepathy's explainer value scales inversely with code self-documentation; when code has clear names, telling logs, and explanatory comments, diligent reasoning recovers most decisions unaided.

Considered/rejected: Broad explainer positioning; why-pack is correct and hallucination-free but adds measurable margin only where code is silent
Risk: Explainer pitch risks overstating coverage; codebases with strong documentation see minimal benefit

### Archive or fix guardrail feature before shipping
Status: agent-initiated — Evaluation verdict; preservation rate 1/3, bar ≥3/5
Touches: `grepathy/*`

Guardrail testing on 'simplify this' scenarios found Grepathy prevented only 1 of 3 destructive refactors. Feature failed its design bar and should not ship in current form. Either disable the guardrail for release or investigate and fix the preservation logic.

Risk: Shipping a failed guardrail creates false confidence; bad refactors may proceed undetected

### Commit distilled reasoning only at settle points, not on every auto-distill tick
Status: agent-initiated
Touches: `.ai/why/main.md`, `distill scheduler`

Auto-distill runs on a schedule and produces why-pack content, but intentionally does not commit it. Commits occur only at designated settle points: manual `grepathy sync` command or pre-push hook. This prevents commit spam while keeping reasoning available.

### Add configurable sync mode: 'auto' or 'manual'
Status: agent-initiated
Touches: `configuration system`, `.ai/why/main.md`

Configuration allows users to choose whether sync (distill + commit) operates automatically or only on explicit command, accommodating different workflow preferences and control requirements.

### Provide `grepathy sync` escape-hatch for manual on-demand sync
Status: agent-initiated
Touches: `CLI interface`

Implemented a manual command allowing users to trigger distillation and commit of the why-pack independently of auto-sync schedules or pre-push hooks.

### Implement freshness reporting on both git axes
Status: agent-initiated
Touches: `.ai/why/main.md`, `status output`

Status output reports whether the distilled why-pack is synchronized with the current git state, providing transparent visibility into whether reasoning is stale relative to recent code changes.

### Bug: 'agent-initiated' decision status label has approximately 30% false-positive rate
Status: directed — evaluation testing revealed accuracy problem; flagged as fix-before-ship
Touches: `decision classification logic`, `.ai/why/main.md`

Evaluation found that the ⚠️ 'agent-initiated' label, intended to flag unilateral agent decisions, falsely marks approved or discussed decisions as agent-decided approximately 30% of the time. This false-positive rate significantly undermines the signal's reliability and trustworthiness.

Risk: Excessive false positives reduce reviewer trust in the mechanism and diminish the impact of legitimate agent-initiated flags.

### Bug: personal names and business details leak into shared why-pack file
Status: directed — critical privacy issue discovered during real-world evaluation testing
Touches: `.ai/why/main.md`, `content redaction`, `privacy filtering`

Real-world evaluation revealed that personal names and business negotiation context from session transcripts were being committed into the shared why-pack file in version control. Standard secrets-scanning tools do not detect this category of information (business context rather than cryptographic material). Currently only manual review before push prevents this leak.

Risk: Undetected exposure of PII and business-sensitive information in a shared repository. Affects privacy compliance, confidentiality of business negotiations, and team trust.
Reviewer attention: Implement redaction heuristics to detect and remove PII, personal names, financial details, and business negotiation context before committing. Test against real-world session transcripts to verify redaction effectiveness and coverage.

### Design test with non-directive tasks, mechanically-observable ground truth, and pre-registered success bars
Status: directed
Touches: `grepathy-evals/warmstart-lab/`, `grepathy-evals/REPORT.md`

Test uses three design fixes to address Bulldozer's flaws: (1) tasks are non-directive (build something new; nothing instructs the agent to violate a lesson on purpose), (2) ground truth is mechanically observable (violations logged to violations.jsonl by the service itself), not judged from diffs, (3) success bars are pre-registered before any run to prevent p-hacking. Success threshold: grepathy condition (C) re-hits a failure mode ≤50% as often as baseline (B), across ≥4 eligible failure modes.

### Implement mock external service with six undocumented, deterministic quirks
Status: directed
Touches: `grepathy-evals/warmstart-lab/mock-service/service.py`

Service replicates real-world API pain: duplicate webhooks, silent-drop rate limiting, pagination off-by-one, timestamp zone instability on one endpoint only, ID type instability (ints vs. strings), empty-array-vs-null. Deterministic, in-memory, stdlib-only for portability. Timing-dependent quirks explicitly dropped in favor of request-count thresholds for reliability.

### Implement mechanical violation checker as ground truth for scoring
Status: directed
Touches: `grepathy-evals/warmstart-lab/mock-service/checker.py`

Checker reads consumer run outputs and crash status, compares against service-seeded ground truth, emits per-failure-mode PASS/RE-HIT/N/A verdicts. Violations logged by service during runs, replacing subjective diff judgment with completely objective scoring.

### Design three transfer scenarios testing learning on new-code-only tasks
Status: directed
Touches: `grepathy-evals/warmstart-lab/README.md`, `grepathy-evals/warmstart-lab/mock-service/checker.py`

Each scenario: lesson session (agent builds feature, hits quirks, learns) followed by transfer task (fresh agent, adjacent feature, new files only). S1: order-events → refund-events webhook; S2: products → customers sync; S3: order-totals → weekly-revenue report. Transfer code doesn't inherit Session A defenses, ensuring why-pack is the sole lesson artifact.

### Move service and checker outside agent repo to prevent contamination
Status: agent-initiated — discovered during validation; not in user spec; restructuring planned but not yet executed in transcript
Touches: `grepathy-evals/warmstart-lab/`, `wsharness/`

Agent detected that agents could read mock-service/service.py and checker.py from the repo, revealing all quirks and invalidating test design. Restructured plan: move service and checker to external harness (wsharness/) so agents encounter only opaque HTTP endpoint and must learn by hitting quirks, not reading source. Ensures why-pack is sole differentiator between baseline (B) and grepathy (C).

Risk: Harness moved outside adds operational complexity; cross-run state-sharing or network isolation failures could corrupt results.
Reviewer attention: Verify service runs independently; confirm agents cannot access harness source or violation logs; check that B and C runs are truly isolated.

### Return N/A (not RE-HIT) when run crashes before completion
Status: agent-initiated — identified as correctness bug during implementation
Touches: `grepathy-evals/warmstart-lab/mock-service/checker.py`

Agent identified that crashes on one failure mode (e.g., null-items quirk) leave output files unparseable, spuriously marking independent failure modes as RE-HIT. Checker now returns N/A for any mode with incomplete ground-truth data, preventing cascading false positives.

### Validate full scoring pipeline with dummy solvers before transfer runs
Status: agent-initiated
Touches: `grepathy-evals/warmstart-lab/mock-service/checker.py`

Agent validated scorer correctness before investing in 18 transfer runs. Naive solver correctly scored RE-HIT on s1b (null crash) with s1a marked N/A; correct solver scored PASS on both. Confirmed no systematic false positives or negatives.

### Capture API quirks in why-pack after Session A runtime discovery
Status: agent-initiated — Verification audit confirmed both entries captured in pack
Touches: `.ai/why/order-events-consumer.md`

Two API quirks were discovered during Session A execution: the event feed delivers every event_id exactly twice, and some events include `items: null` rather than an empty array. Both lessons were recorded in the why-pack and verified present (2/2 lesson recall).

### Recognize new-file scenario disables automatic context injection
Status: agent-initiated
Touches: `solve_refunds.py`

Context-matching analysis determined that for new transfer files (solve_refunds.py), grepathy injection cannot fire because no prior solution exists to inherit from. Lessons reach new code only through the CLAUDE.md pointer prompting proactive discovery, not through automatic context attachment.

Risk: Lesson transfer is brittle without systematic injection; agents unaware of why-pack locations will not discover API quirks. Transfer effectiveness depends entirely on prompt design, not architecture.

### Design S1 transfer test with new file to isolate discovery path
Status: agent-initiated
Touches: `solve_refunds.py`, `solve_orders.py`

The transfer scenario creates solve_refunds.py as a new task file where context injection cannot fire, ensuring the experiment cleanly measures the discovery path. Both baseline snapshots include solve_orders.py, allowing agents to copy its handling if they reference it proactively, but context-matching will not surface lessons automatically.

### Launch 6 parallel transfer experiments (3×B baseline, 3×C with discovery)
Status: agent-initiated
Touches: `solve_orders.py`, `solve_refunds.py`

Six transfer runs execute in parallel: three with configuration B (baseline without discovery mechanism) and three with configuration C (with CLAUDE.md-driven why-pack discovery enabled). This measures whether the discovery path enables agents to learn and apply the two API quirks to new code.

### Invalidate S1 consumer-to-consumer test design for transfer-learning claim
Status: agent-initiated — determined via diagnostic inspection of baseline behavior
Touches: `grepathy-evals/results/warmstart`, `grepathy-evals/wslab2`

All 6 S1 runs (both baseline B and Session C variants) passed both quirks with zero re-hits, which contradicts the expected transfer-learning signal. Investigation found that baseline agents inherited the why-pack lesson directly from solve_orders.py—a sibling consumer file Session A had committed to the repository. This design conflates code reuse with transfer learning and does not isolate whether the harness learns from transcripts versus available source code.

Considered/rejected: Continuing with the embedded-lesson-in-committed-code approach; sibling file availability provides an uncontrolled side channel that invalidates the test.
Risk: Harness bug: baseline B retrieved the why-pack via git show on earlier commits even though the file was deleted later, indicating blob scrubbing is incomplete. This contaminated baseline isolation.
Reviewer attention: Confirm that the new investigation-only design (lesson in transcript only, never written to code) with pre-why-pack history baseline actually tests transfer learning without side channels.

### Rebuild transfer test with investigation-only lessons and clean baseline isolation
Status: agent-initiated
Touches: `grepathy-evals/wslab2`

New design: Session A investigation discovers quirks in conversation but commits no consumer code to the repository; baseline is built from pre-why-pack git history to ensure clean isolation; transfer Sessions B and C must rediscover the lesson from the investigation transcript alone. This approach genuinely tests whether transfer learning occurs in the harness rather than code copying.

Risk: Increased harness complexity: investigations must be reproducible, transcripts must contain discoverable patterns, and transfer sessions must have no access to previously-committed consumer files.

### Filter test quirks to only actionable and differentiating patterns
Status: agent-initiated — design decision during endpoint analysis
Touches: `grepathy-evals`

For the products endpoint, the archived-omission quirk is unrecoverable—there is no /products/{id} endpoint to fetch archived records—making it non-differentiating for transfer performance. Test focus shifts to actionable quirks that are truly discoverable: dedup errors, null-coercion bugs, pagination off-by-one errors, and id-type join mismatches.

Risk: Unrecoverable quirks are dropped from coverage; only publicly-testable patterns can measure transfer effectiveness.

### Distill pure investigation into decision pack despite no code changes
Status: agent-initiated
Touches: `.ai/why/*`

The Session A investigation identified two pagination bugs (off-by-one total_pages recoverable via exhaustive paging; phantom total_count for archived items unrecoverable) but modified no consumer code. Grepathy's distiller successfully extracted 3 decision entries from the transcript-only findings, proving that investigations without code changes can still generate actionable packs.

Considered/rejected: Discarding the investigation as non-actionable because no files changed; accepting lesson as transcript-ephemeral without structured capture.
Risk: Pack generation relies on SessionEnd hooks; hook failure would leave findings trapped in transcript only.

### Use glob patterns in pack entries to enable cross-scenario injection
Status: agent-initiated
Touches: `.ai/why/*`

Pack entries tagged with **/*products* enable PreToolUse hook injection to any scenario with matching files (e.g., solve_products.py), rather than hardcoding to single file paths. This increases reusability and allows Session A findings to transfer to other scenarios without manual reconfiguration.

Risk: Overly broad glob matching could inject irrelevant findings into unintended modules.

### Build parallel snapshots (baseline without pack, variant with pack) for transfer evaluation
Status: agent-initiated
Touches: `snap2-B`, `snap2-C`

snap2-B established clean baseline with README only and no .ai history. snap2-C added transcript-driven pack and grepathy hooks to enable PreToolUse injection. Running 6 parallel transfers measures whether distilled findings improve outcomes when injected, controlling for confounding changes.

Risk: Snapshot divergence on dimensions beyond the pack (hooks, config) would confound transfer comparison.
Reviewer attention: Verify snap2-B and snap2-C differ only in pack presence and hook installation, not in baseline configuration or dependencies.

### Kill stray services and re-run S2 transfers with dead SERVICE_URL
Status: agent-initiated — methodology confound discovered during S2 results analysis
Touches: `grepathy-evals/results/warmstart`, `S2 transfer evaluation`

A stray service (pid 2347 on port 8799) was discovered running during the S2 evaluation. Because the README's example URL referenced :8799, some transfer agents probed this live API and re-discovered quirks, while others hit different stubs or built mocks. This created inconsistent baseline behavior that conflated pack contribution with accidental live access. Killing the stray and re-running with guaranteed-dead SERVICE_URL ensures all agents code purely from repository knowledge, cleanly isolating the pack's value.

Risk: Re-run delays results; isolation is necessary for validity.

### Shift primary test case from pagination to id-type join mismatch
Status: agent-initiated — insight from S2 pagination results showing marginal pack benefit
Touches: `test scenario design`, `transfer task definitions`

S2 pagination results showed modest pack benefit (B re-hit 1/3, C 0/3), revealing that pagination re-fetching is a textbook quirk—competent agents apply defensive paging by default. An id-type mismatch (string '1' vs. int 1) is superior: it is silent (joins silently return zero rows), not defensible by default (agents don't guard against type coercion), and represents a genuine corner case that only a knowledge pack can surface.

Considered/rejected: Pagination re-fetching was demoted because baseline agents avoided it 2/3 of the time even without knowledge, making the pack's marginal value unclear.

### Redesign join transfer task to require customer-name keying
Status: agent-initiated
Touches: `transfer-JOIN.txt`

The join task was restructured to group by customer name rather than id, forcing agents to execute a customer-id join instead of bypassing it. This ensures the type mismatch surfaces when the join executes.

### Document distiller limitation: investigation-only sessions need explicit --branch
Status: agent-initiated — finding from 2 of 3 investigations producing empty packs
Touches: `grepathy distiller`, `wslab3`, `wslab4`

Events and join investigations produced zero pack entries with automatic distillation, while a parallel products investigation succeeded. Root cause: pure investigation sessions commit no code, so the distiller cannot attribute insights to a branch and silently produces empty packs. Manual recovery required explicit --branch flag, which yielded 3 entries from the join investigation (e.g., 'Normalize customer_id type before joining... zero of 40 orders matched'). This is a gap in the warm-start workflow where insights are discovered but lost.

Reviewer attention: Distiller should automatically capture investigation-only sessions, or the warm-start case will lose lessons by default.

### Isolate investigation streams into separate repositories
Status: agent-initiated
Touches: `wslab3`, `wslab4`, `grepathy-evals harness`

Events investigation (requiring live service to discover dedup and null quirks) and join investigation (requiring dead SERVICE_URL) ran in separate fresh repositories rather than sequentially. Isolation prevented interference and enabled parallelization.

### Create transfer_join.sh driver for join-based transfers
Status: agent-initiated
Touches: `~/grepathy-evals/wsharness/transfer_join.sh`

Built a dedicated driver to run 6 join transfers (A/B/C × 1/2/3 replicates) with customer-name keying and dead SERVICE_URL, isolating the pack's ability to surface the silent id-type mismatch.

### Record checked-out branch at hook time to fix no-commit session attribution
Status: discussed
Touches: `src/state/state.ts`, `src/commands/hook.ts`, `src/core/distillSession.ts`, `src/matching.ts`

Sessions with no commits (pure investigation or debugging) cannot be attributed to git refs. The fix records the checked-out branch at Stop/SessionEnd hook time, stores it as last_branch in SessionRecord, and prefers it in resolveBranch and matchSessionToBranches. This ensures no-commit sessions are attributed to the branch the developer was on, restoring the 2 of 3 investigation sessions previously lost to empty packs.

### Invert agent-initiated status bias to default discussed
Status: discussed
Touches: `src/distiller/model.ts`, `src/distiller/prompt.ts`

The agent-initiated flag was ~71% accurate with high false-positive rates on approved changes, training reviewers to ignore the signal. The fix inverts the default: coerceStatus now emits discussed unless the distiller affirmatively finds NO user turn touching the decision. The prompt now states agent-initiated must be EARNED, not the default, preserving its integrity by restricting it only to cases where no user involvement is evident.

### Require entries to name concrete files or globs in Touches field
Status: discussed
Touches: `src/distiller/model.ts`, `src/distiller/prompt.ts`

A privacy leak occurred when entries with unspecified touches (business-narrative entries touching no concrete code) were never detected as invalid. Entries with empty/missing touches are now rejected in coercePack. This enforces a structural invariant — a code decision must name code — which serves both as a privacy guardrail (business-logic-only entries are inherently invalid) and a clarity filter.

### Forbid business and financial narrative at generation time
Status: discussed
Touches: `src/distiller/prompt.ts`

Business-narrative leaks must be fixed at the prompt layer, not post-hoc regex. The privacy contract now explicitly forbids revenue figures, pre-revenue status, funding/runway language, deal terms, and third-party company/person names — these must be omitted entirely during distillation. This follows grepathy's documented principle that intent-quality logic belongs in prompt contracts, not phrase-guessing regexes.

### Fix cross-pass dedupe via LLM-driven title re-matching, not stopwords
Status: discussed — strategy decided; implementation deferred pending prompt plumbing
Touches: `src/distiller/similarity.ts`, `test/similarity.test.ts`

Cross-pass duplicate clustering reduces precision to ~0.65 when re-distilling produces near-duplicates. The fix is semantic: feed previous decision titles into the re-distill prompt, instructing the distiller to reuse exact titles when it recognizes the same decision. This achieves deterministic deduplication with semantic understanding.

Considered/rejected: Stopword-filtered tokenization and regex proper-noun detection — both rejected as unscalable heuristics that don't generalize. Pattern-matching doesn't scale; the LLM should make semantic decisions instead.
Risk: Cross-pass duplicates remain in packs until the semantic re-matching fix is implemented.

### Scope title-anchoring to same-branch pack to prevent cross-branch collisions
Status: directed — User's guardrail before implementation: 'keep the prompt small and avoids cross-branch title collisions'
Touches: `src/core/distillSession.ts`

When the distiller receives known-titles for title-reuse, limit those titles to the target branch's existing pack only, not titles from other branches. This keeps the re-distill prompt bounded and prevents false-positive title collisions when the same semantic decision appears independently in different branches.

Reviewer attention: Confirm that distillSession resolves the pushed branch and reads only its pack before calling distillEvents with knownTitles

### Add regression fixture for Bug 3 privacy contract enforcement
Status: directed — User insisted before closing bug 3: 'that transcript (or a sanitized reconstruction of it) should be a test where the expected output is either the neutral-constraint phrasing or no entry at all'
Touches: `test/*`, `test/distiller.test.ts`

Add a fixture test reconstructing the real business-narrative leak class (touchless entries carrying a third-party name and pricing figures, `Touches: (unspecified)`) mixed with a legitimate code decision. Verify the privacy contract clause drops or neutralizes the business-narrative entries while preserving the code decision. Locks the contract into the test suite to prevent regression when the prompt is edited later.

Considered/rejected: Relying solely on 'the prompt says not to' allows silent regression; a test materializes the contract as an enforceable invariant.
Reviewer attention: Confirm the expected output omits the business details and includes the legitimate code entry.

### Add test for title-reuse preserving human edits via shadow-hash suppression
Status: directed — User: 'should be a test case, not an accident'
Touches: `test/whypack.test.ts`

Add an explicit test case verifying that when title-anchoring causes the distiller to reuse an existing entry's title during re-distillation, any human edits to that entry are not overwritten. The shadow-hash deduplication rules should preserve the human edit, treating it as canonical.

Reviewer attention: Verify the test creates an entry, hand-edits its body, re-distills with an identical title, and confirms the human edit survives the merge

### Guard intent field against business/financial narrative in distiller prompt
Status: agent-initiated — Discovered during automated POL re-distillation verification
Touches: `src/distiller/prompt.ts`

During automated POL re-distillation to verify prior privacy-work changes, the agent discovered that intent fields were leaking financial and business details. The existing privacy-contract guardrails applied only to decision entries. The agent extended the prompt's guardrails by explicitly forbidding commercial motivation, funding, and business rationale in intent fields, ensuring the privacy contract applies uniformly across all output fields.

Risk: None—this is a safety enhancement to prevent information leakage.
Reviewer attention: Verify that intent fields in distilled output no longer leak commercial motivation, pricing, funding status, or business rationale when processing sessions with business context. Check POL re-distillation results to confirm the fix.

### Add deterministic monetary-figure detection to intent field
Status: discussed
Touches: `src/distiller/model.ts`

The intent field lacks the Touches backstop available to other pack fields, making it vulnerable to prompt-dependent leaks. A deterministic regex-based guard was implemented to detect currency notation across formats and blank the intent when matched, providing high-confidence protection independent of model behavior.

Risk: Non-standard currency notation or informal money references in other languages may be missed by the pattern.

### Extend privacy validator to flag monetary figures
Status: discussed
Touches: `src/distiller/validator.ts`

Currency-form detection was integrated into the privacy validator, flagging monetary figures anywhere in the pack. Violations trigger the validator's existing retry/fail paths, creating a second defensive layer against leaks that escape intent-level checks.

### Add test coverage for monetary-figure detection
Status: discussed
Touches: `test/validator.test.ts`, `test/distiller.test.ts`

Test cases were added covering intent-level blanking and validator-level flagging across multiple currency formats. Empirical validation confirmed the pattern covers standard, grouped, and per-unit notation with zero false positives on technical figures such as dimensions, times, ports, hex strings, and shell variables.

Reviewer attention: Verify that the regex does not over-match dollar signs in code contexts such as shell variable references.

### Consolidate evaluation report without addendums for public documentation
Status: discussed — User raised question of addendum utility; agent decided consolidated narrative is preferable for public consumption.
Touches: `docs/REPORT.md`

For open-source documentation, a single consolidated narrative without chronological addendums presents more credibly to newcomers than showing the iterative investigation process. All verification work and honest numbers are preserved in a unified narrative rather than fragmenting the story across sequential addendum entries.

Considered/rejected: Including addendums (as in the internal version) would add process transparency but reads less polished for external consumption.
Risk: The consolidated narrative might appear glossed-over to readers seeking detailed investigation process; full process transparency requires supplementary documents.
Reviewer attention: Verify that all fix details and verification work are actually represented in the consolidated narrative without material loss or omission.

### Extract and modularize documentation into separate docs/ pages
Status: directed
Touches: `docs/privacy.md`, `docs/how-it-works.md`, `docs/format.md`, `docs/parallel-agents.md`, `docs/config.md`, `README.md`

User requested consolidating the verbose README by moving detailed reference material into separate pages. Five topic-specific deep-dive documents were extracted and refined from existing README content: privacy, architecture/how-it-works, format specification, parallel-agent behavior, and configuration. The main README now provides product overview, quick-start examples, and navigation to reference docs, keeping the primary document lean and accessible.

Risk: Documentation becomes fragmented across multiple files; cross-document links may break if file structure changes; individual docs/ pages may drift from implementation if not kept synchronized during future development.
Reviewer attention: Verify all cross-document links resolve correctly and that each docs/ page accurately reflects current implementation behavior.

### Add Development section to README for contributor guidance
Status: discussed — Not explicitly requested in user's draft, but inferred as aligned with open-source conventions and user's goal of building a 'nice, clean, popular tool.'
Touches: `README.md`

Open-source repositories conventionally include a Development section to signal openness to contributions and provide setup guidance. User requested making Grepathy a 'very nice, clean, popular tool' and gave freedom for agent judgment; the section was added based on professional assessment that it supports community adoption and contribution.

Risk: Development section could become outdated if build or contribution processes change; adds maintenance burden if not kept current with actual developer experience.

### Add dated addendum to evaluation report while preserving original findings
Status: discussed — contradicts 'Consolidate evaluation report without addendums' in light of warm-start test findings
Touches: `../grepathy-evals/REPORT.md`, `memory/eval-verdict-*.md`

Warm-start transfer test results showed that synthetic textbook quirks (dedupe, null-guard, pagination, type-coercion) are too defensible for why-pack demonstration, as competent agents apply these practices by default; one baseline agent even coerced string/int types without the pack. Rather than consolidating findings without addendums as previously decided, the agent preserved original test results verbatim and added a dated addendum (2026-07-10) documenting test scope, distiller limitations (no-commit sessions require explicit --branch for branch attribution), and refined interpretation that grepathy's value lies in capturing non-obvious, counter-intuitive, traceless knowledge rather than textbook defensive practices.

Considered/rejected: Consolidating report findings into a single integrated narrative; kept original structure to preserve pre-registered empirical results as-is
Risk: Readers may conflate original findings with retrospective addendum analysis; addendum must be clearly demarcated as post-hoc interpretation
Reviewer attention: Verify REPORT.md clearly distinguishes original findings (B 2/6, C 1/6, within noise) from dated addendum; confirm addendum accurately describes what the warm-start test measures versus didn't measure

### Enforce hard time budget at chunk granularity with deadline threading
Status: discussed
Touches: `src/distiller/index.ts`, `src/core/distillSession.ts`, `src/commands/hook.ts`

Thread deadline into distillEvents() to enforce time budget between chunks, not just between sessions. Per-call timeout shrinks to min(PER_CALL_TIMEOUT_MS, deadline - now) to prevent the final chunk from exceeding the hard wall-clock cap. Sessions hitting the deadline mid-distillation write a partial pack (progress preserved), mark themselves dirty with offset intact, and complete on a later unbudgeted run. Title-anchoring deduplication prevents duplicates when the second half completes. Pre-push hook now respects a hard contract: complete under timeBudgetMs or defer with explicit message, never block.

Considered/rejected: Allowing per-call timeout to run independently of the deadline would let the final chunk exceed the budget; per-call timeout must become deadline-aware instead.
Risk: Partial-resume path becomes normal instead of rare; incorrect offset tracking could leave sessions stuck dirty or create duplicate entries on resumption.
Reviewer attention: Verify session stays dirty with correct offset after truncation; confirm merge doesn't create duplicates when second half arrives; validate real-world timing respects the budget.

### Implement bounded-concurrency worker pool for chunk parallelization
Status: discussed
Touches: `src/distiller/index.ts`, `src/util/config.ts`, `test/budget.test.ts`

Add worker pool to distill transcript chunks in parallel (default concurrency 3, tunable via config.distiller.concurrency). Results merge back in transcript order to preserve deterministic input for title-anchoring and deduplication. Low concurrency avoids CLI backend subprocess collision (each subprocess claims a cwd for recursion guard); API backend users can tune higher. Default 3 is conservative but sufficient to usually finish large sessions inside the 60s budget.

Risk: CLI backend parallelism depends on per-worker cwd isolation (already in place for recursion guard); if concurrency set too high (>5), subprocess contention and lock-file collisions become an issue.
Reviewer attention: Confirm per-worker cwd prevents CLI backend session-state collisions; verify chunks merge in transcript order regardless of completion timing; stress-test to find the breaking point for high concurrency.

### Add visible deferral message when pre-push time budget exhausted
Status: discussed
Touches: `src/commands/hook.ts`, `docs/how-it-works.md`

When pre-push distillation hits timeBudgetMs and must defer sessions, emit message showing count and next step (grepathy sync). Converts silent staleness (user doesn't know why-pack is old) to visible, bounded staleness (user knows and can act). Signals that truncation was deliberate, not a bug, and points to the escape hatch. Aligns with the project's principle that mysterious system behavior erodes trust.

### Reject grepathy push wrapper; document and accept one-push lag as bounded property
Status: discussed
Touches: `docs/how-it-works.md`

Do not build grepathy push command to guarantee why-pack commits travel with code in the same push. The pattern "users remember to use the special command" has failed three times already in this project; agents type plain git push mid-session, and adoption would stall at ~5% while 95% of pushes defaulted to the original command. Instead, ship the one-push lag as an honest, bounded property. Mitigations are already in place: sessions ending before push have zero lag (SessionEnd auto-commits before push happens), grepathy sync closes the gap on demand, and lag is visible in status. PR review is not a snapshot; a why-pack commit landing minutes after PR opens is there before any reviewer reads code. Push-through (auto-push of why-pack after human-approved PR) is deferred to v1.x; it solves the narrow unconfirmed case of "mid-session push, PR opened, never pushed again," which the Show HN comments will adjudicate.

Considered/rejected: grepathy push wrapper — would sit at ~5% adoption while 95% of pushes defaulted to git push, repeating the "special command" pattern the project has already unlearned three times.
Risk: Mid-session pushes carry why-pack one push behind, but this is bounded by SessionEnd's own distillation and visible via status.
Reviewer attention: Confirm this correctly rejects the special-command pattern; validate SessionEnd commits before most users push; if users report stranded-commits, push-through becomes the v1.x answer.

### Add comprehensive test suite for deadline enforcement and partial-resume
Status: discussed
Touches: `test/budget.test.ts`, `test/distillSession.test.ts`, `test/helpers.ts`

Add test/budget.test.ts covering deadline truncation, shrunk per-call timeout, and ordered chunk merge. Expand distillSession.test.ts to cover the partial-resume state machine: truncated session writes partial pack, stays dirty with offset intact, completes on next trigger without duplicates. Add DelayMock helper for timeout testing. Brings total to 64 tests, stable across 5 runs. Tests are required because partial-resume, previously rare, becomes a normal path under heavy load; correctness on that path is load-bearing.

Reviewer attention: Confirm budget tests don't flake over many runs (10+); verify distillSession tests cover full resume flow including dedup; spot-check one real large session's truncation behavior.

### Bump GitHub Actions to v7 to clear deprecation warnings
Status: agent-initiated — Cleanup spotted during CI review; not requested by user
Touches: `.github/workflows/ci.yml`

Update actions/checkout and actions/setup-node from v4 to v7 to remove Node-20 deprecation warnings from the Actions tab. Cosmetic improvement for launch-readiness without behavior change.

Reviewer attention: Confirm CI passes on v7 actions.

### Add Mermaid diagram to README visualizing hook context injection flow
Status: discussed
Touches: `README.md`

A Mermaid diagram was added to the README to visualize how grepathy's hook system automatically injects context for future agents. The diagram illustrates two read-side triggers—the CLAUDE.md pointer and the PreToolUse hook—both sourcing from the committed why-pack to provide agents with historical decision context before they edit files with prior work. This eliminates the need for agents to manually search for or remember to access this information.

Reviewer attention: Verify the diagram renders correctly in GitHub's Mermaid parser and accurately represents the automatic context injection flow.

### Simplify Mermaid diagram labels to avoid GitHub rendering issues
Status: agent-initiated — not requested; proactively identified and fixed potential rendering issues
Touches: `README.md`

The agent identified potential special-character rendering issues in the diagram and proactively simplified the why-pack cylinder label from 'the why-pack — committed<br/>.ai/why/ · one file per branch' to 'the why-pack<br/>(.ai/why/, committed)' to ensure consistent GitHub Mermaid rendering.

Risk: Simplified labels may lose some granular detail about the per-branch structure, though essential information (file path and committed status) is preserved.
Reviewer attention: Confirm simplified labels remain clear and that the diagram renders without issues across GitHub's Mermaid implementation.

### Add npm package metadata fields to package.json
Status: agent-initiated — Identified during pre-flight verification as missing before public release
Touches: `package.json`

Agent identified that npm package metadata fields (author, repository, homepage, bugs) were absent and added them to ensure the npm package page displays correctly when published to npmjs.com.

Risk: If the metadata values are incorrect or incomplete, the npm page may display wrong information or missing project links.
Reviewer attention: Verify that the added npm metadata fields contain correct and complete values before publishing to npm.

### Pre-push hook always commits uncommitted why-pack in auto mode
Status: discussed — User identified staleness; agent diagnosed root cause and implemented fix
Touches: `src/commands/hook.ts`

The pre-push hook was only committing newly-distilled why-pack changes, leaving background-distilled changes stranded uncommitted. This caused the why-pack to lag one push behind git. The fix ensures autoCommitWhyPack is called unconditionally in auto mode, so any uncommitted why-pack state gets committed at the push gate. During clean-room verification, a second bug emerged: an early return when no sessions needed distilling skipped the commit block entirely. Control flow was restructured to ensure the commit always executes in auto mode.

Considered/rejected: Original approach (commit only newly-distilled changes) was insufficient because background Stop-hook distills write changes that remain uncommitted until the next push, creating the staleness lag.
Risk: Control-flow restructuring could affect performance characteristics; however, early-exit paths for avoiding unnecessary processing when no sessions need distilling remain intact.
Reviewer attention: Verify that the restructured control flow preserves the performance optimization (still skips expensive operations when unneeded) while ensuring all paths commit any pending why-pack changes in auto mode.

### Bump package version from 1.0.0 to 1.1.0 per semantic versioning
Status: discussed
Touches: `package.json`, `package-lock.json`

The agent applied semantic versioning conventions, bumping the minor version to reflect a backward-compatible feature addition to the package. The version was tagged as v1.1.0 for release.

### Create publish-on-tag GitHub Actions workflow
Status: discussed
Touches: `.github/workflows/release.yml`

The agent scaffolded a GitHub Actions workflow that automatically publishes the package to npm when a version tag matching v* is pushed. This automates the build-and-publish mechanism while preserving the human gate—developers remain in control by explicitly deciding to release via `npm version <semver>` and `git push --follow-tags`.

Considered/rejected: Rejected automatic publish-on-merge to main in favor of explicit tag-based releases, ensuring humans retain the explicit decision to ship.
Risk: Requires NPM_TOKEN GitHub secret to be configured for npm registry authentication. Workflow will fail silently if token is missing or expired.

### Restore grepathy's auto-distilled why-pack after version bump
Status: discussed
Touches: `.ai/why/main.md`

The agent detected that grepathy's distiller had updated the why-pack file during the session, which would block `npm version` since it requires a clean working tree. It stashed these changes before the version bump and restored them afterward, allowing them to commit as part of the next push cycle per grepathy's design.
