/**
 * One Cursor agent per DSH session, fed only what is new.
 *
 * - The first send carries the system prompt and the history; later sends carry only the
 *   new user and context text, so Cursor's prompt cache covers the whole conversation.
 * - A DSH tool call keeps the Cursor run alive: the custom tool's `execute` waits until DSH
 *   sends the result back on the next request, so the model sees a normal tool result.
 * - Tools changed mid-session keep the agent: every send carries the current tools, and
 *   system prompt lines that were only added are prepended to the next send. A run waiting
 *   for tool results is cancelled and continued with the new tools.
 * - Anything else that does not match what Cursor saw (compaction, edit, model or param
 *   change, rewritten system prompt, lost run) starts a new agent from the full history, so
 *   correctness never depends on the cache.
 *
 * Calls without a session id, and auxiliary calls (titles, compaction), get a session keyed
 * by their opening, closed once they finish.
 */
import { isRejectedParams, modelParams, resolveModelId, smallerContext, workingContext, type Param } from "./models.ts";
import {
  estimateTranscript,
  fingerprint,
  hash,
  imagesOf,
  incrementText,
  currentTurnImages,
  renderTranscript,
  systemPromptAddition,
  textOf,
  toolResultForCursor,
  asObject,
  type Image,
} from "./prompt.ts";
import { ERROR_CODES, Reply } from "./reply.ts";
import type { Transcript } from "./transcript.ts";
import { calibrateOverhead, cursorOverhead, runUsage } from "./usage.ts";

const SLOTS_PER_KEY = 3;
const IDLE_CLOSE_MS = 20 * 60_000;
const PENDING_CLOSE_MS = 60 * 60_000;
const HANDOFF_DEBOUNCE_MS = 50;
const CANCEL_WAIT_MS = 15_000;
const ANON_PREFIX = "anon:";

export function debug(line: string): void {
  if (process.env.DSH_CURSOR_DEBUG) process.stderr.write(`[cursor-to-dsh] ${line}\n`);
}

interface PendingCall {
  id: string;
  name: string;
  args: Record<string, any>;
  handed: boolean;
  resolve: (result: any) => void;
}

class CursorSession {
  agent: any;
  run: any;
  events: any[] = [];
  runDone = true;
  runResult: any;
  runError: unknown;
  /** Model calls DSH can see in the current run: its start plus each tool-result handoff. */
  modelCalls = 0;
  /** False for a run that re-delivers tool results: Cursor saw part of that turn twice. */
  runCalibrates = true;
  sentFirst = false;
  pending: PendingCall[] = [];
  lastCallAt = 0;
  toolsKey = "";
  toolNames: string[] = [];
  /** The system prompt as Cursor knows it: the first send plus later additions. */
  systemPrompt = "";
  /** Fingerprints of the messages Cursor has seen, including its own replies. */
  seen: string[] = [];
  busy = false;
  closed = false;
  private wakers: (() => void)[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  readonly key: string;
  readonly signature: string;
  readonly params: Param[] | undefined;

  constructor(key: string, signature: string, params: Param[] | undefined) {
    this.key = key;
    this.signature = signature;
    this.params = params;
  }

  wake(): void {
    const wakers = this.wakers;
    this.wakers = [];
    for (const fn of wakers) fn();
  }

  waitForChange(ms?: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(resolve, ms);
      this.wakers.push(() => {
        if (timer) clearTimeout(timer);
        resolve();
      });
    });
  }

  registerCall(name: string, args: unknown, toolCallId: string | undefined): Promise<any> {
    return new Promise((resolve) => {
      this.pending.push({
        id: toolCallId || `call_${name}_${Date.now().toString(36)}_${this.pending.length}`,
        name,
        args: asObject(args),
        handed: false,
        resolve,
      });
      this.lastCallAt = Date.now();
      this.wake();
    });
  }

  startRun(run: any, calibrates = true): void {
    Object.assign(this, { run, events: [], runDone: false, runResult: undefined, runError: undefined, modelCalls: 1, runCalibrates: calibrates });
    void (async () => {
      try {
        const sent = Date.now();
        let waiting = true;
        for await (const msg of run.stream()) {
          if (waiting && msg?.type !== "status") {
            waiting = false;
            debug(`first ${msg?.type} key=${this.key.slice(0, 12)} after ${Date.now() - sent}ms`);
          }
          this.events.push(msg);
          this.wake();
        }
      } catch (err) {
        this.runError = err;
      }
      try {
        this.runResult = await run.wait();
      } catch (err) {
        this.runError ??= err;
      }
      this.runDone = true;
      this.wake();
    })();
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => dropSession(this), this.pending.length ? PENDING_CLOSE_MS : IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const p of this.pending) settle(() => p.resolve({ content: [{ type: "text", text: "Cancelled by the host." }], isError: true }));
    this.pending = [];
    settle(() => void Promise.resolve(this.run?.cancel?.()).catch(() => {}));
    settle(() => this.agent?.close?.());
    this.wake();
  }
}

