import { describe, expect, test } from "bun:test";
import { serverModeSystemPrompt } from "../copilot-to-openai";

describe("serverModeSystemPrompt", () => {
  const withEnv = (value: string | undefined, fn: () => void) => {
    const prev = process.env.COPILOT_METHOD_RULES;
    if (value === undefined) delete process.env.COPILOT_METHOD_RULES;
    else process.env.COPILOT_METHOD_RULES = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.COPILOT_METHOD_RULES;
      else process.env.COPILOT_METHOD_RULES = prev;
    }
  };

  test("is the base prompt only by default", () => {
    withEnv(undefined, () => expect(serverModeSystemPrompt()).not.toContain("Rules:"));
  });

  test("adds the method rules when COPILOT_METHOD_RULES=1", () => {
    withEnv("1", () => expect(serverModeSystemPrompt()).toContain("`*name`"));
  });

  test("any other value leaves the rules off", () => {
    withEnv("true", () => expect(serverModeSystemPrompt()).not.toContain("Rules:"));
  });
});
