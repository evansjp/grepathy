import * as fs from "node:fs";

/** True if a controlling terminal is reachable (we can prompt the human). */
export function ttyAvailable(): boolean {
  try {
    const fd = fs.openSync("/dev/tty", "r");
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** True when we must not prompt: CI, an explicit opt-out, or no terminal. */
export function isNonInteractive(): boolean {
  if (process.env.GREPATHY_NONINTERACTIVE === "1") return true;
  const ciVars = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "JENKINS_URL", "TF_BUILD"];
  if (ciVars.some((v) => process.env[v])) return true;
  return !ttyAvailable();
}

/** Block until the user presses Enter at the controlling terminal. */
export function waitForEnter(message: string): void {
  try {
    const fd = fs.openSync("/dev/tty", "r");
    process.stderr.write(message);
    const buf = Buffer.alloc(1);
    // Blocks until a newline. Ctrl-C sends SIGINT to the group -> git aborts.
    while (fs.readSync(fd, buf, 0, 1, null) > 0) {
      if (buf.toString("utf8") === "\n") break;
    }
    fs.closeSync(fd);
  } catch {
    /* no tty -> treat as continue */
  }
}

/**
 * Ask a yes/no question at the controlling terminal. Default is No: an empty
 * line, EOF, or an unreadable tty all mean "no", so this never runs a slow job
 * on a stray keystroke. Only an explicit y/yes returns true.
 */
export function promptYesNo(message: string): boolean {
  try {
    const fd = fs.openSync("/dev/tty", "r");
    process.stderr.write(message);
    const bytes: number[] = [];
    const buf = Buffer.alloc(1);
    while (fs.readSync(fd, buf, 0, 1, null) > 0) {
      if (buf[0] === 0x0a) break; // newline
      bytes.push(buf[0]);
    }
    fs.closeSync(fd);
    const answer = Buffer.from(bytes).toString("utf8").trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  }
}
