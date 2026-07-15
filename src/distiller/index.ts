import { NormalizedEvent } from "../adapters/types.js";
import { GrepathyConfig } from "../util/config.js";
import { prepareChunks } from "./inputPrep.js";
import { DISTILLER_SYSTEM, buildUserPrompt, VALIDATOR_RETRY_NOTE } from "./prompt.js";
import { LLMBackend, extractJson } from "./backends.js";
import { DistilledPack, DecisionEntry, coercePack, emptyPack, isSubstantiveIntent } from "./model.js";
import { validatePack } from "./validator.js";
import { isSameDecision } from "./similarity.js";

export interface DistillOutcome {
  ok: boolean;
  pack: DistilledPack;
  /** Populated on failure (validation give-up, no events, LLM error). */
  reason?: string;
  /** Number of chunks that failed but were skipped (partial coverage). */
  partialFailures?: number;
  /**
   * The deadline was hit before every chunk was distilled — the pack is a valid
   * PARTIAL. The caller must keep the session dirty and NOT advance its offset,
   * so a later (unbudgeted) distill re-reads the same delta and completes it.
   */
  truncated?: boolean;
}

const PER_CALL_TIMEOUT_MS = 150_000;

/** Per-call timeout, clamped so a single chunk can never run past the deadline. */
function callTimeout(deadline: number | undefined): number {
  if (deadline === undefined) return PER_CALL_TIMEOUT_MS;
  return Math.min(PER_CALL_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
}

/**
 * Distill normalized events into a validated DistilledPack. Long sessions are
 * chunked and distilled with **bounded concurrency**, results merged in
 * transcript order (so the deterministic dedupe + title-anchoring see a stable
 * input order), then run through the privacy/secret validator — re-prompting
 * once before giving up (write nothing, stay dirty).
 *
 * `opts.deadline` (epoch ms) makes this a **hard** wall-clock cap for the
 * interactive pre-push path: between chunks we stop dispatching once past it,
 * and each call's own timeout shrinks to the remaining budget so an in-flight
 * chunk can't blow through it either. Stopping early sets `truncated`. Background
 * and manual distills pass no deadline and run to completion.
 */
export async function distillEvents(
  events: NormalizedEvent[],
  cfg: GrepathyConfig,
  backend: LLMBackend,
  opts: { knownTitles?: string[]; deadline?: number } = {},
): Promise<DistillOutcome> {
  if (events.length === 0) {
    return { ok: true, pack: emptyPack() };
  }

  // Titles already on this branch's pack, so the distiller can reuse them
  // verbatim for the same decision (deterministic exact-match dedupe downstream).
  const knownTitles = opts.knownTitles ?? [];
  const deadline = opts.deadline;
  const chunks = prepareChunks(events, cfg.chunkChars);

  // Results indexed by chunk position (null = failed or not reached), so the
  // merge below is in transcript order regardless of completion order.
  const results: (DistilledPack | null)[] = new Array(chunks.length).fill(null);
  let chunkFailures = 0;
  let truncated = false;
  let cursor = 0; // next chunk to claim; `i = cursor++` is atomic on one thread

  const worker = async (): Promise<void> => {
    for (;;) {
      if (deadline !== undefined && Date.now() >= deadline) {
        if (cursor < chunks.length) truncated = true;
        return;
      }
      const i = cursor++;
      if (i >= chunks.length) return;
      const timeout = callTimeout(deadline);
      if (timeout <= 0) {
        truncated = true;
        return;
      }
      const user = buildUserPrompt(chunks[i], i, chunks.length, knownTitles);
      try {
        const raw = await backend.complete(DISTILLER_SYSTEM, user, timeout);
        results[i] = coercePack(extractJson(raw));
      } catch {
        // One slow/failed chunk must not lose the whole session (bias to recall,
        // eventually consistent). Skip it and keep the decisions from the rest.
        chunkFailures++;
      }
    }
  };

  const concurrency = Math.max(1, cfg.distiller.concurrency || 1);
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));

  const partials = results.filter((p): p is DistilledPack => p !== null); // index order preserved
  if (partials.length === 0) {
    const reason = truncated ? "deadline hit before any chunk distilled" : `all ${chunks.length} chunk(s) failed`;
    return { ok: false, pack: emptyPack(), reason, truncated: truncated || undefined };
  }

  let merged = partials.length === 1 ? partials[0] : localMerge(partials);

  // Privacy/secret post-check with a single re-prompt. Skipped if we're already
  // out of budget — better to keep the session dirty for a later unbudgeted
  // distill (which can afford the retry) than to ship an unvalidated pack.
  let validation = validatePack(merged, cfg.redaction);
  if (!validation.ok && (deadline === undefined || Date.now() < deadline)) {
    const retryUser = `${buildUserPrompt(chunks.join("\n\n"), 0, 1, knownTitles)}\n\n${VALIDATOR_RETRY_NOTE}`;
    try {
      const raw = await backend.complete(DISTILLER_SYSTEM, retryUser, callTimeout(deadline));
      merged = coercePack(extractJson(raw));
      validation = validatePack(merged, cfg.redaction);
    } catch (e: any) {
      return { ok: false, pack: emptyPack(), reason: `validator retry failed: ${e.message}`, truncated: truncated || undefined };
    }
  }

  if (!validation.ok) {
    return {
      ok: false,
      pack: emptyPack(),
      reason: `privacy/secret validation failed: ${validation.violations.join("; ")}`,
      truncated: truncated || undefined,
    };
  }

  return { ok: true, pack: merged, partialFailures: chunkFailures || undefined, truncated: truncated || undefined };
}

/**
 * Merge per-chunk packs deterministically. We deliberately do NOT use an LLM
 * merge pass here: re-distilling the merged JSON is nondeterministic, which
 * would make the same transcript produce different entries run-to-run and churn
 * the shadow-hash edit-preservation. Deterministic semantic dedupe is both
 * cheaper and idempotent.
 */
function localMerge(partials: DistilledPack[]): DistilledPack {
  const out = emptyPack();
  const intents: string[] = [];
  for (const p of partials) {
    if (p.intent) intents.push(p.intent);
    for (const d of p.decisions) {
      // Semantic dedupe: a re-worded title for the same decision collapses in.
      const idx = out.decisions.findIndex((e) => isSameDecision(e, d));
      if (idx === -1) {
        out.decisions.push(d);
      } else if (moreComplete(d, out.decisions[idx])) {
        out.decisions[idx] = d; // keep the more complete version
      }
    }
  }
  out.intent = pickIntent(intents);
  return out;
}

function moreComplete(a: DecisionEntry, b: DecisionEntry): boolean {
  const weight = (d: DecisionEntry) =>
    d.body.length + d.touches.length * 20 + (d.consideredRejected ? 30 : 0) + (d.risk ? 20 : 0);
  return weight(a) > weight(b);
}

/** Choose the first substantive chunk intent, skipping null-signal ones. */
function pickIntent(intents: string[]): string {
  const substantive = intents.find(isSubstantiveIntent);
  if (substantive) return substantive.trim();
  return intents.find((i) => i.trim())?.trim() ?? "";
}
