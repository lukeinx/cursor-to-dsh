import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { CursorAdapter } from "../src/adapter.ts";
import { FALLBACK_MODELS } from "../src/models.ts";
import { closeAllCursorSessions, cursorSessionCount } from "../src/session.ts";
import { cursorOverhead, resetCursorOverhead } from "../src/usage.ts";

/** Scripted fake Cursor agent. Each send runs `script(ctx)` as the model. */
function fakeCursor(script: (ctx: any) => AsyncGenerator<any, any, void>) {
  const created: any[] = [];
  const sends: any[] = [];
  const sendOpts: any[] = [];
  const createAgent = async (opts: any) => {
    created.push(opts);
    const agentTools = opts.local?.customTools ?? {};
    return {
      send: async (msg: any, options?: any) => {
        sends.push(msg);
        sendOpts.push(options);
        const tools = options?.local?.customTools ?? agentTools;
        let status: any = { status: "finished", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 } };
        const queue: any[] = [];
        let wake: (() => void) | undefined;
        let finished = false;
        let cancelled = false;
        const ctx = {
          msg,
          opts,
          callTool: async (name: string, args: any, id: string) => {
            if (!tools[name]) throw new Error(`unknown tool ${name}`);
            return tools[name].execute(args, { toolCallId: id });
          },
          setStatus: (s: any) => (status = s),
        };
        (async () => {
          for await (const ev of script(ctx)) {
            if (cancelled) return;
            queue.push(ev);
            wake?.();
          }
          finished = true;
          wake?.();
        })();
        return {
          stream: async function* () {
            for (;;) {
              while (queue.length) yield queue.shift();
              if (finished) return;
              await new Promise<void>((r) => (wake = r));
            }
          },
          wait: async () => {
            while (!finished) await new Promise((r) => setTimeout(r, 1));
            return status;
          },
          cancel: async () => {
            if (finished) return;
            cancelled = true;
            status = { status: "cancelled" };
            finished = true;
            wake?.();
          },
        };
      },
      close: () => {},
    };
  };
  return { createAgent, created, sends, sendOpts };
}

const say = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

let seq = 0;
const nextId = () => `msg-${++seq}`;
const text = (t: string) => [{ type: "text", text: t }];
const sys = (t: string) => ({ id: nextId(), role: "system", content: text(t), source: { kind: "system-prompt" } });
const user = (t: string) => ({ id: nextId(), role: "user", content: text(t), source: { kind: "user" } });
const dev = (t: string) => ({ id: nextId(), role: "developer", content: text(t), source: { kind: "user" } });
const toolResult = (callId: string, t: string, isError = false) => ({
  id: nextId(),
  role: "tool",
  toolCallId: callId,
  isError,
  content: text(t),
  source: { kind: "tool", callId },
});

const readTool = { name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } };
const xTool = { name: "x_doctor", description: "Check X", parameters: { type: "object", properties: {} } };

const v = (...values: string[]) => values.map((value) => ({ value }));
const catalog = [
  { id: "m", displayName: "M" },
  {
    id: "claude",
    displayName: "Claude",
    parameters: [
      { id: "thinking", values: v("true", "false") },
      { id: "effort", values: v("low", "high") },
      { id: "fast", values: v("true", "false") },
      { id: "context", values: v("300k", "1m") },
    ],
  },
];

function adapterFor(cursor: { createAgent: any }, deps: any = {}) {
  return new CursorAdapter({
    createAgent: cursor.createAgent,
    listModels: async () => catalog,
    resolveApiKey: async () => "k",
    cwdFor: () => "/work",
    ...deps,
  });
}

/** One DSH model call; the reply is assembled the way DSH stores it. */
async function call(adapter: CursorAdapter, messages: any[], options: any = {}) {
  const chunks: any[] = [];
  for await (const c of adapter.stream({ provider: "cursor", model: "m", messages, tools: [readTool], sessionId: "sess-1", ...options })) chunks.push(c);
  const blocks = chunks.filter((c) => c.type === "block-end").map((c) => c.block);
  const assistant = { id: nextId(), role: "assistant", content: blocks, source: { kind: "model", provider: "cursor", model: options.model ?? "m" } };
  return {
    chunks,
    finish: chunks.at(-1).reason,
    assistant,
    usage: chunks.find((c) => c.type === "usage")?.usage,
    text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(""),
    calls: blocks.filter((b) => b.type === "tool-call"),
  };
}

