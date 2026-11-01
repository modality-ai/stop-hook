import { describe, expect, test } from "bun:test";
import {
  EMPTY_TURN_NUDGE_PROMPT,
  isBlankToolLoopTurn,
  isUnfulfilledToolIntent,
  mergeAssistantFrame,
  rescueStrikesSpent,
  retryEmptyTurn,
  shouldNudgeToolIntent,
  shouldStrikeUnfilledTurn,
  TOOL_NUDGE_PROMPT,
} from "../turn-content";

const BASH_LITERAL = '{"tool_use":{"name":"Bash","input":{"command":"ls"}}}';

describe("mergeAssistantFrame", () => {
  test("keeps the accumulation when the frame is empty", () => {
    expect(mergeAssistantFrame(BASH_LITERAL, "")).toBe(BASH_LITERAL);
  });

  test("keeps the accumulation when the frame is whitespace only", () => {
    expect(mergeAssistantFrame(BASH_LITERAL, "  \n ")).toBe(BASH_LITERAL);
  });

  test("keeps the accumulation when the frame is undefined", () => {
    expect(mergeAssistantFrame(BASH_LITERAL, undefined)).toBe(BASH_LITERAL);
  });

  test("adopts a prose frame while nothing has accumulated", () => {
    expect(mergeAssistantFrame("", "Hello")).toBe("Hello");
  });

  test("adopts a prose frame that replaces earlier prose", () => {
    expect(mergeAssistantFrame("Hello", "World")).toBe("World");
  });

  test("keeps an earlier literal when a later prose frame would wipe it", () => {
    expect(mergeAssistantFrame(BASH_LITERAL, "I can't access that path.")).toBe(BASH_LITERAL);
  });

  test("adopts a later frame that itself carries a literal", () => {
    const second = '{"tool_use":{"name":"Read","input":{"file_path":"/a"}}}';
    expect(mergeAssistantFrame(BASH_LITERAL, second)).toBe(second);
  });
});

describe("shouldNudgeToolIntent", () => {
  const tools = [{ name: "Bash" }];
  const announcing = "I'll inspect the file to verify any model-specific restrictions.";

  test("nudges an announcing turn that produced no call", () => {
    expect(shouldNudgeToolIntent({ hasCall: false, truncated: false, tools, content: announcing })).toBe(true);
  });

  test("never nudges a turn that already produced a call", () => {
    expect(shouldNudgeToolIntent({ hasCall: true, truncated: false, tools, content: announcing })).toBe(false);
  });

  test("never nudges a truncated turn", () => {
    expect(shouldNudgeToolIntent({ hasCall: false, truncated: true, tools, content: announcing })).toBe(false);
  });

  test("never nudges when no tools were offered", () => {
    expect(shouldNudgeToolIntent({ hasCall: false, truncated: false, tools: [], content: announcing })).toBe(false);
    expect(shouldNudgeToolIntent({ hasCall: false, truncated: false, tools: undefined, content: announcing })).toBe(false);
  });

  test("never nudges plain prose", () => {
    expect(shouldNudgeToolIntent({ hasCall: false, truncated: false, tools, content: "The tests pass." })).toBe(false);
  });
});

describe("isUnfulfilledToolIntent", () => {
  test("detects GPT-style announcements with no call", () => {
    expect(isUnfulfilledToolIntent("I'll inspect the file to verify any model-specific restrictions.")).toBe(true);
    expect(isUnfulfilledToolIntent("Let me read heroPersona.ts")).toBe(true);
  });

  test("ignores final answers and plain prose", () => {
    expect(isUnfulfilledToolIntent("The tests pass.")).toBe(false);
    expect(isUnfulfilledToolIntent("")).toBe(false);
  });

  test("ignores text that already carries a tool_use literal", () => {
    expect(isUnfulfilledToolIntent('I will run it {"tool_use":{"name":"Bash","input":{}}}')).toBe(false);
  });

  test("exposes a nudge prompt that demands the literal", () => {
    expect(TOOL_NUDGE_PROMPT).toContain("tool_use");
  });
});

