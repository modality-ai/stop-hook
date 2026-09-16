// ─────────────────────────────────────────────────────────────
// Client lifecycle decision logic — pure state machines.
//
// Extracted from copilot-to-openai.ts so the recovery rules (how many
// consecutive client-level failures before the CLI process is respawned, and
// how concurrent requests share one in-flight start) can be unit-tested
// against the real source without importing the heavy server module (which
// touches the Copilot SDK, a Hono app, and module-level /tmp dirs).
// ─────────────────────────────────────────────────────────────

// How many consecutive client-level failures are tolerated before the CLI
// process is respawned. Mirrors ABNORMAL_TURNS_BEFORE_INVALIDATE one layer up:
// a single failure is often a transient blip on an otherwise healthy pipe, but
// a second consecutive one means the transport itself is gone. Any healthy
// turn resets the count, so strikes must be CONSECUTIVE to trigger a respawn.
export const CLIENT_FAILURES_BEFORE_RESTART = 2;

// Tracks consecutive client-level failures (a rejected send, a transport
// error, a turn that timed out) and reports when the process must be
// respawned. A healthy turn forgives every earlier strike; a restart resets
// the count so the next failure starts a fresh counting window.
export class ClientStrikeCounter {
  private consecutive = 0;
  constructor(private readonly limit = CLIENT_FAILURES_BEFORE_RESTART) {}

  /** Record a failure. Returns true when the consecutive limit is reached. */
  failure(): boolean {
    this.consecutive++;
    return this.consecutive >= this.limit;
  }

  /** A turn completed without a transport-level failure — forgive all strikes. */
  healthy(): void {
    this.consecutive = 0;
  }

  /** A restart begins a fresh counting window. */
  reset(): void {
    this.consecutive = 0;
  }

  get count(): number {
    return this.consecutive;
  }
}

// Single-flight start latch: concurrent requests share ONE in-flight start.
// Without this, N requests arriving before the first start resolves would each
// call client.start() on the same client. The latch is cleared by reset() so a
// restart can respawn the CLI process.
export class StartLatch {
  private started = false;
  private starting: Promise<void> | null = null;

  /** Start the client once; concurrent callers await the same in-flight start. */
  run(start: () => Promise<void>): Promise<void> {
    if (this.started) return Promise.resolve();
    if (!this.starting) {
      this.starting = start()
        .then(() => {
          this.started = true;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  /** Clear the latch so the next run() starts again (used on client restart). */
  reset(): void {
    this.started = false;
    this.starting = null;
  }

  get isStarted(): boolean {
    return this.started;
  }
}
