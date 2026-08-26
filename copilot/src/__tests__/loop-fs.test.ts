import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Import the REAL implementation — no re-implementation, no mocking of the
// module under test. Only the backing directory is a throwaway, so the tests
// never touch the live /tmp/copilot-loop.
import { createLoopFs, tryMkdir } from "../loop-fs";

let dir: string;
let counter = 0;

beforeEach(() => {
  dir = join(tmpdir(), `loop-fs-test-${process.pid}-${counter++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── tryMkdir ─────────────────────────────────────────────────────────────────
describe("tryMkdir", () => {
  test("returns null when the directory is created", () => {
    expect(tryMkdir(join(dir, "fresh"))).toBeNull();
  });

  test("creates the directory on disk", () => {
    const target = join(dir, "fresh");
    tryMkdir(target);
    expect(existsSync(target)).toBe(true);
  });

  test("returns null when the directory already exists", () => {
    expect(tryMkdir(dir)).toBeNull();
  });

  test("creates missing parent directories", () => {
    const target = join(dir, "a", "b", "c");
    tryMkdir(target);
    expect(existsSync(target)).toBe(true);
  });

  test("returns an Error instead of throwing when the path is an existing file", () => {
    const filePath = join(dir, "occupied");
    writeFileSync(filePath, "x");
    expect(tryMkdir(filePath)).toBeInstanceOf(Error);
  });
});

// ─── ensureDir ────────────────────────────────────────────────────────────────
describe("createLoopFs().ensureDir", () => {
  test("recreates the directory after it is removed", () => {
    const fs = createLoopFs(dir);
    rmSync(dir, { recursive: true, force: true });
    fs.ensureDir();
    expect(existsSync(dir)).toBe(true);
  });

  test("is a no-op when the directory already exists", () => {
    const fs = createLoopFs(dir);
    fs.ensureDir();
    expect(existsSync(dir)).toBe(true);
  });

  test("never throws when the directory cannot be created", () => {
    const filePath = join(dir, "blocked");
    writeFileSync(filePath, "x");
    const fs = createLoopFs(filePath);
    expect(() => fs.ensureDir()).not.toThrow();
  });
});

// ─── writeFile ────────────────────────────────────────────────────────────────
describe("createLoopFs().writeFile", () => {
  test("writes the file when the directory exists", () => {
    const fs = createLoopFs(dir);
    const target = join(dir, "note.txt");
    fs.writeFile(target, "hello");
    expect(readFileSync(target, "utf-8")).toBe("hello");
  });

  test("overwrites existing content", () => {
    const fs = createLoopFs(dir);
    const target = join(dir, "note.txt");
    fs.writeFile(target, "first");
    fs.writeFile(target, "second");
    expect(readFileSync(target, "utf-8")).toBe("second");
  });

  // REGRESSION: the reaped-/tmp bug. Before the fix this threw ENOENT and every
  // subsequent write failed for the lifetime of the process.
  test("recreates a vanished directory and still writes the file", () => {
    const fs = createLoopFs(dir);
    const target = join(dir, "note.txt");
    rmSync(dir, { recursive: true, force: true });
    fs.writeFile(target, "recovered");
    expect(readFileSync(target, "utf-8")).toBe("recovered");
  });

  test("does not throw when the directory vanished", () => {
    const fs = createLoopFs(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(() => fs.writeFile(join(dir, "note.txt"), "x")).not.toThrow();
  });

  // Writing to a directory path yields EISDIR — a real failure, not a missing
  // directory, so it must surface untouched rather than be masked by a retry.
  test("propagates non-ENOENT errors instead of retrying", () => {
    const fs = createLoopFs(dir);
    const asDirectory = join(dir, "iam-a-dir");
    mkdirSync(asDirectory);
    expect(() => fs.writeFile(asDirectory, "x")).toThrow();
  });

  // ensureDir only recreates `dir`, never `dir/nested`, so the retry fails too.
  // This must throw rather than loop forever.
  test("retries at most once — a still-missing nested path throws", () => {
    const fs = createLoopFs(dir);
    expect(() => fs.writeFile(join(dir, "nested", "note.txt"), "x")).toThrow();
  });
});

// ─── appendFile ───────────────────────────────────────────────────────────────
describe("createLoopFs().appendFile", () => {
  test("creates the file when it does not exist yet", () => {
    const fs = createLoopFs(dir);
    const target = join(dir, "log.txt");
    fs.appendFile(target, "line1\n");
    expect(readFileSync(target, "utf-8")).toBe("line1\n");
  });

  test("appends rather than truncating", () => {
    const fs = createLoopFs(dir);
    const target = join(dir, "log.txt");
    fs.appendFile(target, "line1\n");
    fs.appendFile(target, "line2\n");
    expect(readFileSync(target, "utf-8")).toBe("line1\nline2\n");
  });

  // REGRESSION: logger.store() appends every log line — this is the path that
  // silently died once /tmp/copilot-loop was swept.
  test("recreates a vanished directory and still appends", () => {
    const fs = createLoopFs(dir);
    const target = join(dir, "log.txt");
    fs.appendFile(target, "before\n");
    rmSync(dir, { recursive: true, force: true });
    fs.appendFile(target, "after\n");
    expect(readFileSync(target, "utf-8")).toBe("after\n");
  });

  test("propagates non-ENOENT errors instead of retrying", () => {
    const fs = createLoopFs(dir);
    const asDirectory = join(dir, "iam-a-dir");
    mkdirSync(asDirectory);
    expect(() => fs.appendFile(asDirectory, "x")).toThrow();
  });
});

// ─── isolation ────────────────────────────────────────────────────────────────
describe("createLoopFs isolation", () => {
  test("each instance heals only its own directory", () => {
    const other = join(dir, "other");
    mkdirSync(other, { recursive: true });
    const fsOther = createLoopFs(other);
    rmSync(other, { recursive: true, force: true });
    fsOther.writeFile(join(other, "f.txt"), "ok");
    expect(existsSync(join(other, "f.txt"))).toBe(true);
  });
});
