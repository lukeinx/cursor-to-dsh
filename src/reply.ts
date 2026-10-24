/**
 * One DSH model call as `StreamChunk` values.
 *
 * DSH expects every `block-start` closed by a `block-end` carrying the full block, usage before
 * the terminal `finish`, and nothing after it. Tool arguments are raw JSON strings.
 *
 * `message` mirrors the reply in the transcript shape the session core reads (`text`,
 * `thinking`, `toolCall` blocks), so fingerprints and token estimates match what DSH sends back.
 */
export type StopReason = "stop" | "toolUse" | "error" | "aborted";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Error codes outside DSH's default retry list: a half-finished Cursor run must not be replayed. */
export const ERROR_CODES = {
  error: "CURSOR_RUN_FAILED",
  aborted: "ABORTED",
  missingKey: "MISSING_CREDENTIAL",
} as const;

/** Push-to-pull bridge: the turn pushes chunks, the adapter's generator pulls them. */
export class ChunkQueue implements AsyncIterable<any> {
  private items: any[] = [];
  private done = false;
  private waker: (() => void) | undefined;

  push(chunk: any): void {
    if (this.done) return;
    this.items.push(chunk);
    this.wake();
  }

  end(): void {
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waker;
    this.waker = undefined;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<any> {
    for (;;) {
      while (this.items.length) yield this.items.shift();
      if (this.done) return;
      await new Promise<void>((r) => (this.waker = r));
    }
  }
}

interface ChunkSink {
  push(chunk: any): void;
  end(): void;
}

export class Reply {
  readonly message: { role: "assistant"; content: any[] } = { role: "assistant", content: [] };
  usage: TokenUsage | undefined;
  stopReason: StopReason | undefined;
  errorMessage: string | undefined;
  private open: { kind: "text" | "thinking"; index: number; block: any } | undefined;
  private nextIndex = 0;
  private ended = false;
  private readonly sink: ChunkSink;

  constructor(sink: ChunkSink) {
    this.sink = sink;
  }

  get content(): any[] {
    return this.message.content;
  }

  thinking(chunk: string): void {
    this.append("thinking", chunk);
  }

  text(chunk: string): void {
    this.append("text", chunk);
  }

  toolCalls(calls: ToolCall[]): void {
    this.close();
    const seen = new Set<string>();
    for (const call of calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      const args = call.arguments ?? {};
      this.content.push({ type: "toolCall", id: call.id, name: call.name, arguments: args });
      const index = this.nextIndex++;
      const raw = JSON.stringify(args);
      this.sink.push({ type: "block-start", index, blockType: "tool-call" });
      this.sink.push({ type: "tool-call-delta", index, id: call.id, name: call.name, argumentsDelta: raw });
      this.sink.push({ type: "block-end", index, block: { type: "tool-call", id: call.id, name: call.name, arguments: raw } });
    }
  }

  /** Terminal chunks. Safe to call more than once; only the first takes effect. */
  finish(reason: StopReason, errorMessage?: string, code?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.close();
    this.stopReason = reason;
    if (this.usage) this.sink.push({ type: "usage", usage: this.usage });
    if (reason === "error" || reason === "aborted") {
      this.errorMessage = errorMessage || (reason === "aborted" ? "Cursor run cancelled" : "Cursor run failed");
      const failure = { message: this.errorMessage, code: code ?? ERROR_CODES[reason] };
      this.sink.push({ type: "finish", reason: { kind: reason, failure } });
    } else {
      this.sink.push({ type: "finish", reason: { kind: reason === "toolUse" ? "tool-calls" : "stop" } });
    }
    this.sink.end();
  }

  private append(kind: "text" | "thinking", chunk: string): void {
    if (!chunk) return;
    if (this.open?.kind !== kind) {
      this.close();
      const block = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
      this.content.push(block);
      this.open = { kind, index: this.nextIndex++, block };
      this.sink.push({ type: "block-start", index: this.open.index, blockType: kind === "text" ? "text" : "reasoning" });
    }
    this.open.block[kind] += chunk;
    this.sink.push({ type: kind === "text" ? "text-delta" : "reasoning-delta", index: this.open.index, text: chunk });
  }

  private close(): void {
    if (!this.open) return;
    const { kind, index, block } = this.open;
    this.open = undefined;
    this.sink.push({ type: "block-end", index, block: kind === "text" ? { type: "text", text: block.text } : { type: "reasoning", text: block.thinking } });
  }
}
