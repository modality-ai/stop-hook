// ─────────────────────────────────────────────────────────────
// Pure JSON scanning helpers for model-emitted text.
//
// Models embed JSON literals in prose, in ``` fences, and sometimes truncate
// them mid-object. Recovering those literals needs a scanner that tracks
// string context correctly — in particular a backslash escape must be honoured
// so that a `\"` inside a string does NOT end the string, and a trailing
// `\\` DOES end it. Getting that wrong makes every brace after an escaped
// quote count in the wrong context and the whole extraction silently fails.
//
// Extracted from copilot-to-openai so the scanning rules are testable without
// booting the HTTP server or the Copilot SDK.
// ─────────────────────────────────────────────────────────────

/**
 * Index of the `}` that closes the object starting at `start`, or -1 when the
 * text ends before the object is balanced.
 *
 * `start` must point at a `{`; anything else returns -1.
 */
export const findBalancedObjectEnd = (text: string, start: number): number => {
  if (text[start] !== "{") return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; }
    else if (ch === "{") { depth++; }
    else if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
};

/**
 * Close a JSON object/array literal that was truncated mid-structure by
 * appending the missing `]`/`}` characters.
 *
 * Returns the repaired string only when it actually parses; `null` when the
 * text is unrepairable — an unterminated string, or more closers than openers,
 * means the damage is not a simple truncation and must not be guessed at.
 */
export const repairTruncatedJson = (text: string): string | null => {
  let curly = 0;
  let square = 0;
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
  }
  if (inStr || curly < 0 || square < 0) return null;
  let repaired = text;
  while (square-- > 0) repaired += "]";
  while (curly-- > 0) repaired += "}";
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
};
