import { Adapter } from "./types.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";

/**
 * v1 ships the Claude Code adapter. The Codex adapter is present but stubbed so
 * the write-side seam is proven and adding real Codex support is a small PR.
 */
export const ADAPTERS: Adapter[] = [new ClaudeCodeAdapter()];

/** Adapters registered but not yet active (kept out of discovery sweeps). */
export const STUBBED_ADAPTERS: Adapter[] = [new CodexAdapter()];

export function adapterFor(tool: string): Adapter | undefined {
  return [...ADAPTERS, ...STUBBED_ADAPTERS].find((a) => a.tool === tool);
}

export * from "./types.js";