describe("isUnfulfilledToolIntent persona status line", () => {
  test("detects a STATUS gerund announcement", () => {
    expect(isUnfulfilledToolIntent("TARGET: Verify model scope | STATUS: Inspecting the persona implementation.\n- JAMES")).toBe(true);
  });
  test("ignores a completed STATUS", () => {
    expect(isUnfulfilledToolIntent("TARGET: Done | STATUS: Tests pass")).toBe(false);
  });
  test("ignores a past-tense STATUS", () => {
    expect(isUnfulfilledToolIntent("TARGET: Next step | STATUS: Searched the log locations; none cover this session")).toBe(false);
    expect(isUnfulfilledToolIntent("STATUS: Reviewed 12 files")).toBe(false);
  });
});

describe("isUnfulfilledToolIntent conditional offers", () => {
  test("ignores a promise that waits on the user", () => {
    expect(isUnfulfilledToolIntent("3. Tell me where the log file is, and I'll read only that file.")).toBe(false);
    expect(isUnfulfilledToolIntent("If you share the path, I will check it.")).toBe(false);
    expect(isUnfulfilledToolIntent("Once you paste it, I'll inspect the frames.")).toBe(false);
  });
  test("still nudges an unconditional announcement", () => {
    expect(isUnfulfilledToolIntent("Done with the diff. I'll run the tests now.")).toBe(true);
  });
});

describe("isUnfulfilledToolIntent false capability refusal", () => {
  test("detects a no-access refusal that asks for a paste", () => {
    expect(isUnfulfilledToolIntent("I can review it, but I don’t have access to that local path in this session. Please paste `heroPersona.ts`.")).toBe(true);
  });
  test("still ignores a normal answer", () => {
    expect(isUnfulfilledToolIntent("The file is model-agnostic.")).toBe(false);
  });
});

describe("isUnfulfilledToolIntent refusal variants", () => {
  test("detects a bare paste request", () => {
    expect(isUnfulfilledToolIntent("Please paste the file contents.")).toBe(true);
  });

  test("detects a flat denial of filesystem access", () => {
    expect(isUnfulfilledToolIntent("I have no filesystem access here.")).toBe(true);
  });

  test("detects a bare inability claim", () => {
    expect(isUnfulfilledToolIntent("I'm unable to read that path.")).toBe(true);
  });
});

// ─── Classifier boundary after the bash-rescue removal ───────────────────────
// turn-content no longer delegates narration detection to the now-deleted
// bash-rescue module, so NUDGE_PATTERNS is the sole classifier. Only the
// scrape-and-execute half of that module was the hazard — a nudge never runs
// prose, it asks for the literal again — so the classifier keeps the union's
// full coverage: every shape below matched the old union, and must still match.

describe("isUnfulfilledToolIntent narration shapes", () => {
  // `must` / `am about to`, the invoke/issue/collect verbs, and the Next- /
  // Proceeding to- / "Running the following" openers came from the deleted
  // NARRATION_PATTERNS; the rest were already here. Losing these cost recovery
  // on common tool-calling prose for no security gain.
  const NUDGES = [
    "I will now run the tests",
    "Let me gather the data",
    "I'll inspect the file",
    "I will read the file",
    "I must run the tests",
    "I am about to run the tests",
    "I will invoke the CLI",
    "I will issue the command now",
    "I need to collect the output",
    "Proceeding to run the tests",
    "Running the following commands:",
    "Next, I run the build",
    "Then I execute the script",
    "Next, I invoke the CLI",
    "Then I call the API",
    "First, I use the search tool",
    "Proceeding to collect the output",
    "Proceeding to fetch the data",
    "Proceeding to gather the logs",
    "Running the required commands",
    "Running the next commands",
  ];

  for (const shape of NUDGES) {
    test(`nudges: ${JSON.stringify(shape)}`, () => {
      expect(isUnfulfilledToolIntent(shape)).toBe(true);
    });
  }
});

// The new openers end in \b: a verb that is only a prefix of a longer word
// must not count as a verb.
describe("isUnfulfilledToolIntent new opener boundaries", () => {
  test("does not nudge when a verb is only a prefix of a longer word", () => {
    expect(isUnfulfilledToolIntent("Proceeding to runtime checks")).toBe(false);
  });

  test("does not nudge a completed report that starts with Running", () => {
    expect(isUnfulfilledToolIntent("Running the tests passed")).toBe(false);
  });

  test("still ignores a narration that already carries a tool_use literal", () => {
    expect(isUnfulfilledToolIntent('Next, I run the build {"tool_use":{"name":"Bash","input":{}}}')).toBe(false);
  });
});

