const SIDE_SESSION_PREFIX = "side-";

// A one-shot prompt carries no assistant or tool turns: it is a standalone
// instruction (Claude Code's title/summary request) or a plain chat turn, and
// never a later turn of the conversation sharing its header.
export function isOneShotRequest(messages: any[]): boolean {
  return !(messages ?? []).some((m: any) => m?.role === "assistant" || m?.role === "tool");
}

// Run a one-shot prompt that collides with a live conversation in its own
// session. Sharing the conversation's session made its leg look like a new
// prompt, so it abandoned the tool calls the client was still executing and the
// runtime reported them as failed tools. A one-shot request carries no
// assistant or tool turns, so it can never be the continuation of those calls.
export function isSideRequest(
  headerSessionId: string | undefined,
  messages: any[],
  tools: any[] | undefined,
  hasParkedCalls: boolean
): boolean {
  if (!headerSessionId || tools?.length) return false;
  return hasParkedCalls && isOneShotRequest(messages);
}

export function sideSessionKey(headerSessionId: string): string {
  return `${SIDE_SESSION_PREFIX}${headerSessionId}`;
}