beforeEach(() => {
  closeAllCursorSessions();
  resetCursorOverhead();
});

test("one Cursor agent per session; later calls send only the new user text", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    yield say(`echo:${typeof ctx.msg === "string" ? ctx.msg.slice(-5) : ""}`);
  });
  const adapter = adapterFor(cursor);
  const s = sys("SYS");
  const u1 = user("hello");
  const r1 = await call(adapter, [s, u1]);
  assert.deepEqual(r1.finish, { kind: "stop" });
  assert.equal(r1.text, "echo:hello");
  assert.match(cursor.sends[0], /^Only the tools attached[\s\S]*SYS[\s\S]*### user\nhello$/);
  assert.equal(cursor.created[0].local.cwd, "/work");
  assert.deepEqual(cursor.created[0].tools, ["mcp"]);
  assert.deepEqual(cursor.created[0].local.settingSources, []);

  const r2 = await call(adapter, [s, u1, r1.assistant, user("again")]);
  assert.deepEqual(r2.finish, { kind: "stop" });
  assert.equal(cursor.created.length, 1, "agent reused");
  assert.equal(cursor.sends[1], "again", "only the new text is sent");
});

test("a tool call stays inside one Cursor run and gets DSH's real result", async () => {
  let got: any;
  const cursor = fakeCursor(async function* (ctx) {
    yield say("reading");
    got = await ctx.callTool("read", { path: "a.txt" }, "call-1");
    yield say("done");
  });
  const adapter = adapterFor(cursor);
  const s = sys("SYS");
  const u1 = user("read a.txt");
  const r1 = await call(adapter, [s, u1]);
  assert.deepEqual(r1.finish, { kind: "tool-calls" });
  assert.equal(r1.text, "reading");
  assert.deepEqual(r1.calls, [{ type: "tool-call", id: "call-1", name: "read", arguments: '{"path":"a.txt"}' }]);
  assert.equal(r1.usage, undefined, "no usage mid-run");

  const r2 = await call(adapter, [s, u1, r1.assistant, toolResult("call-1", "FILE")]);
  assert.deepEqual(r2.finish, { kind: "stop" });
  assert.equal(r2.text, "done");
  assert.deepEqual(got, { content: [{ type: "text", text: "FILE" }], isError: false });
  assert.equal(cursor.created.length, 1);
  assert.equal(cursor.sends.length, 1, "no second send: the run continued");
});

test("parallel tool calls are handed to DSH together", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    const [a, b] = await Promise.all([ctx.callTool("read", { path: "a" }, "c-a"), ctx.callTool("read", { path: "b" }, "c-b")]);
    yield say(`${a.content[0].text}+${b.content[0].text}`);
  });
  const adapter = adapterFor(cursor);
  const u1 = user("read both");
  const r1 = await call(adapter, [u1]);
  assert.deepEqual(r1.calls.map((c) => c.id), ["c-a", "c-b"]);
  const r2 = await call(adapter, [u1, r1.assistant, toolResult("c-a", "A"), toolResult("c-b", "B", true)]);
  assert.equal(r2.text, "A+B");
});

test("context messages DSH adds are sent with the next user text", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("x");
  const r1 = await call(adapter, [u1]);
  await call(adapter, [u1, r1.assistant, dev("cwd is /work"), user("y")]);
  assert.equal(cursor.created.length, 1);
  assert.equal(cursor.sends[1], "[context]\ncwd is /work\n\ny");
});