describe("retryEmptyTurn", () => {
  const run = (nudge: (entry: string) => Promise<string | null>, extra: { signal?: AbortSignal } = {}) => {
    const reacquired: string[] = [];
    const nudged: string[] = [];
    const promise = retryEmptyTurn<string, string>({
      entry: "old",
      attempts: 2,
      signal: extra.signal,
      nudge: (e) => {
        nudged.push(e);
        return nudge(e);
      },
      reacquire: async (e) => {
        reacquired.push(e);
        return "fresh";
      },
      isFilled: (r) => r.trim() !== "",
    });
    return { promise, reacquired, nudged };
  };

  test("a failed first nudge retries on the reacquired session, not the dropped one", async () => {
    let calls = 0;
    const { promise, reacquired, nudged } = run(async () => {
      if (calls++ === 0) throw new Error("rpc failed");
      return "continued";
    });
    expect(await promise).toEqual({ entry: "fresh", result: "continued" });
    expect(nudged).toEqual(["old", "fresh"]);
    expect(reacquired).toEqual(["old"]);
  });

  test("a blank first nudge retries on the same session", async () => {
    let calls = 0;
    const { promise, reacquired, nudged } = run(async () => (calls++ === 0 ? "  " : "ok"));
    expect(await promise).toEqual({ entry: "old", result: "ok" });
    expect(nudged).toEqual(["old", "old"]);
    expect(reacquired).toEqual([]);
  });

  test("returns the reacquired entry with no result when every attempt fails, without reacquiring after the last", async () => {
    const { promise, reacquired, nudged } = run(async () => {
      throw new Error("down");
    });
    expect(await promise).toEqual({ entry: "fresh", result: null });
    expect(nudged).toEqual(["old", "fresh"]);
    expect(reacquired).toEqual(["old"]);
  });

  test("returns null when every attempt is blank", async () => {
    expect(await run(async () => "").promise).toEqual({ entry: "old", result: null });
  });

  test("an aborted nudge (null) counts as no output", async () => {
    expect(await run(async () => null).promise).toEqual({ entry: "old", result: null });
  });

  test("stops before nudging when the client already left", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { promise, nudged } = run(async () => "x", { signal: ctrl.signal });
    expect(await promise).toEqual({ entry: "old", result: null });
    expect(nudged).toEqual([]);
  });

  test("returns null when reacquiring the session fails", async () => {
    const result = await retryEmptyTurn<string, string>({
      entry: "old",
      attempts: 2,
      nudge: async () => {
        throw new Error("rpc failed");
      },
      reacquire: async () => {
        throw new Error("resume failed");
      },
      isFilled: (r) => r.trim() !== "",
    });
    expect(result).toEqual({ entry: "old", result: null });
  });

  test("a client abort during a nudge stops without a second attempt", async () => {
    const ctrl = new AbortController();
    const { promise, nudged } = run(
      async () => {
        ctrl.abort();
        return null;
      },
      { signal: ctrl.signal }
    );
    expect(await promise).toEqual({ entry: "old", result: null });
    expect(nudged).toEqual(["old"]);
  });
});

describe("shouldStrikeUnfilledTurn", () => {
  test("a live entry with the client still connected is struck", () => {
    expect(shouldStrikeUnfilledTurn({ aborted: false, disposed: false })).toBe(true);
  });
  test("a client abort leaves the intact session unstruck", () => {
    expect(shouldStrikeUnfilledTurn({ aborted: true, disposed: false })).toBe(false);
  });
  test("an entry a failed nudge already dropped is not struck again", () => {
    expect(shouldStrikeUnfilledTurn({ aborted: false, disposed: true })).toBe(false);
  });
});

describe("isBlankToolLoopTurn", () => {
  const turn = { resultCount: 1, toolCount: 2, kind: "text", content: "" };
  test("a blank answer to tool results with tools offered is nudged", () => {
    expect(isBlankToolLoopTurn(turn)).toBe(true);
  });
  test("whitespace-only content still counts as blank", () => {
    expect(isBlankToolLoopTurn({ ...turn, content: " \n\t" })).toBe(true);
  });
  test("a blank reply to a bare prompt is not nudged", () => {
    expect(isBlankToolLoopTurn({ ...turn, resultCount: 0 })).toBe(false);
  });
  test("a blank turn with no tools offered is not nudged", () => {
    expect(isBlankToolLoopTurn({ ...turn, toolCount: 0 })).toBe(false);
  });
  test("a turn with text is not nudged", () => {
    expect(isBlankToolLoopTurn({ ...turn, content: "done" })).toBe(false);
  });
  test("a tool_calls turn is not nudged", () => {
    expect(isBlankToolLoopTurn({ ...turn, kind: "tool_calls" })).toBe(false);
  });
});

