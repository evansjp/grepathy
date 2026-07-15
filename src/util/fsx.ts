import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** Atomic write via temp file + rename (POSIX-atomic on same filesystem). */
export function writeFileAtomic(file: string, contents: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Stable short content hash used for shadow-entry change detection. */
export function contentHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/**
 * Try to acquire an exclusive lockfile. Returns a release function, or null if
 * another holder is alive. A lock older than `staleMs` is treated as abandoned
 * (a distiller that crashed) and reclaimed. Best-effort: if the lock dir can't
 * be created we return a no-op release so the caller proceeds rather than stalls.
 */
export function acquireLock(lockPath: string, staleMs = 300_000): (() => void) | null {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    return () => {}; // can't lock; let the caller proceed unguarded
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx"); // exclusive create; fails if exists
      fs.writeFileSync(fd, `${process.pid} ${Date.now()}`);
      fs.closeSync(fd);
      return () => {
        try {
          fs.rmSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") return () => {}; // unexpected FS error; proceed unguarded
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.rmSync(lockPath); // reclaim a stale lock, then retry once
          continue;
        }
      } catch {
        /* lock vanished between check and stat; retry */
        continue;
      }
      return null; // held by a live process
    }
  }
  return null;
}
