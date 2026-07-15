# Contributing

Thanks for helping out. The bar for a change is simple: **`npm test` stays green, and new
behavior comes with a test.**

## Setup

```bash
npm install
npm run build      # tsc -> dist/
npm test           # builds dist-test/ (pretest), runs the node:test suite
```

Requirements: **Node >= 20** and **git** on your PATH. Nothing else — zero runtime
dependencies, and the only devDependencies are TypeScript and `@types/node`.

## The tests are hermetic — they run anywhere

You do **not** need Claude, an API key, a network connection, or any of your own Claude
sessions to run the suite. Specifically:

- The LLM is always a **mock backend** (`test/helpers.ts`) that returns canned JSON — no
  `claude -p`, no `ANTHROPIC_API_KEY`, no network.
- Tests that need a git repo create a **throwaway temp repo** and set their own
  `user.email`/`user.name` locally, so they don't touch or depend on your global git identity.
- Fixtures (`test/fixtures/*.jsonl`) are committed, so parsing tests are deterministic.
- No test reads your real `~/.claude` transcripts or any absolute machine path.

CI (`.github/workflows/ci.yml`) runs the same `npm test` on Node 20 and 22 (Linux) plus
Windows, so a change that only passes on your setup will be caught.

## Layout

- `src/` — the tool. Adapters in `src/adapters/`, the distiller in `src/distiller/`, git
  plumbing in `src/core/` and `src/util/`, commands in `src/commands/`.
- `test/` — one `*.test.ts` per area, plus `helpers.ts` and `fixtures/`.
- `docs/` — architecture, format, privacy, config (start with `docs/how-it-works.md`).

Adding support for another agent tool (e.g. Codex) is the most-wanted contribution: the
write-side adapter interface (`src/adapters/types.ts`) and the read-side pointer/hook pattern
are both per-tool seams over a universal markdown format, so it's an additive change.

## A note on the `grepathy: update why-pack` commits

This repo dogfoods itself, so its own git hooks may auto-commit `.ai/why/main.md` in a separate
commit titled `grepathy: update why-pack (main)`. Those are tool-authored and safe to rebase
past or drop — don't amend them into your feature commits, and don't hand-edit `.ai/why/`
unless that's the point of your change.
