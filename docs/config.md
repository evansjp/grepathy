# Configuration

`.grepathy.json` lives at the repo root and is committed (team-shared):

```json
{
  "distiller": { "backend": "claude", "model": "haiku", "concurrency": 3 },
  "redaction": ["INTERNAL_CODENAME"],
  "timeBudgetMs": 60000,
  "sync": "auto",
  "autoDistill": { "enabled": true, "minIntervalMs": 180000, "minGrowthBytes": 15360 }
}
```

| key | what it does |
|---|---|
| `distiller.backend` | `"claude"` (default) runs headless Claude Code (`claude -p`), reusing your existing auth — **zero API-key setup**. `"api"` uses `ANTHROPIC_API_KEY` directly, which also isolates distillation cost from your interactive Claude Code usage. |
| `distiller.model` | Model alias for the CLI (`haiku` default) or model id for the API backend. |
| `distiller.concurrency` | How many transcript chunks distill at once (default `3`). A big session is many chunks; concurrency is what keeps it inside the pre-push budget. The `claude` backend spawns a subprocess per call, so 3 is a safe default — heavy users on `backend: "api"` (plain HTTP) can raise it. |
| `redaction` | Extra "never leak this" regexes, layered on top of the built-in secret/privacy/finance checks. |
| `timeBudgetMs` | **Hard** wall-clock cap on the pre-push sweep. It's enforced between *and within* sessions (each model call's own timeout shrinks to the remaining budget), so one big session can't make a push hang. Work that doesn't fit is deferred with a message, never blocks the push, and is finished by the next background distill, `grepathy sync`, or your next push. |
| `sync` | `"auto"` (default) commits the why-pack at settle points; `"manual"` never commits — you use `grepathy sync` and the loud freshness status instead. See [keeping git current](how-it-works.md#keeping-git-current). |
| `autoDistill` | Tunes the debounced background distill on the `Stop` hook. Set `enabled: false` to only distill at session end and push. `minIntervalMs` and `minGrowthBytes` are the time/size thresholds before a background distill fires. |

Cranking up `autoDistill` (more frequent background distills) pairs well with
`"backend": "api"`, so the extra distillation doesn't draw down your interactive Claude Code
budget.
