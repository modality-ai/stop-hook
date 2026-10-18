// ─────────────────────────────────────────────────────────────
// Pure per-turn content decisions for the Copilot proxy — no fs, no network, no
// module-level mutable state.
//
// Extracted from copilot-to-openai for the same reason tool-use-text was: that
// module runs `tryMkdir` + `setClientCwd` at import time, so decisions buried
// inside it cannot be tested without booting the server. Both frame rules below
// were duplicated across two call sites apiece.
// ─────────────────────────────────────────────────────────────

/**
 * Fold one `assistant.message` frame into the turn's accumulated content.
 *
 * A turn can emit several frames, and two shapes must not clobber the
 * accumulation: an empty turn-final frame (the SDK's post-delta frame — fatal
 * in "tool" mode, which buffers, because the turn then ends with no tool_call
 * and no text), and a later prose frame ("I can't access that path") following
 * one that already carried a tool_use literal.
 */
export const mergeAssistantFrame = (current: string, incoming: string | undefined): string => {
  if (!incoming?.trim()) return current;
  if (!current.includes('"tool_use"') || incoming.includes('"tool_use"')) return incoming;
  return current;
};

// Models narrate a tool action ("I'll inspect the file", "Proceeding to run the
// tests") and then end the turn with no call at all. Used only to decide whether
// to nudge once. The nudge never scrapes a shell command — it only asks for the
// literal again — so this classifier stays wide even though the prose-scraping
// rescue it once shared patterns with is gone.
const NUDGE_PATTERNS = [
  /\b(?:I'll|I will|I am going to|I'm going to|I am about to|I must|Let me|I need to|I should)\s+(?:now |then |first |next |also |quickly )?(?:inspect|read|open|check|look|examine|search|grep|find|review|verify|view|list|scan|fetch|run|call|use|execute|gather|invoke|issue|collect)\b/i,
  // Narrations with no first-person verb of their own: a discourse marker
  // ("Next, I run the build") or a gerund ("Proceeding to run the tests",
  // "Running the following commands:"). All three are common in tool-calling
  // prose, so they carry their own entries.
  /\b(?:Next|Then|First),?\s+(?:I|let me|I'll|I will)\s+(?:run|call|execute|invoke|use)\b/i,
  /\bProceeding to (?:run|call|execute|gather|collect|fetch)\b/i,
  /\bRunning the (?:following |required |next )?(?:commands?|use-\w+)\b/i,
  // A false capability refusal: "I don't have access to that local path ...
  // please paste the file" — although Read is listed in Available tools.
  /\b(?:I (?:can(?:no|['’])t|don['’]?t have|do not have|am unable to)|unable to|no (?:filesystem|file|tool))\b[^.\n]{0,60}\b(?:access|read|open|view|tool)\b/i,
  /\b(?:please|could you|can you)\s+(?:paste|share|provide|send)\b[^.\n]{0,60}\b(?:file|code|contents?)\b/i,
  // Persona status lines ("TARGET: ... | STATUS: Inspecting the persona
  // implementation.") announce work in the gerund with no first-person verb.
  /\bSTATUS:\s*(?:Inspect|Read|Check|Review|Analy[sz]|Examin|Search|Verif|Look|Fetch|Run|Gather|Investigat|Scann|Open)\w*/i,
];

/** True when a turn that produced no tool call ends by announcing one. */
export const isUnfulfilledToolIntent = (content: string): boolean => {
  const t = content?.trim();
  if (!t || t.includes('"tool_use"')) return false;
  return NUDGE_PATTERNS.some((re) => re.test(t));
};

export const TOOL_NUDGE_PROMPT =
  "You announced a tool action or claimed no tool access, but emitted no tool call. The tools under Available tools ARE available to you (including Read and Bash). Emit the tool_use JSON literal now, as the ONLY output, with no prose.";

/**
 * Whether a call-less turn should be nudged once for the tool_use literal it
 * announced. Only meaningful when tools were offered and the turn was not cut
 * short by the runaway guard.
 */
export const shouldNudgeToolIntent = (turn: {
  hasCall: boolean;
  truncated: boolean;
  tools?: any[];
  content: string;
}): boolean =>
  !turn.hasCall && !turn.truncated && !!turn.tools?.length && isUnfulfilledToolIntent(turn.content);