function settle(fn: () => void): void {
  try {
    fn();
  } catch {
    /* best effort */
  }
}

const SESSIONS = new Map<string, CursorSession[]>();

function dropSession(s: CursorSession): void {
  s.close();
  const rest = (SESSIONS.get(s.key) ?? []).filter((x) => x !== s);
  if (rest.length) SESSIONS.set(s.key, rest);
  else SESSIONS.delete(s.key);
}

function storeSession(s: CursorSession): void {
  const slots = (SESSIONS.get(s.key) ?? []).filter((x) => x.signature !== s.signature);
  slots.unshift(s);
  while (slots.length > SLOTS_PER_KEY) slots.pop()?.close();
  SESSIONS.set(s.key, slots);
}

export function closeAllCursorSessions(): void {
  for (const slots of SESSIONS.values()) for (const s of slots) s.close();
  SESSIONS.clear();
}

/** Test hook. */
export function cursorSessionCount(): number {
  let n = 0;
  for (const slots of SESSIONS.values()) n += slots.length;
  return n;
}

type Results = { call: PendingCall; message: any; extra?: string }[];
type Plan = { kind: "fresh" } | { kind: "send"; text: string; images?: Image[] } | { kind: "results"; results: Results };

const sendable = (m: any) => m?.role === "user" || m?.role === "developer";

/** How the new messages map onto the live Cursor session. */
export function planIncrement(s: CursorSession | undefined, messages: any[]): Plan {
  if (!s || s.closed || !s.sentFirst || messages.length <= s.seen.length) return { kind: "fresh" };
  if (s.seen.some((fp, i) => fingerprint(messages[i]) !== fp)) return { kind: "fresh" };
  const added = messages.slice(s.seen.length);
  const handed = s.pending.filter((p) => p.handed);

  if (handed.length) {
    if (s.runDone) return { kind: "fresh" };
    const results: Results = [];
    let i = 0;
    for (; i < added.length && added[i]?.role === "toolResult"; i++) {
      const call = handed.find((p) => p.id === added[i].toolCallId);
      if (!call || results.some((r) => r.call === call)) return { kind: "fresh" };
      results.push({ call, message: added[i] });
    }
    if (results.length !== handed.length) return { kind: "fresh" };
    const steering = added.slice(i);
    if (!steering.every(sendable)) return { kind: "fresh" };
    const text = steering.map(incrementText).filter(Boolean).join("\n\n");
    if (text) results[results.length - 1].extra = `[The user sent this message while the tool was running]\n${text}`;
    return { kind: "results", results };
  }

  if (!s.runDone || s.pending.length || !added.every(sendable)) return { kind: "fresh" };
  return { kind: "send", text: added.map(incrementText).filter(Boolean).join("\n\n"), images: imagesOf(added) };
}

export interface TurnDeps {
  createAgent: (opts: any) => Promise<any>;
}

/** Auxiliary calls (titles, compaction) carry the session id but must not touch its agent. */
export function sessionKeyFor(sessionId: unknown, t: Transcript, purpose?: string): string {
  if (!purpose && typeof sessionId === "string" && sessionId) return sessionId;
  return ANON_PREFIX + hash(`${purpose ?? ""}\n${t.systemPrompt}\n${t.messages.length ? fingerprint(t.messages[0]) : ""}`);
}

function toolsKeyOf(tools: any[]): string {
  return hash(JSON.stringify(tools.map((t) => [t?.name, t?.description ?? "", t?.parameters ?? {}])));
}

/** Point the session at the current tools; returns the send options that carry them. */
function syncTools(s: CursorSession, tools: any[]): any {
  s.toolsKey = toolsKeyOf(tools);
  s.toolNames = tools.map((t) => t?.name).filter(Boolean);
  const custom: Record<string, any> = {};
  for (const tool of tools) {
    if (!tool?.name) continue;
    custom[tool.name] = {
      description: tool.description || tool.name,
      inputSchema: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {} },
      execute: (args: unknown, ctx: any) => s.registerCall(tool.name, args, ctx?.toolCallId),
    };
  }
  return Object.keys(custom).length ? { local: { customTools: custom } } : {};
}