describe("rescueStrikesSpent", () => {
  test("a rescued strike one short of the limit skips the nudge", () => {
    expect(rescueStrikesSpent({ lastStrikeRescued: true, consecutiveAbnormalTurns: 1, limit: 2 })).toBe(true);
  });
  test("a rescued strike below that threshold still nudges", () => {
    expect(rescueStrikesSpent({ lastStrikeRescued: true, consecutiveAbnormalTurns: 0, limit: 2 })).toBe(false);
  });
  test("a non-rescue strike (e.g. truncation) at the threshold still nudges", () => {
    expect(rescueStrikesSpent({ lastStrikeRescued: false, consecutiveAbnormalTurns: 1, limit: 2 })).toBe(false);
  });
  test("a rescued strike past the limit skips the nudge", () => {
    expect(rescueStrikesSpent({ lastStrikeRescued: true, consecutiveAbnormalTurns: 3, limit: 2 })).toBe(true);
  });
});

describe("retryEmptyTurn attempt bound", () => {
  test("never nudges more than the configured attempts", async () => {
    let n = 0;
    await retryEmptyTurn<string, string>({
      entry: "e",
      attempts: 3,
      nudge: async () => {
        n++;
        return "";
      },
      reacquire: async (e) => e,
      isFilled: (r) => r !== "",
    });
    expect(n).toBe(3);
  });
});

describe("empty-turn nudge gaps", () => {
  test("EMPTY_TURN_NUDGE_PROMPT asks the model to continue rather than end empty", () => {
    expect(EMPTY_TURN_NUDGE_PROMPT).toContain("Continue the task");
  });

  test("a client abort after a blank nudge stops without a second attempt", async () => {
    const ctrl = new AbortController();
    let n = 0;
    const result = await retryEmptyTurn<string, string>({
      entry: "e",
      attempts: 3,
      signal: ctrl.signal,
      nudge: async () => {
        n++;
        ctrl.abort();
        return "";
      },
      reacquire: async (e) => e,
      isFilled: (r) => r !== "",
    });
    expect({ result, n }).toEqual({ result: { entry: "e", result: null }, n: 1 });
  });

  test("a blank nudge after a failure keeps the reacquired entry", async () => {
    let calls = 0;
    const result = await retryEmptyTurn<string, string>({
      entry: "old",
      attempts: 3,
      nudge: async () => {
        if (calls++ === 0) throw new Error("rpc failed");
        return "";
      },
      reacquire: async () => "fresh",
      isFilled: (r) => r !== "",
    });
    expect(result).toEqual({ entry: "fresh", result: null });
  });

  test("isFilled is never called with a null result", async () => {
    const seen: unknown[] = [];
    await retryEmptyTurn<string, string>({
      entry: "e",
      attempts: 1,
      nudge: async () => null,
      reacquire: async (e) => e,
      isFilled: (r) => {
        seen.push(r);
        return true;
      },
    });
    expect(seen).toEqual([]);
  });

  test("logs each nudge attempt through the log callback", async () => {
    const logs: string[] = [];
    await retryEmptyTurn<string, string>({
      entry: "e",
      attempts: 2,
      nudge: async () => "",
      reacquire: async (e) => e,
      isFilled: (r) => r !== "",
      log: (m) => logs.push(m),
    });
    expect(logs.filter((m) => /nudge \d\/2/.test(m)).length).toBe(2);
  });

  test("a non-rescue strike past the limit still nudges", () => {
    expect(rescueStrikesSpent({ lastStrikeRescued: false, consecutiveAbnormalTurns: 5, limit: 2 })).toBe(false);
  });

  test("an aborted client on a disposed entry is not struck", () => {
    expect(shouldStrikeUnfilledTurn({ aborted: true, disposed: true })).toBe(false);
  });
});
