# Privacy

**Your session transcript never leaves your machine.** Transcripts are intimate — dumb
questions, false starts, half-formed thinking, pasted context. You will not share them, and
you shouldn't have to. So Grepathy doesn't build a chat channel or a Q&A service; there's
nothing to share a conversation *in*. It distills a **digest of decisions** locally, and that
digest — privacy-filtered markdown — is the only thing that gets shared.

## What the summarizer will never write

The generation prompt is built to be constitutionally incapable of embarrassing output. It:

- **Never quotes your messages.** Not one phrase.
- **Never mentions your uncertainty, confusion, mistakes, or the back-and-forth.** Decisions
  only, third person, from the agent's perspective.
- **Never narrates the session.** No "first X was tried, then…".
- **Never includes business, financial, or commercial detail** — no revenue or pricing figures,
  funding or runway status, third-party company or person names, or deal terms. If a real code
  decision was shaped by such context, only the neutral technical constraint survives (e.g.
  "must run within a fixed monthly infra budget"), with no figure or name.
- **Strips secrets** — keys, tokens, passwords, credentials.

## Two layers, then you

The prompt is the first layer. Two deterministic backstops sit behind it, so privacy doesn't
depend on the model behaving perfectly every run:

1. **A regex scan** over the distiller's own output catches secret-shaped strings, first-person
   narrative leaks, and monetary figures. Anything it flags forces a re-generation, then fails
   closed (the pack simply isn't written) rather than shipping a leak.
2. **A structural rule:** every entry must name a real file or glob in `Touches:`. An entry that
   can't point at code isn't a code decision — it's narrative — and is dropped. (This is what
   removes business asides that read like ordinary prose.)

The **third** layer is you: you review the markdown before you push. And if you edit or delete
an entry, Grepathy respects that forever — your edits are never regenerated over.

## The honest limit

The deterministic layers catch the *hard* signals — figures, secrets, named third parties in
non-code entries. What they can't catch is money-free business *tone* (an intent phrased around
"the bootstrapped experiment" with no number and no name), because judging that reliably is the
fuzzy problem a regex can't solve without becoming brittle and wrong. That residual is exactly
why the human review-before-push gate exists and isn't optional. Grepathy never pushes on its
own — see [how it works](how-it-works.md#keeping-git-current).

This model was tested against a real, messy project's transcripts, including the one place it
originally leaked; see the [eval report](REPORT.md#what-we-fixed).
