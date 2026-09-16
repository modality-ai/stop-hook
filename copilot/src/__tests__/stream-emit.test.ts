import { describe, test, expect } from "bun:test";
import { TextEmitter, PendingWrites, drainWithGrace } from "../stream-emit";

// ─────────────────────────────────────────────────────────────
// TextEmitter — incremental emission + the final remainder.
//
// The regression this pins: the remainder must be measured against the text
// ACTUALLY emitted, not a raw char offset. `content` at turn end has been
// through three rewriting passes that can change its length, so a raw offset
// indexes the wrong string — dropping real text when the transforms shorten it,
// re-sending already-streamed text when they lengthen it.
// ─────────────────────────────────────────────────────────────
describe("TextEmitter — incremental flush", () => {
  test("the first flush emits from the start of the text", () => {
    const emitter = new TextEmitter();
    expect(emitter.flush("hello world", 5)).toBe("hello");
  });

  test("flush returns null when nothing new is available", () => {
    const emitter = new TextEmitter();
    emitter.flush("hello", 5);
    expect(emitter.flush("hello", 5)).toBeNull();
  });

  test("flush rejects an end at or before the cursor", () => {
    const emitter = new TextEmitter();
    emitter.flush("hello", 5);
    expect(emitter.flush("hello", 3)).toBeNull();
  });

  test("a later flush continues from the cursor", () => {
    const emitter = new TextEmitter();
    emitter.flush("hello world", 5);
    expect(emitter.flush("hello world", 11)).toBe(" world");
  });

  test("the raw char cursor advances with each flush", () => {
    const emitter = new TextEmitter();
    emitter.flush("hello world", 5);
    expect(emitter.emittedChars).toBe(5);
    emitter.flush("hello world", 11);
    expect(emitter.emittedChars).toBe(11);
  });

  test("emittedText accumulates the exact slices sent", () => {
    const emitter = new TextEmitter();
    emitter.flush("hello world", 5);
    emitter.flush("hello world", 11);
    expect(emitter.emittedText).toBe("hello world");
  });
});

describe("TextEmitter — turn-end remainder", () => {
  test("nothing emitted yet means the whole content is the remainder", () => {
    const emitter = new TextEmitter();
    expect(emitter.remainder("final answer")).toBe("final answer");
  });

  test("streamed text that is a prefix of content yields only the tail", () => {
    const emitter = new TextEmitter();
    emitter.flush("the final ", 10);
    expect(emitter.remainder("the final answer")).toBe("answer");
  });

  test("fully streamed content yields an empty remainder", () => {
    const emitter = new TextEmitter();
    emitter.flush("the final answer", 16);
    expect(emitter.remainder("the final answer")).toBe("");
  });

  // REGRESSION (shortened): the transforms shrank content, so a raw char offset
  // would slice PAST the end and re-send text that is already on the wire.
  test("content rewritten shorter than the streamed text yields nothing", () => {
    const emitter = new TextEmitter();
    emitter.flush("hello world", 11);
    expect(emitter.remainder("hello")).toBe("");
  });

  // REGRESSION (lengthened/rewritten): the transforms rewrote text already on
  // the wire (content no longer starts with what was streamed), so sending the
  // tail would duplicate — send nothing more.
  test("content rewritten so streamed text is no longer a prefix yields nothing", () => {
    const emitter = new TextEmitter();
    emitter.flush("hello world", 11);
    expect(emitter.remainder("[tool] hello world [end]")).toBe("");
  });

  test("a rewritten start that keeps the streamed text a prefix still sends the tail", () => {
    const emitter = new TextEmitter();
    emitter.flush("hello ", 6);
    expect(emitter.remainder("hello world")).toBe("world");
  });
});

