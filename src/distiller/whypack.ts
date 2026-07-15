import { DecisionEntry, DistilledPack, isSubstantiveIntent } from "./model.js";
import { ShadowPack, ShadowEntry, entryId } from "../state/entries.js";
import { contentHash } from "../util/fsx.js";
import { DecisionLike, isSameDecision, matchScore } from "./similarity.js";

/**
 * A why-pack entry in a shape shared by "freshly generated" and "parsed from
 * disk" entries, so edit-detection compares like with like.
 */
export interface PackEntry {
  title: string;
  /** Full status line value, e.g. "agent-initiated — not requested in plan". */
  status: string;
  touches: string[];
  /** Rationale plus any Considered/Risk/Reviewer lines, as one text body. */
  body: string;
}

export interface ParsedPack {
  slug: string;
  intent: string;
  entries: PackEntry[];
}

const HEADER_COMMENT = (date: string) =>
  `<!-- grepathy:v1 generated ${date} — review before sharing; edit freely, edits are preserved -->`;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function decisionToPackEntry(d: DecisionEntry): PackEntry {
  const status = d.statusNote ? `${d.status} — ${d.statusNote}` : d.status;
  const extra: string[] = [];
  if (d.consideredRejected) extra.push(`Considered/rejected: ${d.consideredRejected}`);
  if (d.risk) extra.push(`Risk: ${d.risk}`);
  if (d.reviewerAttention) extra.push(`Reviewer attention: ${d.reviewerAttention}`);
  const body = extra.length ? `${d.body.trim()}\n\n${extra.join("\n")}` : d.body.trim();
  return { title: d.title.trim(), status, touches: d.touches, body };
}

function renderTouches(touches: string[]): string {
  if (!touches.length) return "Touches: (unspecified)";
  return "Touches: " + touches.map((t) => `\`${t}\``).join(", ");
}

export function renderEntry(e: PackEntry): string {
  const lines = [`### ${e.title}`, `Status: ${e.status}`, renderTouches(e.touches), "", e.body.trim()];
  return lines.join("\n").trimEnd();
}

