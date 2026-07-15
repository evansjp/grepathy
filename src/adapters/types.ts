/**
 * The read-side is universal (markdown + grep). The write-side — turning a
 * tool's private transcript into normalized events — is per-tool. Every adapter
 * implements this interface so a Codex adapter is a small follow-up.
 */

export type NormalizedEventKind =
  | "user_text"
  | "assistant_text"
  | "thinking"
  | "tool_call_summary";

export interface NormalizedEvent {
  kind: NormalizedEventKind;
  /** Human-readable rendering of the event for the distiller. */
  text: string;
  /** For tool_call_summary: the tool name (Edit, Bash, ...). */
  tool?: string;
  /** ISO timestamp of the source line, if present. */
  timestamp?: string;
}

/** A session discovered on disk, before any distillation. */
export interface DiscoveredSession {
  sessionId: string;
  transcriptPath: string;
  /** Absolute repo path the transcript belongs to, if known. */
  repo?: string;
}

/** Metadata extracted cheaply from a transcript for state + branch matching. */
export interface TranscriptMeta {
  branches: string[];
  files: string[];
  cwd?: string;
  firstTs?: string;
  lastTs?: string;
}

export interface ReadResult {
  /** Newly-read bytes as text (from `fromOffset` to EOF). */
  raw: string;
  /** New byte offset (== file size at read time). */
  newOffset: number;
}

export interface Adapter {
  readonly tool: string;

  /** Find sessions whose transcripts belong to `repoPath`. */
  discoverSessions(repoPath: string): DiscoveredSession[];

  /** Read a transcript (optionally incrementally from a byte offset). */
  readTranscript(transcriptPath: string, fromOffset?: number): ReadResult;

  /** Turn raw transcript text into the filtered, distiller-ready events. */
  normalizeEvents(raw: string): NormalizedEvent[];

  /** Cheap metadata pass for state + branch matching. */
  extractMeta(raw: string): TranscriptMeta;
}