async function openSession(
  key: string,
  modelId: string,
  params: Param[] | undefined,
  t: Transcript,
  apiKey: string,
  cwd: string,
  deps: TurnDeps,
): Promise<CursorSession> {
  const s = new CursorSession(key, signatureOf(modelId, params), params);
  s.systemPrompt = t.systemPrompt;
  const { local } = syncTools(s, t.tools);
  s.agent = await deps.createAgent({
    model: { id: modelId, ...(params?.length ? { params } : {}) },
    apiKey,
    // Always "mcp": DSH tools are MCP custom tools, and tools can be added later.
    tools: ["mcp"],
    local: { cwd, settingSources: [], customTools: local?.customTools },
  });
  storeSession(s);
  return s;
}

function signatureOf(modelId: string, params: Param[] | undefined): string {
  return hash(JSON.stringify([modelId, params ?? []]));
}

/**
 * Cursor fixes a run's tools when it starts. Cancel the waiting run and deliver its tool
 * results in a follow-up send that carries the new tools. False if the run would not stop.
 */
/**
 * Cursor lists the custom tools to the model when a conversation starts and does not announce
 * later ones (measured: the model said a tool added on the second send did not exist).
 */
function addedToolsNote(s: CursorSession, tools: any[]): string {
  const added = tools.map((t) => t?.name).filter((n) => n && !s.toolNames.includes(n));
  return added.length ? `[Tool update: these tools were added and are now available: ${added.join(", ")}. Look up their schemas before calling them.]` : "";
}

async function continueWithNewTools(
  s: CursorSession,
  results: Results,
  tools: any[],
  note: string,
  send: (s: CursorSession, text: string, images: Image[] | undefined, options: any) => Promise<any>,
): Promise<boolean> {
  settle(() => void Promise.resolve(s.run?.cancel?.()).catch(() => {}));
  const deadline = Date.now() + CANCEL_WAIT_MS;
  while (!s.runDone && Date.now() < deadline) await s.waitForChange(deadline - Date.now());
  if (!s.runDone) return false;
  for (const p of s.pending) settle(() => p.resolve({ content: [{ type: "text", text: "Delivered in the next message." }], isError: false }));
  s.pending = [];
  const parts = ["[Tool results for your last tool calls. The run was restarted because the host's tools or system prompt changed; the tools on this request are current.]"];
  for (const r of results) {
    parts.push(`### ${r.call.name} (${r.call.id})${r.message.isError ? " [error]" : ""}\n${textOf(r.message.content) || "(no output)"}`);
    if (r.extra) parts.push(r.extra);
  }
  if (note) parts.push(note);
  const added = addedToolsNote(s, tools);
  if (added) parts.push(added);
  parts.push("Continue the task.");
  const run = await send(s, parts.join("\n\n"), imagesOf(results.map((r) => r.message)), syncTools(s, tools));
  s.startRun(run, false);
  return true;
}

