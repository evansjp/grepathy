import { DistilledPack, hasFinanceFigure } from "./model.js";

export interface ValidationResult {
  ok: boolean;
  violations: string[];
}

/** Secret-shaped patterns — belt-and-braces over the prompt's instruction. */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic/openai key", re: /\bsk-[a-zA-Z0-9_-]{16,}\b/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[posru]_[A-Za-z0-9]{20,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "private key header", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/ },
  {
    name: "inline credential assignment",
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"][^'"]{6,}['"]/i,
  },
];

/** Session-narrative / privacy-leak markers the digest must never contain. */
const PRIVACY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "reference to the user", re: /\bthe user (?:was|said|asked|wanted|felt|got|kept|seemed|initially|then|later|clarified|corrected|mentioned|noted)\b/i },
  { name: "user uncertainty/confusion", re: /\buser(?:'s)? (?:confusion|uncertainty|frustration|mistake|question|tone|struggle)\b/i },
  { name: "second-person address", re: /\byou (?:said|asked|wanted|mentioned|were unsure|seemed|clarified)\b/i },
  { name: "chronological narration", re: /\b(?:first|then|after that|next),? (?:the user|they|we) (?:tried|asked|said|wanted)\b/i },
  { name: "meta-conversation", re: /\bafter (?:several|multiple|many) (?:attempts|tries|messages)\b/i },
  { name: "quoted-prompt marker", re: /\bas (?:you|the user) (?:put it|said|requested)\b/i },
];

/**
 * Validate the distilled pack's text. Runs over all human-readable fields.
 * `extraRedaction` are user-supplied source regexes from config; any match is a
 * violation (they are custom "never leak this" patterns).
 */
export function validatePack(pack: DistilledPack, extraRedaction: string[] = []): ValidationResult {
  const violations: string[] = [];
  const text = packText(pack);

  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) violations.push(`secret pattern: ${name}`);
  }
  for (const { name, re } of PRIVACY_PATTERNS) {
    if (re.test(text)) violations.push(`privacy: ${name}`);
  }
  // Monetary figures anywhere in the pack are a business/financial leak (coercePack
  // already blanks a money-laden intent; this catches decision bodies too). Fails
  // closed: retry once, then write nothing — a privacy leak must not ship.
  if (hasFinanceFigure(text)) violations.push("finance: monetary figure");
  for (const src of extraRedaction) {
    try {
      if (new RegExp(src, "i").test(text)) violations.push(`custom redaction: /${src}/`);
    } catch {
      // ignore invalid user regex
    }
  }

  return { ok: violations.length === 0, violations };
}

function packText(pack: DistilledPack): string {
  const parts = [pack.intent];
  for (const d of pack.decisions) {
    parts.push(d.title, d.statusNote ?? "", d.body, d.consideredRejected ?? "", d.risk ?? "", d.reviewerAttention ?? "");
  }
  return parts.join("\n");
}
