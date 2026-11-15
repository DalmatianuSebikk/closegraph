/**
 * Agent bridge (closegraph-ide-ux2 plan Task 3): the PURE half of the IDE's LLM
 * integration. Prompt building and reply extraction live here — headless-testable,
 * zero imports beyond types — while `tui/index.tsx` owns the session wiring
 * (picking the project session, sending the prompt, polling the message list) and
 * `ide-model.ts` owns the per-ref describe cache + inspector section. Tasks 4
 * (chat) and 5 (ops) extend this module with turn extraction and op templates.
 *
 * Honesty rulings pinned here:
 * - The prompt NEVER invents a signature: absent fields are simply not mentioned.
 * - A reply is matched to ITS prompt (the caller passes the index of the user
 *   message it sent): assistant rows at/before that index are pre-existing
 *   session history and never count, and a newer user message means the prompt
 *   was superseded — undefined, never a misattributed answer.
 */

/** Everything the explain prompt can honestly carry about the focused function. */
export interface DescribeInput {
  ref: string;
  signature?: string; // omitted when absent — never invented
  source?: string[]; // ≤ SOURCE_EXCERPT_LINES lines, only when the excerpt is loaded
  riskReason?: string;
  sinks?: { name: string; count: number }[];
}

/** Pinned prompt shape: header + `ref:` line, then ONLY the fields that exist
 *  (signature line, verbatim source block, risk line, sinks line). */
export function buildExplainPrompt(input: DescribeInput): string {
  const lines = ["Explain in ONE short paragraph what this function does.", `ref: ${input.ref}`];
  if (input.signature !== undefined) lines.push(`signature: ${input.signature}`);
  if (input.source !== undefined && input.source.length > 0) lines.push("source:", ...input.source);
  if (input.riskReason !== undefined) lines.push(`risk: ${input.riskReason}`);
  if (input.sinks !== undefined && input.sinks.length > 0) {
    lines.push(`sinks: ${input.sinks.map((s) => (s.count > 1 ? `${s.name} ×${s.count}` : s.name)).join(", ")}`);
  }
  return lines.join("\n");
}

/** Structural message row the extraction understands. The route maps the solid
 *  Data session messages onto these (user/assistant only, text parts joined). */
export interface AgentMessageLike {
  role: "user" | "assistant" | string;
  text: string;
}

/** First assistant text AFTER the user message at `userIndex`; undefined while
 *  pending. Empty/whitespace assistant rows (tool-call-only turns) are skipped;
 *  hitting a NEWER user message means this prompt was never answered — undefined,
 *  never the next prompt's reply misattributed to this one (Review Focus 4). */
export function replyAfter(messages: AgentMessageLike[], userIndex: number): string | undefined {
  if (userIndex < 0) return undefined;
  for (let i = userIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === "user") return undefined;
    if (m.role === "assistant" && m.text.trim() !== "") return m.text;
  }
  return undefined;
}

// --- Task 4: chat sidebar -----------------------------------------------------

/** The transcript renders at most this many turns; the hidden older tail is
 *  disclosed by the model's `earlier` count (a `+N earlier` line), never silent. */
export const CHAT_TURN_CAP = 50;

/** One rendered chat turn. `muted` marks LOCAL notes (degrade paths, missing
 *  graph context) — honest client-side lines, never session content. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  muted?: boolean;
}

/** Session rows → transcript turns: user/assistant only, order preserved, blank
 *  rows dropped (a tool-call-only assistant row is never an empty bubble). */
export function extractChatTurns(messages: AgentMessageLike[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.text.trim() === "") continue;
    turns.push({ role: m.role, text: m.text });
  }
  return turns;
}

/** Pinned context prefix: prepended to the raw input text on send so the agent
 *  knows which card the question is about. The signature rides only when it
 *  exists — never invented. Callers with a synthetic/empty focus skip this
 *  entirely (raw text + the model's `no graph context` note). */
export function buildChatContextPrefix(input: { ref: string; signature?: string }): string {
  return `[graph focus: ${input.ref}${input.signature !== undefined ? ` — ${input.signature}` : ""}]\n`;
}