// ─────────────────────────────────────────────────────────────
// PendingWrites — the drain-before-close write queue.
//
// The regression this pins: discarding write promises caused early termination.
// When the TransformStream queue fills, write() resolves only once the consumer
// drains, so a stream closed over undrained writes loses its final finish_reason
// and [DONE] frames — the client sees a stream that "just stopped".
// ─────────────────────────────────────────────────────────────
describe("PendingWrites — drain semantics", () => {
  test("push retains a write for drainage", () => {
    const pending = new PendingWrites();
    pending.push(Promise.resolve());
    expect(pending.length).toBe(1);
  });

  test("drain resolves once every issued write has settled", async () => {
    const pending = new PendingWrites();
    let release!: () => void;
    pending.push(new Promise<void>((resolve) => { release = resolve; }));
    let drained = false;
    const draining = pending.drain().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(drained).toBe(false);
    release();
    await draining;
    expect(drained).toBe(true);
  });

  test("drain clears the queue", async () => {
    const pending = new PendingWrites();
    pending.push(Promise.resolve());
    pending.push(Promise.resolve());
    await pending.drain();
    expect(pending.length).toBe(0);
  });

  test("a rejecting write cannot make drain throw", async () => {
    const pending = new PendingWrites();
    pending.push(Promise.reject(new Error("consumer gone")));
    await expect(pending.drain()).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Drain-then-close contract (the early-termination fix wiring).
//
// sendAndStream's finally path drains issued writes (bounded by
// DRAIN_GRACE_MS) and only then closes the writer. This is what the fix
// depends on: a slow-but-present consumer must receive every frame. A fast
// consumer reads eagerly, so the meaningful scenario is a consumer that starts
// reading late but continuously — the drain guarantees all writes have settled
// before close is allowed, so missing/reordered frames here would mean a close
// that dropped pending writes.
// ─────────────────────────────────────────────────────────────
describe("PendingWrites — drain before close delivers every frame", () => {
  test("all frames written through PendingWrites arrive after drain + close", async () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const pending = new PendingWrites();
    const encoder = new TextEncoder();

    const frames = ["delta: a\n\n", "delta: b\n\n", "finish: stop\n\n", "data: [DONE]\n\n"];
    for (const frame of frames) pending.push(writer.write(encoder.encode(frame)));

    // Consumer attaches now (late but present), and paces reads with a microtask
    // gap — slow enough to exercise backpressure, fast enough that drain
    // completes well within any timeout.
    const reader = readable.getReader();
    const readAll = (async () => {
      const received: string[] = [];
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        // Frames can arrive split across reads — split on the SSE frame boundary
        // only when a full boundary is present, otherwise keep buffering.
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          received.push(buf.slice(0, idx + 2));
          buf = buf.slice(idx + 2);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (buf) received.push(buf);
      return received;
    })();

    await pending.drain();
    await writer.close();

    expect(await readAll).toEqual(frames.map((f) => f));
  });
});

// ─────────────────────────────────────────────────────────────
// drainWithGrace — bounded drain.
//
// The drain-before-close fix must not replace one failure mode with another:
// a body that is NEVER read or cancelled leaves its write promises pending
// forever, and an unbounded drain awaited from a session queue would wedge
// every later request on that session. The grace window caps the wait; the
// caller closes the writer regardless afterwards.
// ─────────────────────────────────────────────────────────────
describe("drainWithGrace — bounded drain", () => {
  test("resolves quickly when the drain completes well within the grace window", async () => {
    const pending = new PendingWrites();
    pending.push(Promise.resolve());
    const start = Date.now();
    await drainWithGrace(pending, 1_000);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("resolves at the grace window when writes never settle (abandoned body)", async () => {
    const pending = new PendingWrites();
    pending.push(new Promise<void>(() => {})); // never settles
    const start = Date.now();
    await drainWithGrace(pending, 50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  test("grace expiry does not corrupt pending write state for a later drain", async () => {
    const pending = new PendingWrites();
    pending.push(new Promise<void>(() => {})); // never settles
    await drainWithGrace(pending, 20); // times out — bounded, does not throw
    // A later write still drains normally…
    pending.push(Promise.resolve());
    await drainWithGrace(pending, 500); // resolves fast, no hang
  });
});