export function renderPack(pack: ParsedPack, date: string): string {
  const parts = [
    `# Why: ${pack.slug}`,
    "",
    HEADER_COMMENT(date),
    "",
    "## Intent",
    pack.intent.trim() || "_No intent recorded yet._",
    "",
    "## Decisions",
  ];
  if (pack.entries.length === 0) {
    parts.push("", "_No decisions recorded yet._");
  } else {
    for (const e of pack.entries) {
      parts.push("", renderEntry(e));
    }
  }
  return parts.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Parsing (round-trips what renderPack writes; tolerant of human edits)
// ---------------------------------------------------------------------------

export function parsePack(slug: string, markdown: string): ParsedPack {
  const intent = extractSection(markdown, "Intent");
  const decisionsSection = extractSection(markdown, "Decisions");
  const entries = parseEntries(decisionsSection);
  return {
    slug,
    intent: intent === "_No intent recorded yet._" ? "" : intent.trim(),
    entries,
  };
}

/** Text of a `## <name>` section up to the next `## ` heading (or EOF). */
function extractSection(markdown: string, name: string): string {
  const re = new RegExp(`^##\\s+${name}\\s*$`, "m");
  const m = re.exec(markdown);
  if (!m) return "";
  const start = m.index + m[0].length;
  const rest = markdown.slice(start);
  const next = /^##\s+/m.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  return body.trim();
}

function parseEntries(section: string): PackEntry[] {
  if (!section) return [];
  const chunks = section
    .split(/^###\s+/m)
    .map((c) => c.trim())
    .filter(Boolean);
  const entries: PackEntry[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const title = lines[0].trim();
    if (!title || title.startsWith("_No decisions")) continue;
    let status = "";
    const touches: string[] = [];
    let bodyStart = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const s = line.trim();
      if (/^Status:/i.test(s)) {
        status = s.replace(/^Status:\s*/i, "").trim();
        bodyStart = i + 1;
      } else if (/^Touches:/i.test(s)) {
        touches.push(...parseTouches(s));
        bodyStart = i + 1;
      } else if (s === "") {
        bodyStart = i + 1;
      } else {
        break; // first non-empty, non-meta line begins the body
      }
    }
    const body = lines.slice(bodyStart).join("\n").trim();
    entries.push({ title, status: status || "agent-initiated", touches, body });
  }
  return entries;
}

function parseTouches(line: string): string[] {
  const value = line.replace(/^Touches:\s*/i, "").trim();
  if (!value || value === "(unspecified)") return [];
  const backticked = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  if (backticked.length) return backticked;
  return value
    .split(",")
    .map((t) => t.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Canonical hashing (whitespace-insensitive; detects semantic edits)
// ---------------------------------------------------------------------------

function normalizeBody(body: string): string {
  return body
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function entryHash(e: PackEntry): string {
  return contentHash(
    JSON.stringify([e.title.trim(), e.status.trim(), e.touches.map((t) => t.trim()), normalizeBody(e.body)]),
  );
}

export function intentHash(intent: string): string {
  return contentHash(normalizeBody(intent));
}

// ---------------------------------------------------------------------------
// Merge (§4): dedupe + human-edit preservation via the shadow record
// ---------------------------------------------------------------------------

export interface MergeResult {
  pack: ParsedPack;
  shadow: ShadowPack;
  addedTitles: string[];
  updatedTitles: string[];
}

/**
 * Merge freshly distilled decisions into the existing (possibly human-edited)
 * why-pack. Human edits and deletions are respected forever via `shadow`.
 */
export function mergePack(
  slug: string,
  existing: ParsedPack | null,
  shadow: ShadowPack | undefined,
  fresh: DistilledPack,
): MergeResult {
  const prevShadow: ShadowPack = shadow ?? { intentHash: "", entries: {} };
  const existingEntries = existing?.entries ?? [];

  // Classify each existing entry: does it still match what we last generated?
  const humanOwned = new Set<number>(); // indices the human created or edited — never overwrite
  const existingById = new Map<string, PackEntry>();
  existingEntries.forEach((e, i) => {
    const id = entryId(e.title);
    existingById.set(id, e);
    const sh = prevShadow.entries[id];
    if (!(sh && sh.generatedHash === entryHash(e))) {
      humanOwned.add(i); // edited, or authored by a human, or shadow missing
    }
  });

  // Human deletions: decisions in the shadow that are no longer on disk. A fresh
  // re-distillation of one of these must be suppressed, not resurrected — matched
  // semantically so a re-worded title still counts as the same deleted decision.
  const suppressedDecisions: DecisionLike[] = [];
  for (const [id, sh] of Object.entries(prevShadow.entries)) {
    if (!existingById.has(id)) suppressedDecisions.push({ title: sh.title, touches: sh.touches });
  }

  // Assign each fresh decision to at most one existing entry (semantic match),
  // else to a suppressed decision (drop), else it's genuinely new.
  type Target = { kind: "existing"; index: number } | { kind: "suppressed" } | { kind: "new" };
  const consumedExisting = new Set<number>();
  const freshTargets: Target[] = fresh.decisions.map((d) => {
    let best = -1;
    let bestScore = 0;
    existingEntries.forEach((e, i) => {
      if (consumedExisting.has(i)) return;
      if (!isSameDecision(d, e)) return;
      const s = matchScore(d, e);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    if (best >= 0) {
      consumedExisting.add(best);
      return { kind: "existing", index: best };
    }
    if (suppressedDecisions.some((sd) => isSameDecision(d, sd))) return { kind: "suppressed" };
    return { kind: "new" };
  });

  const refreshByIndex = new Map<number, number>(); // existing index -> fresh index
  freshTargets.forEach((t, fi) => {
    if (t.kind === "existing") refreshByIndex.set(t.index, fi);
  });

  // Build result order: keep existing entries in place, refresh generated ones.
  const resultEntries: PackEntry[] = [];
  const newShadowEntries: Record<string, ShadowEntry> = {};
  const addedTitles: string[] = [];
  const updatedTitles: string[] = [];

  existingEntries.forEach((e, i) => {
    const id = entryId(e.title);
    if (humanOwned.has(i)) {
      // Preserve exactly. Keep its prior shadow so it stays human-owned. A
      // materially-changed re-distill is appended below, never overwritten here.
      resultEntries.push(e);
      if (prevShadow.entries[id]) newShadowEntries[id] = prevShadow.entries[id];
      return;
    }
    const fi = refreshByIndex.get(i);
    if (fi !== undefined) {
      const refreshed = decisionToPackEntry(fresh.decisions[fi]);
      resultEntries.push(refreshed);
      newShadowEntries[entryId(refreshed.title)] = shadowFor(refreshed);
      if (entryHash(refreshed) !== entryHash(e)) updatedTitles.push(refreshed.title);
    } else {
      // Generated entry not re-distilled this run — keep as-is.
      resultEntries.push(e);
      newShadowEntries[id] = shadowFor(e);
    }
  });

  // Append genuinely-new decisions and material updates to human-owned entries.
  fresh.decisions.forEach((d, fi) => {
    const t = freshTargets[fi];
    if (t.kind === "suppressed") return;
    const entry = decisionToPackEntry(d);

    if (t.kind === "existing") {
      const e = existingEntries[t.index];
      if (!humanOwned.has(t.index)) return; // generated entry already refreshed above
      // The human owns this decision's entry. Only append a fresh note if the
      // underlying decision materially changed vs what we last generated.
      const prior = prevShadow.entries[entryId(e.title)];
      if (prior && prior.generatedHash !== entryHash(entry)) {
        const updated: PackEntry = { ...entry, title: `${entry.title} (updated)` };
        resultEntries.push(updated);
        newShadowEntries[entryId(updated.title)] = shadowFor(updated);
        addedTitles.push(updated.title);
      }
      return;
    }

    resultEntries.push(entry);
    newShadowEntries[entryId(entry.title)] = shadowFor(entry);
    addedTitles.push(entry.title);
  });

  // Intent: keep human-edited intent; otherwise adopt the fresh one.
  const existingIntent = existing?.intent ?? "";
  const intentIsHuman =
    existingIntent !== "" && prevShadow.intentHash !== "" && prevShadow.intentHash !== intentHash(existingIntent);
  let finalIntent: string;
  let finalIntentHash: string;
  if (intentIsHuman) {
    finalIntent = existingIntent;
    finalIntentHash = prevShadow.intentHash; // keep so it stays human-owned
  } else {
    finalIntent = chooseIntent(fresh.intent, existingIntent);
    finalIntentHash = intentHash(finalIntent);
  }

  return {
    pack: { slug, intent: finalIntent, entries: resultEntries },
    shadow: { intentHash: finalIntentHash, entries: newShadowEntries },
    addedTitles,
    updatedTitles,
  };
}

function shadowFor(e: PackEntry): ShadowEntry {
  return { title: e.title, status: e.status, touches: e.touches, generatedHash: entryHash(e) };
}

/**
 * Choose the intent. A good existing intent is STICKY: an incremental
 * re-distill only sees the latest delta of the session, so it must not be
 * allowed to narrow a broad intent to whatever the recent chunk was about.
 * A fresh intent only wins when there is no substantive existing one (e.g. a
 * first distill, or a clean-slate full re-distill where existing is empty). If
 * neither is substantive, emit nothing — a false "no decisions" line above a
 * pack full of decisions is worse than the placeholder.
 */
function chooseIntent(fresh: string, existing: string): string {
  if (isSubstantiveIntent(existing)) return existing.trim();
  if (isSubstantiveIntent(fresh)) return fresh.trim();
  return "";
}
