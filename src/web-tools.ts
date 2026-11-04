/**
 * Cursor built-in web tools (executed by the Cursor local agent, not by DSH).
 * When enabled we (1) put them on Agent.create's `tools` list and (2) mirror
 * their `tool_call` stream events into DSH tool-call blocks so Desktop shows cards.
 */

export const CURSOR_WEB_TOOL_NAMES = ["webSearch", "webFetch"] as const;
export type CursorWebToolName = (typeof CURSOR_WEB_TOOL_NAMES)[number];

export function cursorBuiltinTools(enableWebTools: boolean): string[] {
  return enableWebTools ? ["mcp", "webSearch", "webFetch"] : ["mcp"];
}

export function webToolsEnabled(configFlag: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DSH_CURSOR_WEB_TOOLS?.trim();
  if (raw !== undefined && raw !== "") return !/^(0|false|off)$/i.test(raw);
  return Boolean(configFlag);
}

export function isCursorWebTool(name: unknown): name is CursorWebToolName {
  return typeof name === "string" && (CURSOR_WEB_TOOL_NAMES as readonly string[]).includes(name);
}

/** Short, non-secret summary for a completed Cursor web tool (for stream progress text). */
export function summarizeWebToolResult(name: string, result: unknown, isError: boolean, max = 480): string {
  if (isError) {
    const msg = pickString(result) || (result && typeof result === "object" && "message" in (result as any) ? String((result as any).message) : "") || "error";
    return clip(msg, max);
  }
  if (name === "webSearch") {
    const items = Array.isArray(result)
      ? result
      : result && typeof result === "object" && Array.isArray((result as any).results)
        ? (result as any).results
        : result && typeof result === "object" && Array.isArray((result as any).items)
          ? (result as any).items
          : undefined;
    if (items?.length) {
      const titles = items
        .slice(0, 5)
        .map((it: any) => pickString(it?.title) || pickString(it?.url) || pickString(it) || "")
        .filter(Boolean);
      const head = `${items.length} result${items.length === 1 ? "" : "s"}`;
      return clip(titles.length ? `${head}: ${titles.join(" · ")}` : head, max);
    }
  }
  if (name === "webFetch") {
    const url = result && typeof result === "object" ? pickString((result as any).url) || pickString((result as any).uri) : undefined;
    const text = pickString(result) || (result && typeof result === "object" ? pickString((result as any).text) || pickString((result as any).content) || pickString((result as any).markdown) : undefined);
    if (url && text) return clip(`${url} — ${text}`, max);
    if (url) return clip(url, max);
    if (text) return clip(text, max);
  }
  return clip(pickString(result) || (result == null ? "(no output)" : safeJson(result)), max);
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
