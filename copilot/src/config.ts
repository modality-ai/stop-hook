// gpt-5-mini is no longer offered by the Copilot runtime (session.create fails
// with "not available"); claude-haiku-4.5 is listed and verified with native
// tool calls end to end.
export const DEFAULT_MODEL = "auto";
export const DEFAULT_REASON_MODEL = "auto";

// Directory used for loop state, temp files, and cached data. Overridable via
// the COPILOT_LOOP_DIR environment variable.
export const COPILOT_LOOP_DIR =
  (typeof process !== "undefined" && process.env?.COPILOT_LOOP_DIR) ||
  "/tmp/copilot-loop";
