import * as path from "node:path";
import * as fs from "node:fs";
import { LLMBackend } from "../src/distiller/backends.js";
import { DistilledPack } from "../src/distiller/model.js";

export const FIXTURES = path.join(process.cwd(), "test", "fixtures");

export function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/** Deterministic backend: maps a user prompt to a canned response string. */
export class MockBackend implements LLMBackend {
  readonly name = "mock";
  public calls = 0;
  constructor(private responder: (user: string, call: number) => string) {}
  async complete(_system: string, user: string): Promise<string> {
    const r = this.responder(user, this.calls);
    this.calls++;
    return r;
  }
}

/** A backend that always returns the same pack as JSON. */
export function fixedPackBackend(pack: DistilledPack): MockBackend {
  return new MockBackend(() => JSON.stringify(pack));
}

/**
 * A backend that can delay each call and records the timeout it was handed —
 * for testing the deadline/concurrency path (truncation, in-order merge, and
 * the per-call timeout shrinking to the remaining budget).
 */
export class DelayMock implements LLMBackend {
  readonly name = "delay-mock";
  public calls = 0;
  public timeouts: number[] = [];
  constructor(private responder: (user: string, call: number) => { delayMs?: number; body: string }) {}
  async complete(_system: string, user: string, timeoutMs: number): Promise<string> {
    const call = this.calls++;
    this.timeouts.push(timeoutMs);
    const { delayMs = 0, body } = this.responder(user, call);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return body;
  }
}

/** Two events big enough that prepareChunks splits them into N chunks. */
export function chunkyEvents(n: number): { kind: "user_text"; text: string; timestamp: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "user_text" as const,
    text: `event ${i} ` + "x".repeat(80),
    timestamp: `2026-07-14T00:00:${String(i).padStart(2, "0")}Z`,
  }));
}

export const CLERK_PACK: DistilledPack = {
  intent: "Allow shared deal links to be opened by guests before full account setup.",
  decisions: [
    {
      title: "Guest identities are pre-created in Clerk",
      status: "agent-initiated",
      statusNote: "not requested in plan or prompts",
      touches: ["lib/clerk/*", "db/schema/guests.ts"],
      body: "The agent inferred this approach to simplify downstream auth checks. No explicit rationale was discussed.",
      consideredRejected: "none found in session",
      risk: "guest users diverge from the normal signup path.",
      reviewerAttention: "confirm whether guests should be modeled as normal users.",
    },
    {
      title: "JWT expiry set to 15 minutes for guest tokens",
      status: "directed",
      touches: ["lib/auth/tokens.ts"],
      body: "Short expiry chosen because guest links are shared over email and may leak.",
      consideredRejected: "24h expiry (rejected: leak risk on forwarded emails).",
    },
  ],
};
