import {
  Adapter,
  DiscoveredSession,
  NormalizedEvent,
  ReadResult,
  TranscriptMeta,
} from "./types.js";

/**
 * Codex adapter — stubbed for v1 to prove the seam. Codex stores rollout
 * transcripts under ~/.codex/sessions/. Implementing this is the next
 * milestone; the interface below is the whole contract a real adapter fills.
 *
 * TODO(codex):
 *  - discoverSessions: walk ~/.codex/sessions and match on the recorded cwd.
 *  - readTranscript: same byte-offset incremental read as the Claude adapter.
 *  - normalizeEvents: map Codex event records -> user_text/assistant_text/
 *    thinking/tool_call_summary, dropping full file bodies and command output.
 *  - extractMeta: pull branch (if recorded), edited file paths, timestamps.
 */
export class CodexAdapter implements Adapter {
  readonly tool = "codex";

  discoverSessions(_repoPath: string): DiscoveredSession[] {
    return []; // TODO(codex)
  }

  readTranscript(_transcriptPath: string, _fromOffset = 0): ReadResult {
    return { raw: "", newOffset: 0 }; // TODO(codex)
  }

  normalizeEvents(_raw: string): NormalizedEvent[] {
    return []; // TODO(codex)
  }

  extractMeta(_raw: string): TranscriptMeta {
    return { branches: [], files: [] }; // TODO(codex)
  }
}
