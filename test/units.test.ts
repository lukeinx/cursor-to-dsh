import { test } from "node:test";
import assert from "node:assert/strict";

import { estimateTextTokens, fingerprint, currentTurnImages, renderTranscript, systemPromptAddition, toolResultForCursor } from "../src/prompt.ts";
import { ChunkQueue, Reply } from "../src/reply.ts";
import { configureRipgrep, prewarmCursor, resetPrewarm } from "../src/sdk.ts";
import { sessionKeyFor } from "../src/session.ts";
import { readRequest } from "../src/transcript.ts";
import { buckets, runUsage } from "../src/usage.ts";

test("the first send puts the system prompt and history in front of Cursor", () => {
  const text = renderTranscript("SYS", [
    { role: "user", content: "hi" },
    { role: "developer", content: [{ type: "text", text: "ctx" }] },
    { role: "assistant", content: [{ type: "text", text: "reading" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }] },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "A" }], isError: true },
  ]);
  assert.match(text, /^Only the tools attached to this request/);
  assert.match(text, /AGENTS\.md and similar[\s\S]*\n\nSYS\n\nConversation so far:\n\n### user\nhi\n\n### context\nctx/);
  assert.match(text, /### assistant\nreading\ncalls read \(c1\) with \{"path":"a"\}/);
  assert.match(text, /### read \(c1\) \[error\]\nA$/);
  assert.doesNotMatch(renderTranscript("", [{ role: "user", content: "x" }]), /AGENTS/);
});

test("fingerprints ignore what Cursor never saw", () => {
  const a = { role: "assistant", content: [{ type: "text", text: "ok" }] };
  assert.equal(fingerprint(a), fingerprint({ ...a, content: [{ type: "thinking", thinking: "hm" }, ...a.content] }));
  assert.notEqual(fingerprint({ role: "user", content: "a" }), fingerprint({ role: "user", content: "b" }));
  assert.notEqual(fingerprint({ role: "user", content: "a" }), fingerprint({ role: "developer", content: "a" }));
});

test("tool results keep images and extra text", () => {
  const img = { type: "image", data: "B64", mimeType: "image/png" };
  assert.deepEqual(currentTurnImages([{ role: "user", content: [{ type: "text", text: "see" }, img] }]), [{ data: "B64", mimeType: "image/png" }]);
  const old = { type: "image", data: "OLD", mimeType: "image/png" };
  assert.deepEqual(
    currentTurnImages([
      { role: "user", content: [old] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [img, { type: "text", text: "see" }] },
      { role: "user", content: [{ type: "text", text: "runtime context" }] },
      { role: "developer", content: [{ type: "text", text: "time" }] },
    ]),
    [{ data: "B64", mimeType: "image/png" }],
  );
  assert.deepEqual(toolResultForCursor({ content: [img], isError: false }, "note").content, [
    { type: "image", data: "B64", mimeType: "image/png" },
    { type: "text", text: "note" },
  ]);
  assert.deepEqual(toolResultForCursor({ content: [] }).content, [{ type: "text", text: "(no output)" }]);
});

test("systemPromptAddition returns only added lines and refuses removals", () => {
  assert.equal(systemPromptAddition("a\nb", "a\nb"), "");
  assert.match(systemPromptAddition("a\nb", "a\nnew\nb")!, /\]\nnew$/);
  assert.equal(systemPromptAddition("a\nb", "a\nB"), undefined);
  assert.equal(systemPromptAddition("a\nb", "a"), undefined);
});

test("token estimate counts CJK characters as about one token each", () => {
  assert.equal(estimateTextTokens("abcdefgh"), 2);
  assert.equal(estimateTextTokens("上下文缓存"), 5);
  assert.equal(estimateTextTokens("ctx 变小"), 3);
});

test("Cursor's inputTokens include cache tokens; DSH gets disjoint buckets", () => {
  assert.deepEqual(buckets({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 }), {
    input: 10,
    output: 10,
    cacheRead: 80,
    cacheWrite: 10,
    total: 110,
  });
  assert.deepEqual(runUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 }, 1, 999), {
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: 80,
    cacheWriteTokens: 10,
  });
  assert.equal(runUsage(undefined, 1, 10), undefined);
});

test("a multi-call run reports input buckets that sum to the context estimate", () => {
  const u = runUsage({ inputTokens: 900_000, outputTokens: 2_000, cacheReadTokens: 880_000, cacheWriteTokens: 10_000 }, 3, 5_000)!;
  assert.equal(u.inputTokens + u.cacheReadTokens! + u.cacheWriteTokens!, 5_000);
  assert.ok(u.cacheReadTokens! > u.inputTokens, "keeps the cache ratio");
  assert.equal(u.outputTokens, 2_000);
});

