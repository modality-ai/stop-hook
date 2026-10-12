// ─────────────────────────────────────────────────────────────
// Narration rescue for the Copilot proxy, extracted from copilot-to-openai so it
// is testable without that module's import-time side effects.
//
// Some models narrate a shell command in prose instead of emitting a tool_use
// literal on later turns of a multi-step workflow. When the turn clearly states
// intent plus a runnable command, translate that into a Bash call so the
// workflow keeps moving. Only applies when the available tools include Bash.
// ─────────────────────────────────────────────────────────────

type RescuedToolCall = { name: string; arguments: string };

const NARRATION_PATTERNS = [
  /\bI (?:will|need to|should|must|am going to|am about to) (?:now |then |first |next |)?(?:run|call|execute|invoke|use|issue|fetch|gather|collect)/i,
  /\b(?:Let me|I'll|I will) (?:now |then |first |next |)?(?:run|call|execute|invoke|use|issue|fetch|gather|collect)/i,
  /\b(?:Next|Then|First),?\s+(?:I|let me|I'll|I will)\s+(?:run|call|execute|invoke|use)/i,
  /\bProceeding to (?:run|call|execute|gather|collect|fetch)/i,
  /\bRunning the (?:following |required |next )?(?:commands?|use-\w+)/i,
];

export const isNarratingToolIntent = (content: string): boolean =>
  !!content && NARRATION_PATTERNS.some((re) => re.test(content));

// Looks like a runnable shell command: CLI name plus an arg-shaped second token.
// Excludes URLs, sentences, and natural-language bullet phrases.
export const looksLikeShellCommand = (s: string): boolean => {
  const t = s.trim();
  if (t.length < 3 || t.length > 400) return false;
  if (/^https?:/i.test(t)) return false;

  const firstSpaceIdx = t.search(/\s/);
  if (firstSpaceIdx < 0) return false;
  const head = t.slice(0, firstSpaceIdx);
  const tail = t.slice(firstSpaceIdx + 1).trim();
  if (!/^[a-zA-Z][\w.-]*$/.test(head)) return false;
  if (!tail) return false;

  // Parenthetical-alternation bullets: name (alt1/alt2) or name (phrase).
  if (/^\([^)]*\)\s*$/.test(tail)) return false;

  // Sentence-like text: multiple sentences or em-dash clauses.
  if (/[.!?]\s+[A-Z]/.test(t)) return false;
  if (/\s—\s|\s–\s/.test(t)) return false;

  // Definitive English prose markers.
  if (/\be\.g\.,|\bi\.e\.,/.test(t)) return false;

  // Five or more consecutive purely-alpha tokens read as prose, not args.
  let alphaRun = 0;
  for (const tok of tail.split(/\s+/)) {
    alphaRun = /^[a-zA-Z]+$/.test(tok) ? alphaRun + 1 : 0;
    if (alphaRun >= 5) return false;
  }

  const firstArg = tail.split(/\s/)[0];
  return /^(?:-{1,2}[\w-]+|[\w@./:-]+|"[^"]*"|'[^']*')$/.test(firstArg);
};

const TICK = String.fromCharCode(96);
const FENCE = TICK.repeat(3);
const FENCED_CMD = new RegExp(FENCE + "(?:bash|sh|shell)?\\s*\\n?([^\\n" + TICK + "]+)\\n?" + FENCE);
const INLINE_CMD = new RegExp(TICK + "([^" + TICK + "\\n]{3,400})" + TICK, "g");

// First plausible shell command in a narration. Sources, in order of trust:
// fenced block, inline code span, a commands-header list, numbered list, bullets.
export const extractFirstNarratedCommand = (content: string): string | null => {
  if (!content) return null;

  const fenced = content.match(FENCED_CMD);
  if (fenced?.[1] && looksLikeShellCommand(fenced[1])) return fenced[1].trim();

  let m: RegExpExecArray | null;
  INLINE_CMD.lastIndex = 0;
  while ((m = INLINE_CMD.exec(content)) !== null) {
    if (looksLikeShellCommand(m[1])) return m[1].trim();
  }

  const cmdHeaderRe = /(?:next[_ ]commands?|required (?:next )?commands?|commands? to (?:run|gather|fetch|execute)|need to run)\s*:?\s*\n((?:(?:\s*(?:-|\d+\.)\s*[^\n]+)\n?){1,20})/i;
  const cmdBlock = content.match(cmdHeaderRe);
  if (cmdBlock?.[1]) {
    const itemRe = /^\s*(?:-|\d+\.)\s+([^\n]+)$/gm;
    while ((m = itemRe.exec(cmdBlock[1])) !== null) {
      if (looksLikeShellCommand(m[1])) return m[1].trim();
    }
  }

  const numberedRe = /^[\t ]*\d+\.\s+([^\n]+)$/gm;
  while ((m = numberedRe.exec(content)) !== null) {
    if (looksLikeShellCommand(m[1])) return m[1].trim();
  }

  const bulletRe = /^[\t ]*-[\t ]+([^\n]+)$/gm;
  while ((m = bulletRe.exec(content)) !== null) {
    if (looksLikeShellCommand(m[1])) return m[1].trim();
  }

  return null;
};

// Rescue scrapes commands from prose, so it must never run anything destructive.
// Denylist of dangerous shapes; a rescued command matching any of these is dropped.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(?:-[a-z-]+\s+)*(?:--no-preserve-root\s+)?(?:\/|~|\$HOME|\*|\.\.?)(?:\*|\s|$)/i,
  /\bmkfs\b/i,
  /\bdd\b[^|]*\bof=\/dev\//i,
  /:\(\)\s*\{/,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /\bsudo\b/i,
  />\s*\/dev\/(?:sd|nvme|disk)/i,
  /\bfind\b[^|;&]*(?:-delete\b|-exec\s+rm\b)/i,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+(?:.*\s)?(?:--force|-f)\b)/i,
  /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
];

export const isDestructiveCommand = (cmd: string): boolean =>
  DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd));

export const bashRescueToolCall = (content: string, tools?: any[]): RescuedToolCall | null => {
  if (!tools?.some((t) => (t?.name ?? t?.function?.name) === "Bash")) return null;
  if (!isNarratingToolIntent(content)) return null;
  const cmd = extractFirstNarratedCommand(content);
  if (!cmd) return null;
  if (isDestructiveCommand(cmd)) return null;
  return {
    name: "Bash",
    arguments: JSON.stringify({
      command: cmd,
      description: "Auto-executed from narrated intent (server rescue)",
    }),
  };
};

/**
 * The turn's tool call: the vetted inline literal, else a narration rescue.
 *
 * When the content carries a tool_use literal that the validator rejected, the
 * rescue must not run: scraping a command from the surrounding text (or from
 * the literal's own arguments) would bypass the gate that just refused it.
 */
export const resolveTurnToolCall = (
  content: string,
  inline: RescuedToolCall | null,
  tools?: any[]
): RescuedToolCall | null => {
  if (inline) return inline;
  if (content.includes('"tool_use"')) return null;
  return bashRescueToolCall(content, tools);
};