test("a user message sent while a tool runs rides along with the tool result", async () => {
  const results: any[] = [];
  const cursor = fakeCursor(async function* (ctx) {
    results.push(await ctx.callTool("read", { path: "a" }, "c-1"));
    yield say("done");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("go");
  const r1 = await call(adapter, [u1]);
  await call(adapter, [u1, r1.assistant, toolResult("c-1", "FILE"), user("also check b")]);
  assert.match(results[0].content.at(-1).text, /while the tool was running\]\nalso check b$/);
});

test("removed tools are dropped silently; only added ones are announced", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("x");
  const r1 = await call(adapter, [u1], { tools: [readTool, xTool] });
  await call(adapter, [u1, r1.assistant, user("y")], { tools: [readTool] });
  assert.equal(cursor.sends[1], "y");
  assert.deepEqual(Object.keys(cursor.sendOpts[1].local.customTools), ["read"]);
});

test("a rewritten history (compaction) replays from scratch on a new agent", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const adapter = adapterFor(cursor);
  await call(adapter, [user("first")]);
  await call(adapter, [user("[summary] first -> ok"), user("next")]);
  assert.equal(cursor.created.length, 2);
  assert.match(cursor.sends[1], /\[summary\]/);
  assert.equal(cursorSessionCount(), 1);
});

test("system prompt: a later system message with added lines keeps the agent, a rewrite does not", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const adapter = adapterFor(cursor);
  const s = sys("SYS");
  const u1 = user("x");
  const r1 = await call(adapter, [s, u1]);
  const u2 = user("y");
  const r2 = await call(adapter, [s, u1, r1.assistant, sys("SYS\n- x_doctor: diagnose"), u2], { tools: [readTool, xTool] });
  assert.equal(cursor.created.length, 1, "agent reused");
  assert.match(cursor.sends[1], /system prompt update[^\n]*\n- x_doctor: diagnose\n\n\[Tool update: [^\n]*available: x_doctor\.[^\n]*\]\n\ny$/);
  assert.deepEqual(Object.keys(cursor.sendOpts[1].local.customTools), ["read", "x_doctor"]);

  await call(adapter, [s, u1, r1.assistant, sys("SYS\n- x_doctor: diagnose"), u2, r2.assistant, sys("OTHER"), user("z")]);
  assert.equal(cursor.created.length, 2, "rewritten prompt starts over");
});

test("a tool change while DSH runs a tool continues on the same agent with the new tools", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    if (typeof ctx.msg === "string" && ctx.msg.startsWith("[Tool results")) {
      await ctx.callTool("x_doctor", {}, "c-x");
      yield say("done");
      return;
    }
    await ctx.callTool("read", { path: "a" }, "c-1");
    yield say("stale run");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("go");
  const r1 = await call(adapter, [u1]);
  const res1 = toolResult("c-1", "FILE");
  const r2 = await call(adapter, [u1, r1.assistant, res1], { tools: [readTool, xTool] });
  assert.equal(r2.calls[0]?.name, "x_doctor");
  assert.equal(cursor.created.length, 1);
  assert.match(cursor.sends[1], /### read \(c-1\)\nFILE[\s\S]*available: x_doctor\./);
  const r3 = await call(adapter, [u1, r1.assistant, res1, r2.assistant, toolResult("c-x", "OK")], { tools: [readTool, xTool] });
  assert.equal(r3.text, "done");
  assert.equal(cursor.sends.length, 2, "the follow-up run continued");
});

test("an aborted call finishes as aborted and drops the session", async () => {
  const cursor = fakeCursor(async function* () {
    await new Promise((r) => setTimeout(r, 50));
    yield say("late");
  });
  const adapter = adapterFor(cursor);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  const r = await call(adapter, [user("hi")], { signal: controller.signal });
  assert.equal(r.finish.kind, "aborted");
  assert.equal(r.finish.failure.code, "ABORTED");
  assert.equal(cursorSessionCount(), 0);
});

test("a failed run reports a non-retryable error code", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    ctx.setStatus({ status: "error", error: { message: "model exploded" } });
  });
  const r = await call(adapterFor(cursor), [user("hi")]);
  assert.deepEqual(r.finish, { kind: "error", failure: { message: "model exploded", code: "CURSOR_RUN_FAILED" } });
  assert.equal(cursorSessionCount(), 0);
});

