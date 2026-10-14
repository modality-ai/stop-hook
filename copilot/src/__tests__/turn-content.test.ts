import { describe, expect, test } from "bun:test";
import {
  isUnfulfilledToolIntent,
  mergeAssistantFrame,
  shouldNudgeToolIntent,
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
