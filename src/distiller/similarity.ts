/**
 * Semantic-ish matching for decisions. The LLM re-phrases a decision's title
 * between runs ("Use claude -p backend with API fallback" vs "Use claude -p as
 * default; API as fallback"), so exact-title dedupe leaks duplicates. We match
 * on title-token overlap plus the files a decision touches — deterministic,
 * zero-dependency, and deliberately CONSERVATIVE: it would rather keep two
 * distinct entries than merge two different decisions into one.
 */

export interface DecisionLike {
  title: string;
  touches: string[];
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function normPath(p: string): string {
  return p.trim().replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

/** Fraction of the smaller touch-set that is shared (0..1). */
function touchOverlap(a: string[], b: string[]): number {
  const sa = new Set(a.map(normPath));
  const sb = new Set(b.map(normPath));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / Math.min(sa.size, sb.size);
}

export function titleSimilarity(a: string, b: string): number {
  return jaccard(tokenize(a), tokenize(b));
}

/** Ranking score for choosing the best match among candidates. */
export function matchScore(a: DecisionLike, b: DecisionLike): number {
  return titleSimilarity(a.title, b.title) + 0.3 * touchOverlap(a.touches, b.touches);
}

/**
 * Whether two decisions describe the same underlying decision. Either the
 * titles are strongly similar on their own, or they're moderately similar AND
 * touch overlapping files. Thresholds are intentionally high to avoid merging
 * genuinely distinct decisions.
 */
export function isSameDecision(a: DecisionLike, b: DecisionLike): boolean {
  const t = titleSimilarity(a.title, b.title);
  if (t >= 0.6) return true;
  return t >= 0.4 && touchOverlap(a.touches, b.touches) >= 0.5;
}
