/**
 * What Cursor sees of the DSH transcript.
 *
 * Cursor has no system-prompt slot we can use (the SDK option is server-gated), so the first
 * send of a session carries the DSH system prompt and the history as one text. Later sends
 * carry only what is new; fingerprints tell which messages Cursor already has.
 *
 * Messages here are already in the core shape (`transcript.ts`): `user`, `developer`,
 * `assistant` with `text` / `thinking` / `toolCall` blocks, and `toolResult`.
 */
import { createHash } from "node:crypto";

export interface Image {
  data: string;
  mimeType?: string;
}

export function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

/** Text of a content value (string or blocks); images and tool calls are skipped. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text ?? "" : ""))
    .filter((t) => t !== "")
    .join("\n");
}

export function imagesOf(messages: any[]): Image[] | undefined {
  const images: Image[] = [];
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) if (b?.type === "image" && b.data) images.push({ data: b.data, mimeType: b.mimeType });
  }
  return images.length ? images : undefined;
}

/** Images since the last assistant message: DSH appends context messages after the user's own. */
export function currentTurnImages(messages: any[]): Image[] | undefined {
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
  return imagesOf(messages.slice(start));
}

export function asObject(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

const TOOLS_NOTE = "Only the tools attached to this request are available. Cursor's built-in file, shell and edit tools are disabled; do not try them.";

// Cursor account rules often say "read ~/.../AGENTS.md first"; DSH injects instruction files itself.
const INSTRUCTIONS_NOTE =
  "The system prompt and context messages below come from the host agent and already include the user's instruction files (AGENTS.md and similar). If Cursor user rules ask you to read such a file first, treat it as already read; do not call a tool for it unless the user asks.";

function renderMessage(m: any): string {
  switch (m?.role) {
    case "user":
      return `### user\n${textOf(m.content)}`;
    case "developer":
      return `### context\n${textOf(m.content)}`;
    case "assistant": {
      const parts: string[] = [];
      for (const b of m.content ?? []) {
        if (b?.type === "text" && b.text) parts.push(b.text);
        else if (b?.type === "toolCall") parts.push(`calls ${b.name} (${b.id}) with ${JSON.stringify(b.arguments ?? {})}`);
      }
      return `### assistant\n${parts.join("\n")}`;
    }
    case "toolResult":
      return `### ${m.toolName ?? "tool"} (${m.toolCallId ?? ""})${m.isError ? " [error]" : ""}\n${textOf(m.content) || "(no output)"}`;
    default:
      return "";
  }
}

/** The first send of a session: tool rules, the system prompt, then the history so far. */
export function renderTranscript(systemPrompt: string | undefined, messages: any[]): string {
  const parts = [TOOLS_NOTE];
  const system = systemPrompt?.trim();
  if (system) parts.push(INSTRUCTIONS_NOTE, system);
  const history = messages.map(renderMessage).filter(Boolean);
  if (history.length) parts.push("Conversation so far:", ...history);
  return parts.join("\n\n");
}

/** Text Cursor gets for messages sent after the first: context messages keep their label. */
export function incrementText(m: any): string {
  const text = textOf(m?.content);
  return m?.role === "developer" && text ? `[context]\n${text}` : text;
}

/** Stable id of one message, limited to what Cursor saw of it. */
export function fingerprint(m: any): string {
  switch (m?.role) {
    case "user":
      return hash(`u\n${textOf(m.content)}`);
    case "developer":
      return hash(`d\n${textOf(m.content)}`);
    case "toolResult":
      return hash(`r\n${m.toolCallId ?? ""}\n${m.isError ? 1 : 0}\n${textOf(m.content)}`);
    case "assistant": {
      const parts: string[] = [];
      for (const b of m.content ?? []) {
        if (b?.type === "text" && b.text) parts.push(`t:${b.text}`);
        else if (b?.type === "toolCall") parts.push(`c:${b.id}:${b.name}:${JSON.stringify(b.arguments ?? {})}`);
      }
      return hash(`a\n${parts.join("\n")}`);
    }
    default:
      return hash(`${m?.role ?? "?"}\n${JSON.stringify(m?.content ?? "")}`);
  }
}

/** A tool result in the shape a Cursor custom tool returns. */
export function toolResultForCursor(m: any, extraText?: string): { content: any[]; isError: boolean } {
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
  const content: any[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && b.text) content.push({ type: "text", text: b.text });
    else if (b?.type === "image" && b.data) content.push({ type: "image", data: b.data, mimeType: b.mimeType });
  }
  if (extraText) content.push({ type: "text", text: extraText });
  if (!content.length) content.push({ type: "text", text: "(no output)" });
  return { content, isError: Boolean(m.isError) };
}

/**
 * Lines added to the system prompt since Cursor last saw it, as a note for the next send
 * ("" when nothing changed). `undefined` when lines were removed or rewritten: Cursor cannot
 * unlearn them, so the session must start over.
 */
export function systemPromptAddition(before: string, after: string): string | undefined {
  if (before === after) return "";
  const left = new Map<string, number>();
  for (const line of before.split("\n")) left.set(line, (left.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    else added.push(line);
  }
  for (const [line, n] of left) if (n > 0 && line.trim()) return undefined;
  const text = added.join("\n").trim();
  return text ? `[system prompt update: these lines were added to the system prompt]\n${text}` : "";
}

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g;

/** Rough token count: ~4 characters per token, but about one token per CJK character. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Estimated size of what Cursor holds for this transcript, before Cursor's own prompt. */
export function estimateTranscript(systemPrompt: string, tools: any[], messages: any[], reply: any[] = []): number {
  let n = estimateTextTokens(systemPrompt) + estimateTextTokens(JSON.stringify(tools));
  for (const m of messages) {
    n += estimateTextTokens(textOf(m?.content));
    if (m?.role === "assistant") n += estimateTextTokens(JSON.stringify(m.content ?? []));
  }
  for (const b of reply) n += estimateTextTokens(b.text ?? b.thinking ?? JSON.stringify(b.arguments ?? ""));
  return n;
}