test("catalog params: effort mapped, Fast off, context stepped down when rejected", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const created: any[] = [];
  const createAgent = async (opts: any) => {
    created.push(opts.model.params);
    const agent = await cursor.createAgent(opts);
    if (!opts.model.params?.some((p: any) => p.value === "1m")) return agent;
    return {
      ...agent,
      send: async () => ({
        stream: async function* () {},
        wait: async () => ({ status: "error", error: { message: 'Invalid parameters for registry model: "claude"' } }),
        cancel: async () => {},
      }),
    };
  };
  process.env.DSH_CURSOR_CONTEXT = "max";
  try {
    const r = await call(adapterFor({ createAgent }), [user("hi")], { model: "claude", reasoningEffort: "low" });
    assert.deepEqual(r.finish, { kind: "stop" });
  } finally {
    delete process.env.DSH_CURSOR_CONTEXT;
  }
  assert.deepEqual(created[0], [
    { id: "thinking", value: "true" },
    { id: "effort", value: "low" },
    { id: "fast", value: "false" },
    { id: "context", value: "1m" },
  ]);
  assert.equal(created[1].at(-1).value, "300k");
});

test("usage: a single-call run is exact, a tool-heavy run fits the context estimate", async () => {
  const first = fakeCursor(async function* () {
    yield say("ok");
  });
  const r1 = await call(adapterFor(first), [user("hello")]);
  assert.deepEqual(r1.usage, { inputTokens: 10, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 });
  const overhead = cursorOverhead("m");
  assert.ok(overhead > 0 && overhead < 110);

  closeAllCursorSessions();
  const cursor = fakeCursor(async function* (ctx) {
    await ctx.callTool("read", { path: "a" }, "c-1");
    ctx.setStatus({ status: "finished", usage: { inputTokens: 900_000, outputTokens: 2_000, cacheReadTokens: 890_000 } });
    yield say("done");
  });
  const adapter = adapterFor(cursor);
  const u = user("read a");
  const c1 = await call(adapter, [u]);
  const r2 = await call(adapter, [u, c1.assistant, toolResult("c-1", "x".repeat(400))]);
  const fill = r2.usage.inputTokens + r2.usage.cacheReadTokens + r2.usage.cacheWriteTokens;
  assert.ok(fill > overhead + 100 && fill < 1_000, `context fill ${fill} is the estimate, not the cumulative input`);
  assert.equal(r2.usage.outputTokens, 2_000);
  assert.equal(r2.usage.totalTokens, undefined);
});

test("auxiliary calls (session titles) get their own agent and leave the session alone", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    yield say(typeof ctx.msg === "string" && ctx.msg.includes("Title this") ? "A title" : "ok");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("x");
  const r1 = await call(adapter, [u1]);
  const title = await call(adapter, [user("Title this")], { purpose: "session-title", tools: [] });
  assert.equal(title.text, "A title");
  assert.equal(cursorSessionCount(), 1, "the title agent is closed");
  await call(adapter, [u1, r1.assistant, user("y")]);
  assert.equal(cursor.created.length, 2, "main session kept its agent");
  assert.equal(cursor.sends.at(-1), "y");
});

test("a missing API key fails with MISSING_CREDENTIAL and creates no agent", async () => {
  const cursor = fakeCursor(async function* () {});
  const r = await call(adapterFor(cursor, { resolveApiKey: async () => undefined }), [user("hi")]);
  assert.equal(r.finish.kind, "error");
  assert.equal(r.finish.failure.code, "MISSING_CREDENTIAL");
  assert.equal(cursor.created.length, 0);
});

test("stop sequences are rejected instead of silently dropped", async () => {
  const cursor = fakeCursor(async function* () {});
  await assert.rejects(call(adapterFor(cursor), [user("hi")], { stop: ["END"] }), (err: any) => err.failure?.code === "UNSUPPORTED_OPTION");
});

const imageBlock = (id: string) => ({ type: "image", attachment: { attachmentId: id, mediaType: "image/png", bytes: 3, width: 1, height: 1 } });

