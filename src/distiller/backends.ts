import { spawn } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { GrepathyConfig } from "../util/config.js";

/**
 * The distiller's own `claude -p` subprocess must NOT run inside the repo:
 * otherwise its transcript lands in the repo's Claude projects dir and gets
 * re-ingested, and its session end fires the repo's grepathy hooks — an
 * infinite distill→claude→SessionEnd→distill loop. We run it in an isolated
 * throwaway cwd and set GREPATHY_DISTILLING so any inherited hook no-ops.
 */
const DISTILLER_CWD = path.join(os.tmpdir(), "grepathy-distiller");
export const DISTILLING_ENV = "GREPATHY_DISTILLING";

export interface LLMBackend {
  readonly name: string;
  /** Returns the model's raw text response. Throws on failure/timeout. */
  complete(system: string, user: string, timeoutMs: number): Promise<string>;
}

/** Alias -> concrete model id for the direct-API backend. */
const API_MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
};

/**
 * Default backend: headless Claude Code (`claude -p`). Reuses the user's
 * existing Claude Code auth — zero API-key setup for the core audience.
 */
export class ClaudePBackend implements LLMBackend {
  readonly name = "claude";
  constructor(private model: string) {}

  complete(system: string, user: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "-p",
        "--model",
        this.model,
        "--output-format",
        "text",
        "--system-prompt",
        system,
      ];
      try {
        fs.mkdirSync(DISTILLER_CWD, { recursive: true });
      } catch {
        /* fall back to inherited cwd */
      }
      const child = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: DISTILLER_CWD,
        env: { ...process.env, [DISTILLING_ENV]: "1" },
      });
      let out = "";
      let err = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`failed to spawn claude: ${e.message}`));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`claude -p exited ${code}: ${err.slice(0, 500)}`));
      });

      child.stdin.write(user);
      child.stdin.end();
    });
  }
}

/** Fallback backend: direct Anthropic API via ANTHROPIC_API_KEY. */
export class AnthropicApiBackend implements LLMBackend {
  readonly name = "api";
  private model: string;
  constructor(model: string, private apiKey: string) {
    this.model = API_MODEL_ALIASES[model] ?? model;
  }

  async complete(system: string, user: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }
      const data: any = await res.json();
      const text = (data.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function selectBackend(cfg: GrepathyConfig): LLMBackend {
  const { backend, model } = cfg.distiller;
  const key = process.env.ANTHROPIC_API_KEY;
  if (backend === "api") {
    if (!key) throw new Error("distiller.backend is 'api' but ANTHROPIC_API_KEY is not set");
    return new AnthropicApiBackend(model, key);
  }
  return new ClaudePBackend(model);
}

/** Extract the first top-level JSON object from a possibly-noisy response. */
export function extractJson(text: string): any {
  // Prefer a fenced ```json block if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      // try next candidate
    }
  }
  throw new Error("no parseable JSON in model response");
}