/** Run one DSH model call on a persistent Cursor session; every chunk goes to `reply`. */
export async function runTurn(opts: {
  model: { id: string; cursorParameters?: unknown };
  transcript: Transcript;
  reasoning?: string;
  signal?: AbortSignal;
  apiKey: string | undefined;
  sessionKey: string;
  cwd: string;
  deps: TurnDeps;
  reply: Reply;
}): Promise<void> {
  const { model, apiKey, sessionKey, cwd, deps, reply, signal } = opts;
  const t = opts.transcript;
  const modelId = resolveModelId(model.id);
  if (!apiKey) {
    return reply.finish("error", "No Cursor API key. Store CURSOR_API_KEY in DSH credentials or export it before launching DSH.", ERROR_CODES.missingKey);
  }

  let params = modelParams(model, opts.reasoning);
  const known = workingContext.get(modelId);
  if (known) params = params?.map((p) => (p.id === "context" ? { id: p.id, value: known } : p));
  const signature = signatureOf(modelId, params);

  const transcriptTokens = () => estimateTranscript(t.systemPrompt, t.tools, t.messages, reply.content);
  const contextTokens = () => transcriptTokens() + cursorOverhead(modelId);

  const send = async (s: CursorSession, text: string, images: Image[] | undefined, sendOptions: any) =>
    s.agent.send(images?.length ? { text, images } : text, sendOptions);
  const sendFirst = async (s: CursorSession) => {
    s.sentFirst = true;
    s.startRun(await send(s, renderTranscript(t.systemPrompt, t.messages), currentTurnImages(t.messages), {}));
  };

  let s = (SESSIONS.get(sessionKey) ?? []).find((x) => x.signature === signature && !x.closed && !x.busy);
  let plan = planIncrement(s, t.messages);
  let note = "";
  if (s && plan.kind !== "fresh") {
    const addition = systemPromptAddition(s.systemPrompt, t.systemPrompt);
    if (addition === undefined) plan = { kind: "fresh" };
    else note = addition;
  }
  debug(`turn key=${sessionKey.slice(0, 12)} msgs=${t.messages.length} seen=${s?.seen.length ?? "-"} plan=${plan.kind}`);
  if (s && plan.kind === "fresh") {
    dropSession(s);
    s = undefined;
  }

  let freshRun = false;
  let emitted = false;
  const onAbort = () => s?.wake();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    if (!s || plan.kind === "fresh") {
      const started = Date.now();
      s = await openSession(sessionKey, modelId, params, t, apiKey, cwd, deps);
      const created = Date.now();
      s.busy = true;
      await sendFirst(s);
      debug(`fresh key=${sessionKey.slice(0, 12)} create=${created - started}ms send=${Date.now() - created}ms chars=${renderTranscript(t.systemPrompt, t.messages).length} tools=${t.tools.length}`);
      freshRun = true;
    } else if (plan.kind === "send") {
      s.busy = true;
      const text = [note, addedToolsNote(s, t.tools), plan.text].filter(Boolean).join("\n\n");
      s.startRun(await send(s, text, plan.images, syncTools(s, t.tools)));
      s.systemPrompt = t.systemPrompt;
    } else if (note || s.toolsKey !== toolsKeyOf(t.tools)) {
      s.busy = true;
      debug(`tools or system prompt changed mid-run key=${sessionKey.slice(0, 12)}`);
      if (await continueWithNewTools(s, plan.results, t.tools, note, send)) {
        s.systemPrompt = t.systemPrompt;
      } else {
        dropSession(s);
        s = await openSession(sessionKey, modelId, params, t, apiKey, cwd, deps);
        s.busy = true;
        await sendFirst(s);
        freshRun = true;
      }
    } else {
      s.busy = true;
      s.modelCalls++;
      for (const r of plan.results) {
        s.pending = s.pending.filter((p) => p !== r.call);
        r.call.resolve(toolResultForCursor(r.message, r.extra));
      }
    }
    s.touch();
    // What Cursor has now seen; this call's reply is appended when it ends.
    s.seen = t.messages.map(fingerprint);

    for (;;) {
      while (s.events.length) {
        const msg = s.events.shift();
        if (msg?.type === "thinking") {
          reply.thinking(msg.text);
          emitted ||= Boolean(msg.text);
        } else if (msg?.type === "assistant") {
          for (const b of msg.message?.content ?? []) {
            if (b?.type === "text" && b.text) {
              reply.text(b.text);
              emitted = true;
            }
          }
        }
      }
      if (signal?.aborted) {
        dropSession(s);
        return reply.finish("aborted");
      }

      const fresh = s.pending.filter((p) => !p.handed);
      if (fresh.length) {
        // Parallel calls arrive a few ms apart; hand them to DSH together.
        const wait = s.lastCallAt + HANDOFF_DEBOUNCE_MS - Date.now();
        if (wait > 0) {
          await s.waitForChange(wait);
          continue;
        }
        for (const p of fresh) p.handed = true;
        reply.toolCalls(fresh.map((p) => ({ id: p.id, name: p.name, arguments: p.args })));
        // Cursor reports usage only when the run ends; a mid-run estimate would count as spend.
        reply.finish("toolUse");
        s.seen.push(fingerprint(reply.message));
        return;
      }

      if (!s.runDone) {
        await s.waitForChange();
        continue;
      }

      const result = s.runResult;
      const status = result?.status ?? (s.runError ? "error" : "finished");
      if (status === "finished") {
        reply.usage = runUsage(result?.usage, s.modelCalls, contextTokens());
        if (s.modelCalls === 1 && s.runCalibrates) calibrateOverhead(modelId, result?.usage, transcriptTokens());
        s.run = undefined;
        reply.finish("stop");
        s.seen.push(fingerprint(reply.message));
        if (sessionKey.startsWith(ANON_PREFIX)) dropSession(s);
        return;
      }

      const error = result?.error?.message ?? (s.runError instanceof Error ? s.runError.message : s.runError ? String(s.runError) : undefined);
      const lower = freshRun && !emitted && s.modelCalls === 1 && isRejectedParams(error) ? smallerContext(model, s.params) : undefined;
      if (lower) {
        workingContext.set(modelId, lower.find((p) => p.id === "context")!.value);
        dropSession(s);
        s = await openSession(sessionKey, modelId, lower, t, apiKey, cwd, deps);
        s.busy = true;
        await sendFirst(s);
        s.seen = t.messages.map(fingerprint);
        continue;
      }
      dropSession(s);
      return reply.finish(status === "cancelled" ? "aborted" : "error", error);
    }
  } catch (err) {
    if (s) dropSession(s);
    reply.finish(signal?.aborted ? "aborted" : "error", err instanceof Error ? err.message : String(err));
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    if (s) {
      s.busy = false;
      if (!s.closed) s.touch();
    }
    reply.finish("error", "Cursor turn ended without a result");
  }
}
