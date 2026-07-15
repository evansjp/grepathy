/** The distilled data model. The LLM returns JSON in this shape; markdown is
 * rendered deterministically so merge/dedupe/edit-preservation stays reliable. */

export type EntryStatus = "directed" | "discussed" | "agent-initiated";

export const ENTRY_STATUSES: EntryStatus[] = ["directed", "discussed", "agent-initiated"];

export interface DecisionEntry {
  /** Imperative, specific heading of the decision (e.g. "Cache the config loader"). */
  title: string;
  status: EntryStatus;
  /** Short qualifier after the status, e.g. "not requested in plan or prompts". */
  statusNote?: string;
  /** Paths/globs the decision touches (for grep + `grepathy context`). */
  touches: string[];
  /** 1–5 sentence rationale (third person, agent's perspective). */
  body: string;
  /** Alternatives weighed, if any were found in the session. */
  consideredRejected?: string;
  /** Risk this decision introduces, if warranted. */
  risk?: string;
  /** What a reviewer should confirm, if warranted. */
  reviewerAttention?: string;
}

export interface DistilledPack {
  /** One or two sentences on what this branch of work is for. */
  intent: string;
  decisions: DecisionEntry[];
}

export function emptyPack(): DistilledPack {
  return { intent: "", decisions: [] };
}

/**
 * Whether a chunk produced a usable intent. The distiller prompt is instructed
 * to return an empty string when a chunk establishes no clear intent (so this
 * is just "non-empty"), plus one general safety net: an intent that opens with
 * a negation ("No … / Nothing … / Not …") is a non-answer, not a real intent.
 * We deliberately do NOT pattern-match specific wordings — that never
 * generalizes; the contract lives in the prompt.
 */
const NON_ANSWER_PREFIX = /^\s*(?:no|none|nothing|not|n\/a)\s/i;

export function isSubstantiveIntent(s: string | undefined): boolean {
  const t = (s ?? "").trim();
  if (t.length === 0) return false;
  if (NON_ANSWER_PREFIX.test(t)) return false;
  return true;
}

/**
 * Unambiguous monetary-figure surface forms ($42, $1k, $2,500, "12/mo",
 * "500 USD"). Currency is the HARD, high-harm slice of the business-narrative
 * leak class: unlike business "tone" (which needs the prompt's judgment), a
 * money FIGURE has a bounded, well-defined shape — so it earns a deterministic
 * backstop, the same kind as the secret regexes, NOT an open-ended word list.
 * Verified to skip technical numerics (512x512, 11:59, port 3000, #fffa70, $1).
 */
const FINANCE_FIGURE_RE =
  /\$\s?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?[kKmMbB]\b|\d{2,}(?:\.\d+)?\b|\d\.\d+\b)|\b\d[\d,]*(?:\.\d+)?\s?[kKmM]?\s?(?:usd|dollars?|per\s+(?:month|year))\b|\b\d[\d,]*(?:\.\d+)?\s?[kKmM]?\/(?:mo|yr)\b/i;

/** Whether text contains a monetary figure (the deterministic finance backstop). */
export function hasFinanceFigure(s: string): boolean {
  return FINANCE_FIGURE_RE.test(s);
}

export function coerceStatus(s: unknown): EntryStatus {
  const v = String(s ?? "").toLowerCase();
  if (v.includes("direct")) return "directed";
  if (v.includes("agent")) return "agent-initiated";
  // Bias INVERTED (was: default agent-initiated). "agent-initiated" is the
  // loud, high-value review signal, so it must be earned — emitted only when the
  // distiller affirmatively says so. Anything unclear defaults to "discussed",
  // the low-alarm status, so the flag doesn't cry wolf and train reviewers to
  // ignore it.
  return "discussed";
}

/** Defensively coerce arbitrary LLM JSON into a DistilledPack. */
export function coercePack(raw: any): DistilledPack {
  const pack = emptyPack();
  if (!raw || typeof raw !== "object") return pack;
  if (typeof raw.intent === "string") {
    const intent = raw.intent.trim();
    // The intent is the one free-text field with no `touches` invariant to lean
    // on, so it's the residual leak vector for business/financial context. If it
    // carries a money figure, blank it whole (empty intent is valid) — the
    // deterministic backstop the prompt alone can't guarantee.
    pack.intent = hasFinanceFigure(intent) ? "" : intent;
  }
  const decisions = Array.isArray(raw.decisions) ? raw.decisions : [];
  for (const d of decisions) {
    if (!d || typeof d !== "object") continue;
    const title = String(d.title ?? "").trim();
    const body = String(d.body ?? "").trim();
    if (!title || !body) continue;
    const touches = Array.isArray(d.touches)
      ? d.touches.map((t: unknown) => String(t).trim()).filter(Boolean)
      : [];
    // Structural privacy guard: a real CODE decision names the file(s) or glob(s)
    // it affects. An entry with no concrete `touches` is not a code decision —
    // it's narrative (business context, negotiation, third-party talk) that slips
    // every text filter because it reads as ordinary third-person prose. Reject
    // it rather than render "Touches: (unspecified)". This is the fix for the
    // business-narrative leak class found in the eval.
    if (touches.length === 0) continue;
    pack.decisions.push({
      title,
      status: coerceStatus(d.status),
      statusNote: d.statusNote ? String(d.statusNote).trim() : undefined,
      touches,
      body,
      consideredRejected: d.consideredRejected ? String(d.consideredRejected).trim() : undefined,
      risk: d.risk ? String(d.risk).trim() : undefined,
      reviewerAttention: d.reviewerAttention ? String(d.reviewerAttention).trim() : undefined,
    });
  }
  return pack;
}