test("user images reach Cursor as bytes and each attachment is read once", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("seen");
  });
  const reads: string[] = [];
  const adapter = adapterFor(cursor, {
    readImage: async (ref: any) => {
      reads.push(ref.attachmentId);
      return { data: `B64-${ref.attachmentId}`, mimeType: ref.mediaType };
    },
  });
  const u1 = { id: nextId(), role: "user", content: [{ type: "text", text: "what is this" }, imageBlock("a1")], source: { kind: "user" } };
  const r1 = await call(adapter, [u1]);
  assert.deepEqual(cursor.sends[0].images, [{ data: "B64-a1", mimeType: "image/png" }]);
  assert.match(cursor.sends[0].text, /### user\nwhat is this$/);

  const u2 = { id: nextId(), role: "user", content: [{ type: "text", text: "and this" }, imageBlock("a2")], source: { kind: "user" } };
  await call(adapter, [u1, r1.assistant, u2]);
  assert.deepEqual(cursor.sends[1], { text: "and this", images: [{ data: "B64-a2", mimeType: "image/png" }] });
  assert.deepEqual(reads, ["a1", "a2"], "a1 came from the cache on the second call");
  assert.deepEqual((await adapter.listModels("cursor"))[0].inputModalities, ["text", "image"]);
});

test("tool results carry images to Cursor; unreadable images become a note", async () => {
  let toolGot: any;
  const cursor = fakeCursor(async function* (ctx) {
    toolGot = await ctx.callTool("read", { path: "shot.png" }, "c-img");
    yield say("seen");
  });
  const adapter = adapterFor(cursor, {
    readImage: async (ref: any) => {
      if (ref.attachmentId === "broken") throw new Error("gone");
      return { data: `B64-${ref.attachmentId}`, mimeType: ref.mediaType };
    },
  });
  const u1 = user("look at the screenshot");
  const r1 = await call(adapter, [u1]);
  const shot = { id: nextId(), role: "tool", toolCallId: "c-img", content: [imageBlock("a2"), imageBlock("broken")], source: { kind: "tool", callId: "c-img" } };
  await call(adapter, [u1, r1.assistant, shot]);
  assert.deepEqual(toolGot.content, [
    { type: "image", data: "B64-a2", mimeType: "image/png" },
    { type: "text", text: "[image attachment not forwarded to Cursor]" },
  ]);
});

test("models: live catalog with efforts, fallback when the catalog is unavailable", async () => {
  const adapter = adapterFor(fakeCursor(async function* () {}));
  assert.deepEqual((await adapter.listModels("cursor")).map((m: any) => m.id), ["m", "claude"]);
  const claude = await adapter.resolveModel("cursor", "claude");
  assert.equal(claude.name, "Claude");
  assert.equal(claude.context.contextWindow, 300_000);
  assert.equal(claude.systemPromptUpdate, "in-history");
  assert.deepEqual(claude.reasoning.efforts.map((e: any) => e.id), ["off", "low", "high"]);
  assert.equal((await adapter.resolveModel("cursor", "m")).reasoning, undefined);
  assert.equal((await adapter.resolveModel("cursor", "unlisted")).name, "unlisted");

  const autos = adapterFor(fakeCursor(async function* () {}), {
    listModels: async () => [...catalog, { id: "auto-smart", displayName: "Auto" }, { id: "default", displayName: "Auto" }],
  });
  assert.deepEqual((await autos.listModels("cursor")).map((m: any) => m.name), ["M", "Claude", "Auto (auto-smart)", "Auto (default)"]);
  assert.equal((await autos.resolveModel("cursor", "default")).name, "Auto (default)");

  const offline = adapterFor(fakeCursor(async function* () {}), {
    listModels: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual((await offline.listModels("cursor")).map((m: any) => m.id), FALLBACK_MODELS.map((m) => m.id));
  const keyless = adapterFor(fakeCursor(async function* () {}), { resolveApiKey: async () => undefined });
  assert.equal((await keyless.listModels("cursor")).length, FALLBACK_MODELS.length);
});

test("prewarm runs after a live catalog, not on the fallback catalog", async () => {
  const warmed: any[] = [];
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  await adapterFor(cursor, { prewarm: (o: any) => warmed.push(o) }).listModels("cursor");
  assert.deepEqual(warmed, [{ apiKey: "k", modelId: catalog[0].id }]);
  await adapterFor(cursor, { prewarm: (o: any) => warmed.push(o), resolveApiKey: async () => undefined }).listModels("cursor");
  assert.equal(warmed.length, 1);
});