test("Reply emits balanced DSH blocks, usage, then one finish", async () => {
  const queue = new ChunkQueue();
  const reply = new Reply(queue);
  reply.thinking("hm");
  reply.text("a");
  reply.text("b");
  reply.toolCalls([
    { id: "c1", name: "read", arguments: { path: "x" } },
    { id: "c1", name: "read", arguments: { path: "x" } },
  ]);
  reply.usage = { inputTokens: 1, outputTokens: 2 };
  reply.finish("toolUse");
  reply.finish("error", "late");
  const chunks: any[] = [];
  for await (const c of queue) chunks.push(c);
  assert.deepEqual(
    chunks.map((c) => `${c.type}:${c.index ?? ""}`),
    ["block-start:0", "reasoning-delta:0", "block-end:0", "block-start:1", "text-delta:1", "text-delta:1", "block-end:1", "block-start:2", "tool-call-delta:2", "block-end:2", "usage:", "finish:"],
  );
  assert.deepEqual(chunks[6].block, { type: "text", text: "ab" });
  assert.deepEqual(chunks[9].block, { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"x"}' });
  assert.deepEqual(chunks.at(-1).reason, { kind: "tool-calls" });
  assert.deepEqual(reply.message.content.map((b: any) => b.type), ["thinking", "text", "toolCall"]);
});

test("Reply errors carry a non-retryable code", async () => {
  const queue = new ChunkQueue();
  new Reply(queue).finish("error", "boom");
  const chunks: any[] = [];
  for await (const c of queue) chunks.push(c);
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "error", failure: { message: "boom", code: "CURSOR_RUN_FAILED" } } }]);
});

test("readRequest: latest system message wins, tool names come from the calls", () => {
  const t = readRequest({
    messages: [
      { id: "s1", role: "system", content: [{ type: "text", text: "OLD" }] },
      { id: "u1", role: "user", content: [{ type: "text", text: "hi" }, { type: "image", attachment: {} }] },
      { id: "d1", role: "developer", content: [{ type: "tool-addition", toolName: "x" }] },
      { id: "a1", role: "assistant", content: [{ type: "reasoning", text: "r" }, { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a"}' }] },
      { id: "t1", role: "tool", toolCallId: "c1", isError: true, content: [{ type: "text", text: "A" }] },
      { id: "s2", role: "system", content: [{ type: "text", text: "NEW" }] },
    ],
    tools: [{ name: "read", description: "Read", parameters: { type: "object" } }, { description: "nameless" }],
  });
  assert.equal(t.systemPrompt, "NEW");
  assert.deepEqual(t.tools, [{ name: "read", description: "Read", parameters: { type: "object" } }]);
  assert.deepEqual(t.messages, [
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "[image attachment not forwarded to Cursor]" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "r" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }] },
    { role: "toolResult", toolCallId: "c1", toolName: "read", isError: true, content: [{ type: "text", text: "A" }] },
  ]);
  assert.equal(readRequest({ system: "ONE-SHOT", messages: [] }).systemPrompt, "ONE-SHOT");
});

test("session keys: DSH session id, but auxiliary calls get their own", () => {
  const t = { systemPrompt: "S", tools: [], messages: [{ role: "user", content: "hi" }] };
  assert.equal(sessionKeyFor("sess", t), "sess");
  assert.match(sessionKeyFor("sess", t, "session-title"), /^anon:/);
  assert.notEqual(sessionKeyFor("sess", t, "session-title"), sessionKeyFor("sess", t, "compaction"));
  assert.equal(sessionKeyFor(undefined, t), sessionKeyFor("", t));
});

test("an existing ripgrep path is kept, a stale one is replaced", () => {
  assert.equal(configureRipgrep({ CURSOR_RIPGREP_PATH: process.execPath } as any), process.execPath);
  const env: any = { CURSOR_RIPGREP_PATH: "/gone/rg" };
  const found = configureRipgrep(env);
  assert.notEqual(found, "/gone/rg");
  if (found) assert.equal(env.CURSOR_RIPGREP_PATH, found);
});

test("prewarm: one throwaway agent per process, run cancelled, agent closed, failures swallowed", async () => {
  resetPrewarm();
  const log: string[] = [];
  const create = async (opts: any) => {
    log.push(`create ${opts.model.id} ${opts.local.cwd.endsWith("cursor-to-dsh-warmup")}`);
    return {
      send: async (text: string) => {
        log.push(`send ${text}`);
        return { cancel: async () => log.push("cancel"), wait: async () => log.push("wait") };
      },
      close: () => log.push("close"),
    };
  };
  await prewarmCursor({ apiKey: "k", modelId: "default" }, create);
  await prewarmCursor({ apiKey: "k", modelId: "other" }, create);
  assert.deepEqual(log, ["create default true", "send .", "cancel", "wait", "close"]);

  resetPrewarm();
  await prewarmCursor({ apiKey: "k", modelId: "default" }, async () => {
    throw new Error("offline");
  });
  resetPrewarm();
});
