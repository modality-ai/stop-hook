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
//
// The test is "a tool-capable conversation already exists", NOT "a leg is parked
// right now". A title/summary request arrives concurrently with the turn it
// describes and normally lands before that turn's leg registers, so a transient
// parked/active check misses it: the request joins the conversation, inherits
// its MCP tools, and the model executes a `*method` token quoted in the title
// text. The stray call is then abandoned when the real request arrives, which is
// what surfaces to the model as a fabricated "Tool execution failed".
//
// A conversation with no tools keeps sharing its session: a plain chat client
// that sends only the new message each turn must not lose its history to a
// throwaway session, and with no tools there is nothing for it to call anyway.
export function isSideRequest(
  headerSessionId: string | undefined,
  messages: any[],
  tools: any[] | undefined,
  liveToolConversation: boolean
): boolean {
  if (!headerSessionId || tools?.length) return false;
  return liveToolConversation && isOneShotRequest(messages);
}

export function sideSessionKey(headerSessionId: string): string {
  return `${SIDE_SESSION_PREFIX}${headerSessionId}`;
}
