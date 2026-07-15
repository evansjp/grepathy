import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRuntime, isInitialized } from "../util/runtime.js";
import { GrepathyPaths } from "../util/paths.js";
import { parsePack, renderEntry } from "../distiller/whypack.js";
import { say, warn } from "../util/log.js";

/**
 * Collect the why-pack entries (across every branch's pack) whose Touches globs
 * match `query`, formatted for display. Returns "" if nothing matches. Shared by
 * the `context` command and the PreToolUse edit-time injection hook — pure local
 * matching, no git, no LLM, so it's safe on the edit hot path. Duplicate entries
 * (same decision recorded on multiple branches) are shown once.
 */
export function collectContext(paths: GrepathyPaths, repoRoot: string, query: string): string {
  const target = normalize(query, repoRoot);
  let packs: string[] = [];
  try {
    packs = fs.readdirSync(paths.whyDir).filter((f) => f.endsWith(".md"));
  } catch {
    return "";
  }

  const seenTitles = new Set<string>();
  const out: string[] = [];
  for (const file of packs) {
    const slug = file.replace(/\.md$/, "");
    let pack;
    try {
      pack = parsePack(slug, fs.readFileSync(path.join(paths.whyDir, file), "utf8"));
    } catch {
      continue;
    }
    const matching = pack.entries.filter(
      (e) => e.touches.some((t) => touchMatches(t, target)) && !seenTitles.has(e.title),
    );
    if (matching.length === 0) continue;
    const section: string[] = [`# ${file}  (${pack.slug})`];
    for (const e of matching) {
      seenTitles.add(e.title);
      section.push("", renderEntry(e));
    }
    out.push(section.join("\n"));
  }
  return out.join("\n\n");
}

/**
 * `grepathy context <file-or-path>` — the read side for humans and scripts.
 * Prints every why-pack entry whose Touches globs match the given path.
 */
export function context(query: string): number {
  const rt = resolveRuntime();
  if (!rt) {
    warn("not inside a git repository.");
    return 1;
  }
  if (!isInitialized(rt.paths)) {
    warn("not initialized here. Run `grepathy init`.");
    return 1;
  }

  const text = collectContext(rt.paths, rt.repoRoot, query);
  if (text) say(text);
  else say(`grepathy: no why-pack entries touch '${query}'.`);
  return 0;
}

/** Make the query repo-relative and POSIX. */
function normalize(query: string, repoRoot: string): string {
  let p = query;
  if (path.isAbsolute(p)) p = path.relative(repoRoot, p);
  return p.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** True if a Touches glob covers the target path (either direction). */
export function touchMatches(glob: string, target: string): boolean {
  const g = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  if (g === target) return true;
  if (globToRegex(g).test(target)) return true;
  // Directory-ish match: the glob's static prefix is an ancestor of target,
  // or target is an ancestor of the glob (e.g. `context src/auth`).
  const prefix = staticPrefix(g);
  if (prefix && (target === prefix || target.startsWith(prefix + "/") || prefix.startsWith(target + "/"))) {
    return true;
  }
  return false;
}

/**
 * The directory-matchable prefix of a glob. For a glob WITH a wildcard, it's the
 * static directory before the wildcard (`src/auth/*` → `src/auth`). For a
 * wildcard-FREE path it's the whole path — NOT its parent — so `src/config.ts`
 * matches only itself or a query that's an ancestor directory (`src`), never a
 * sibling like `src/other.ts`.
 */
function staticPrefix(glob: string): string {
  const idx = glob.search(/[*?]/);
  if (idx === -1) return glob;
  const head = glob.slice(0, idx);
  const slash = head.lastIndexOf("/");
  return slash === -1 ? "" : head.slice(0, slash);
}

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // consume trailing slash of **/
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
