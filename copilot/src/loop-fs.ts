import { mkdirSync, writeFileSync, appendFileSync } from "fs";

// ─────────────────────────────────────────────────────────────
// Durable-write helpers for directories that live under /tmp.
//
// /tmp is not durable storage: the OS tmp-cleaner, a reboot, or a manual
// sweep can remove a directory out from under a long-running process. A
// single mkdir at process start is therefore not enough — a writer that
// assumes permanence fails for the entire process lifetime once the
// directory disappears (see: session.create failing 37× in a row with
// "Directory does not exist or cannot be accessed").
//
// Extracted from copilot-core so the retry logic is testable against a
// throwaway directory instead of the real /tmp/copilot-loop.
// ─────────────────────────────────────────────────────────────

/**
 * Create `dir` (recursively) without throwing.
 * Returns `null` on success, or the Error when the directory could not be
 * created — letting the caller decide whether to log, ignore, or surface it.
 */
export const tryMkdir = (dir: string): Error | null => {
  try {
    mkdirSync(dir, { recursive: true });
    return null;
  } catch (err: any) {
    return err instanceof Error ? err : new Error(String(err));
  }
};

export interface LoopFs {
  /** Re-create the backing directory. Never throws. */
  ensureDir: () => void;
  /** Write `data` to `filePath`, recreating the directory if it vanished. */
  writeFile: (filePath: string, data: string) => void;
  /** Append `data` to `filePath`, recreating the directory if it vanished. */
  appendFile: (filePath: string, data: string) => void;
}

/**
 * Build write helpers bound to `dir` that self-heal a vanished directory.
 *
 * Only ENOENT triggers the mkdir + retry. Every other error (EACCES, ENOSPC,
 * EISDIR, ...) propagates unchanged so real failures stay visible rather than
 * being masked. The retry runs exactly once — if recreating the directory did
 * not fix it, the directory was never the problem.
 */
export const createLoopFs = (dir: string): LoopFs => {
  const ensureDir = (): void => {
    tryMkdir(dir);
  };

  const withRetry = <T>(op: () => T): T => {
    try {
      return op();
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
      ensureDir();
      return op();
    }
  };

  return {
    ensureDir,
    writeFile: (filePath: string, data: string) => withRetry(() => writeFileSync(filePath, data)),
    appendFile: (filePath: string, data: string) => withRetry(() => appendFileSync(filePath, data)),
  };
};
