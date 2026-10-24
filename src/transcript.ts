/**
 * DSH request -> the transcript shape the session core reads.
 *
 * DSH sends the whole derived history on every call: `system` messages (the latest one is the
 * effective system prompt, since the adapter declares `systemPromptUpdate: 'in-history'`),
 * `developer` context, `user`, `assistant` with `tool-call` blocks whose arguments are raw
 * JSON, and `tool` results. The core works on `user` / `developer` / `assistant` /
 * `toolResult` with parsed tool arguments, the same shape `Reply.message` has.
 *
 * Image blocks are attachment references; the adapter loads their bytes first and passes
 * them in by attachment id. Images it could not load become a text note.
 */
import { asObject, type Image } from "./prompt.ts";

export interface Transcript {
  systemPrompt: string;
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
  messages: any[];
}

const IMAGE_NOTE = "[image attachment not forwarded to Cursor]";

export type Images = ReadonlyMap<string, Image>;

/** Attachment references of the images a request carries, skipping offloaded ones. */
export function imageRefs(options: any): any[] {
  const refs = new Map<string, any>();
  for (const m of options?.messages ?? []) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      const id = b?.type === "image" && b.offloaded !== true ? b.attachment?.attachmentId : undefined;
      if (id) refs.set(String(id), b.attachment);
    }
  }
  return [...refs.values()];
}

function blocks(content: unknown, images?: Images): any[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: any[] = [];
  for (const b of content) {
    if (b?.type === "text" && b.text) out.push({ type: "text", text: b.text });
    else if (b?.type === "image") {
      const image = b.offloaded === true ? undefined : images?.get(String(b.attachment?.attachmentId));
      out.push(image ? { type: "image", data: image.data, mimeType: image.mimeType } : { type: "text", text: IMAGE_NOTE });
    }
    else if (b?.type === "file") out.push({ type: "text", text: `[file attachment: ${b.attachment?.name ?? b.attachment?.path ?? "file"}]` });
  }
  return out;
}

function plainText(content: unknown): string {
  return blocks(content)
    .map((b) => b.text)
    .join("\n");
}

function assistantBlocks(content: unknown): any[] {
  const out: any[] = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === "text" && b.text) out.push({ type: "text", text: b.text });
    else if (b?.type === "reasoning" && b.text) out.push({ type: "thinking", thinking: b.text });
    else if (b?.type === "tool-call") out.push({ type: "toolCall", id: String(b.id), name: b.name, arguments: asObject(b.arguments) });
  }
  return out;
}

export function readRequest(options: any, images?: Images): Transcript {
  let systemPrompt = typeof options?.system === "string" ? options.system : "";
  const messages: any[] = [];
  const toolNames = new Map<string, string>();
  for (const m of options?.messages ?? []) {
    switch (m?.role) {
      case "system":
        systemPrompt = plainText(m.content);
        break;
      case "developer": {
        const content = blocks(m.content, images);
        if (content.length) messages.push({ role: "developer", content });
        break;
      }
      case "user":
        messages.push({ role: "user", content: blocks(m.content, images) });
        break;
      case "assistant": {
        const content = assistantBlocks(m.content);
        for (const b of content) if (b.type === "toolCall") toolNames.set(b.id, b.name);
        messages.push({ role: "assistant", content });
        break;
      }
      case "tool": {
        const id = String(m.toolCallId ?? m.source?.callId ?? "");
        messages.push({ role: "toolResult", toolCallId: id, toolName: toolNames.get(id), isError: Boolean(m.isError), content: blocks(m.content, images) });
        break;
      }
    }
  }
  const tools = (options?.tools ?? [])
    .filter((t: any) => t?.name)
    .map((t: any) => ({ name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } }));
  return { systemPrompt, tools, messages };
}
