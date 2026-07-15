import { NormalizedEvent } from "../adapters/types.js";

const LABELS: Record<NormalizedEvent["kind"], string> = {
  user_text: "USER",
  assistant_text: "AGENT",
  thinking: "THINKING",
  tool_call_summary: "TOOL",
};

/** Render one normalized event as a labelled line for the distiller. */
function renderEvent(ev: NormalizedEvent): string {
  const label = LABELS[ev.kind];
  if (ev.kind === "tool_call_summary") {
    return `[${label}] ${ev.text}`;
  }
  return `[${label}] ${ev.text}`;
}

/**
 * Turn normalized events into one or more text chunks, each under `chunkChars`.
 * Whole events are never split across chunks. Very long single events (a giant
 * thinking block) are hard-truncated to keep the chunk bounded.
 */
export function prepareChunks(events: NormalizedEvent[], chunkChars: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;

  const flush = () => {
    if (cur.length) {
      chunks.push(cur.join("\n\n"));
      cur = [];
      curLen = 0;
    }
  };

  for (const ev of events) {
    let rendered = renderEvent(ev);
    if (rendered.length > chunkChars) {
      rendered = rendered.slice(0, chunkChars) + "…";
    }
    if (curLen + rendered.length > chunkChars && cur.length) {
      flush();
    }
    cur.push(rendered);
    curLen += rendered.length + 2;
  }
  flush();
  return chunks;
}
