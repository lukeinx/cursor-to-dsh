/**
 * Live check against real Cursor, without DSH: drives `CursorAdapter.stream()` the way the
 * DSH agent loop does (assemble the reply, run the tool, call again with the result).
 *
 *   CURSOR_API_KEY=... node --experimental-strip-types scripts/live.ts [model]
 */
import { deflateSync } from "node:zlib";
import { CursorAdapter } from "../src/adapter.ts";
import { createCursorAgent, listCursorModels } from "../src/sdk.ts";
import { closeAllCursorSessions, cursorSessionCount } from "../src/session.ts";

const model = process.argv[2] ?? "claude-haiku-5-5";
let agents = 0;
let sends = 0;
const adapter = new CursorAdapter({
  createAgent: async (opts) => {
    agents++;
    const agent = await createCursorAgent(opts);
    const send = agent.send.bind(agent);
    agent.send = (...args: any[]) => {
      sends++;
      return send(...args);
    };
    return agent;
  },
  listModels: listCursorModels,
  resolveApiKey: async () => process.env.CURSOR_API_KEY,
  cwdFor: () => process.cwd(),
  readImage: async (ref) => (ref.attachmentId === "red" ? { data: solidPng(32, [220, 20, 20]), mimeType: "image/png" } : undefined),
});

function solidPng(size: number, [r, g, b]: number[]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(4 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 4 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, ...Array.from({ length: size }, () => [r, g, b]).flat()]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
  return png.toString("base64");
}

let seq = 0;
const msg = (role: string, text: string, extra: any = {}) => ({ id: `m${++seq}`, role, content: [{ type: "text", text }], ...extra });
const secretTool = {
  name: "get_secret",
  description: "Returns the secret number. Always call it when asked for the secret.",
  parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
};

async function call(messages: any[], tools: any[], sessionId = "live-1") {
  const started = Date.now();
  let first = 0;
  const chunks: any[] = [];
  for await (const c of adapter.stream({ provider: "cursor", model, messages, tools, sessionId, reasoningEffort: undefined })) {
    if (!first && c.type !== "block-start") first = Date.now() - started;
    chunks.push(c);
  }
  const blocks = chunks.filter((c) => c.type === "block-end").map((c) => c.block);
  const finish = chunks.at(-1).reason;
  const usage = chunks.find((c) => c.type === "usage")?.usage;
  console.log(`  finish=${JSON.stringify(finish)} firstChunk=${first}ms total=${Date.now() - started}ms usage=${JSON.stringify(usage)}`);
  for (const b of blocks) console.log(`  ${b.type}: ${(b.text ?? `${b.name}(${b.arguments}) id=${b.id}`).slice(0, 160)}`);
  return { blocks, finish, assistant: { id: `m${++seq}`, role: "assistant", content: blocks } };
}

const fail = (why: string) => {
  console.error(`FAIL: ${why}`);
  closeAllCursorSessions();
  process.exit(1);
};

if (!process.env.CURSOR_API_KEY) fail("CURSOR_API_KEY is not set");
const info = await adapter.resolveModel("cursor", model);
console.log(`model ${model}: context=${info.context?.contextWindow} efforts=${info.reasoning?.efforts.map((e: any) => e.id).join(",") ?? "-"}`);

const system = msg("system", "You are a terse assistant.");
console.log("1) plain call");
const u1 = msg("user", "Reply with exactly: ok");
const r1 = await call([system, u1], [secretTool]);
if (r1.finish.kind !== "stop") fail("plain call did not stop");

console.log("2) tool call handoff");
const u2 = msg("user", "What is the secret? Use get_secret with label 'demo', then answer with just the number.");
const history = [system, u1, r1.assistant, u2];
const r2 = await call(history, [secretTool]);
const toolCall = r2.blocks.find((b) => b.type === "tool-call");
if (r2.finish.kind !== "tool-calls" || !toolCall) fail("expected a get_secret call");
const result = { id: `m${++seq}`, role: "tool", toolCallId: toolCall.id, isError: false, content: [{ type: "text", text: "4217" }] };
const sendsBefore = sends;
const r3 = await call([...history, r2.assistant, result], [secretTool]);
const answer = r3.blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
if (r3.finish.kind !== "stop" || !answer.includes("4217")) fail(`expected the answer 4217, got ${JSON.stringify(answer)}`);
if (sends !== sendsBefore) fail("the tool result started a new send instead of continuing the run");

console.log("3) tool added mid-session");
const u4 = msg("user", "Say hi.");
const r4 = await call([system, u4], [], "live-2");
const u5 = msg("user", "Now get the secret with get_secret (label 'demo') and answer with just the number.");
const r5 = await call([system, u4, r4.assistant, u5], [secretTool], "live-2");
if (r5.finish.kind !== "tool-calls" || !r5.blocks.some((b) => b.type === "tool-call" && b.name === "get_secret")) fail("the added tool was not used");

console.log("4) image attachment");
const u6 = {
  id: `m${++seq}`,
  role: "user",
  content: [
    { type: "text", text: "What single colour fills this image? Answer with one lowercase word." },
    { type: "image", attachment: { attachmentId: "red", mediaType: "image/png", bytes: 0, width: 32, height: 32 } },
  ],
};
const r6 = await call([system, u6], [], "live-3");
const colour = r6.blocks.filter((b) => b.type === "text").map((b) => b.text).join("").toLowerCase();
if (!colour.includes("red")) fail(`expected red, got ${JSON.stringify(colour)}`);

console.log(`PASS agents=${agents} sends=${sends} liveSessions=${cursorSessionCount()}`);
closeAllCursorSessions();
process.exit(0);
