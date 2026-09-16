// ─────────────────────────────────────────────────────────────
// SSE stream emission logic — pure state machines.
//
// Extracted from copilot-to-openai.ts (sendAndStream) so the streaming
// decisions — what text to flush incrementally, what the final remainder is,
// and how pending writes are drained before the stream closes — can be
// unit-tested against the real source without importing the heavy server
// module.
// ─────────────────────────────────────────────────────────────

// Tracks what text has ACTUALLY been streamed to the SSE client. The raw count
// of fullContent chars drives incremental flushing; the exact text is what the
// final remainder is measured against. Tracking only the count was a bug: the
// remainder is sliced from `content`, which is fullContent AFTER three
// rewriting passes (xmlToolUseToJson → tidyToolUseJson →
// canonicalizeToolUseText), so a raw offset indexes the wrong string — dropping
// real text when the transforms shorten it and re-sending already-streamed
// text when they lengthen it.
export class TextEmitter {
  emittedChars = 0;
  emittedText = "";

  // Flush text[emittedChars..end) and advance the cursor. Returns the slice to
  // stream, or null when nothing new was produced (end at or before the cursor).
  flush(text: string, end: number): string | null {
    if (end <= this.emittedChars) return null;
    const slice = text.slice(this.emittedChars, end);
    this.emittedChars = end;
    this.emittedText += slice;
    return slice;
  }

  // The final remainder: everything not yet streamed, measured against what was
  // ACTUALLY streamed rather than a raw offset. When the streamed text is still
  // a prefix of the final content, send only the tail; otherwise the transforms
  // rewrote text already on the wire, and re-sending it would duplicate — send
  // nothing more.
  remainder(content: string): string {
    return content.startsWith(this.emittedText) ? content.slice(this.emittedText.length) : "";
  }
}

// Pending SSE writes. Writes are fire-and-forget at the CALL SITE (an aborted
// consumer would otherwise turn every delta into an unhandled rejection), but
// the promises are retained here so the stream can be drained before it is
// closed. Discarding them was the early-termination bug: when the
// TransformStream queue fills (long response, slow consumer), write() returns a
// promise that only settles once the consumer drains it. Closing the writer
// straight over pending writes drops the final finish_reason and [DONE] chunks,
// and the client sees a stream that "just stopped" — no error to retry on.
export class PendingWrites {
  private pending: Promise<void>[] = [];

  /** Retain a write promise, absorbing its rejection (best-effort sink). */
  push(write: Promise<void>): void {
    this.pending.push(write.catch(() => {}));
  }

  /** Resolve once every issued write has settled. */
  async drain(): Promise<void> {
    // Looped rather than a single await: a write issued WHILE we were awaiting
    // (a keepalive tick, a late frame) lands in a fresh queue that the first
    // await never saw, so it would be left behind on close.
    while (this.pending.length) {
      await Promise.allSettled(this.pending.splice(0, this.pending.length));
    }
  }

  get length(): number {
    return this.pending.length;
  }
}

// Drain the pending writes with a hard ceiling. A slow-but-alive consumer must
// be given time to drain the final frames (that is the whole point of the
// drain-before-close fix), but a response body that is NEVER read or cancelled
// leaves its write promises pending FOREVER — awaiting an unbounded drain in a
// session's queue would wedge every later request on that session. The grace
// window caps the wait; the caller then closes the writer regardless.
export async function drainWithGrace(
  pending: PendingWrites,
  graceMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      pending.drain(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
