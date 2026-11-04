/**
 * Slash commands: session web-tools toggle + multi-key management (no hand-edited yaml).
 */
import type { CursorUiConfig } from "./ui-state.ts";
import {
  addProfile,
  listProfileStatus,
  readActiveKeyId,
  readEnableWebTools,
  removeProfile,
  setProfileKey,
  setWebDefault,
  useProfile,
} from "./ui-state.ts";
import { getSessionWebTools, setSessionWebTools } from "./session-web.ts";

function sessionIdOf(agent: any): string | undefined {
  const id = agent?.session?.id ?? agent?.sessionId ?? agent?.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function parseOnOff(raw: string): boolean | undefined {
  const t = raw.trim().toLowerCase();
  if (!t || t === "status" || t === "show") return undefined;
  if (["on", "1", "true", "enable", "enabled"].includes(t)) return true;
  if (["off", "0", "false", "disable", "disabled"].includes(t)) return false;
  return undefined;
}

function formatProfiles(rows: Awaited<ReturnType<typeof listProfileStatus>>, webDefault: boolean, sessionWeb?: boolean): string {
  const lines = rows.map((p) => {
    const mark = p.active ? "*" : " ";
    const key = p.configured ? "key:ok" : "key:missing";
    return `${mark} ${p.id} (${p.label})  ref=${p.apiKeyEnv}  ${key}${p.source ? `  source=${p.source}` : ""}`;
  });
  const session =
    sessionWeb === undefined ? "session web: (inherit)" : `session web: ${sessionWeb ? "on" : "off"}`;
  return [
    "Cursor API key profiles (* = active):",
    ...lines,
    `default web tools: ${webDefault ? "on" : "off"}`,
    session,
    "Manage keys in Settings → Cursor, or: /cursor-key-set <id> <key>  /cursor-key-use <id>",
  ].join("\n");
}

export function registerCursorCommands(ctx: any, getConfig: () => CursorUiConfig): void {
  ctx.inject(["commands"], (cctx: any) => {
    cctx.commands.register({
      name: "cursor-web",
      description: "Session Cursor webSearch/webFetch: on | off | toggle | status (overrides Settings default for this chat)",
      input: { hint: "on | off | toggle | status" },
      handler: async (inv: any) => {
        const sid = sessionIdOf(inv.agent);
        if (!sid) return { kind: "error", text: "No session id on this agent; cannot set a session override." };
        const raw = String(inv.rawInput ?? "").trim().toLowerCase();
        const config = getConfig();
        const global = readEnableWebTools(config);
        if (!raw || raw === "status" || raw === "show") {
          const cur = getSessionWebTools(sid);
          return {
            kind: "success",
            text:
              cur === undefined
                ? `Cursor web tools for this session: inherit (default ${global ? "on" : "off"}). Try /cursor-web on|off|toggle.`
                : `Cursor web tools for this session: ${cur ? "on" : "off"} (default ${global ? "on" : "off"}).`,
          };
        }
        if (raw === "toggle" || raw === "switch") {
          const cur = getSessionWebTools(sid);
          const next = !(cur === undefined ? global : cur);
          setSessionWebTools(sid, next);
          return { kind: "success", text: `Cursor web tools for this session: ${next ? "on" : "off"} (next turn recreates the Cursor agent if needed).` };
        }
        const parsed = parseOnOff(raw);
        if (parsed === undefined) return { kind: "error", text: "Usage: /cursor-web on | off | toggle | status" };
        setSessionWebTools(sid, parsed);
        return { kind: "success", text: `Cursor web tools for this session: ${parsed ? "on" : "off"} (overrides Settings → Cursor).` };
      },
    });

    cctx.commands.register({
      name: "cursor-web-default",
      description: "Set the global default for Cursor webSearch/webFetch (Settings → Cursor)",
      input: { hint: "on | off" },
      handler: async (inv: any) => {
        const parsed = parseOnOff(String(inv.rawInput ?? ""));
        if (parsed !== true && parsed !== false) return { kind: "error", text: "Usage: /cursor-web-default on | off" };
        try {
          await setWebDefault(ctx, parsed);
          return { kind: "success", text: `Default Cursor web tools: ${parsed ? "on" : "off"}. Sessions without /cursor-web override follow this.` };
        } catch (err) {
          return { kind: "error", text: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    cctx.commands.register({
      name: "cursor-keys",
      description: "List Cursor API key profiles and which one is active",
      handler: async (inv: any) => {
        const config = getConfig();
        const rows = await listProfileStatus(ctx, config);
        const sid = sessionIdOf(inv.agent);
        return {
          kind: "success",
          text: formatProfiles(rows, readEnableWebTools(config), getSessionWebTools(sid)),
        };
      },
    });

    cctx.commands.register({
      name: "cursor-key-use",
      description: "Select which Cursor API key profile is active",
      input: { hint: "<profile-id>" },
      handler: async (inv: any) => {
        const id = String(inv.rawInput ?? "").trim();
        if (!id) return { kind: "error", text: "Usage: /cursor-key-use <profile-id>" };
        try {
          const rows = await useProfile(ctx, getConfig(), id);
          return { kind: "success", text: `Active Cursor key: ${readActiveKeyId({ activeKeyId: id, apiKeyProfiles: rows.map((r) => ({ id: r.id, label: r.label, apiKeyEnv: r.apiKeyEnv })) })}` };
        } catch (err) {
          return { kind: "error", text: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    cctx.commands.register({
      name: "cursor-key-add",
      description: "Add a Cursor API key profile (then /cursor-key-set to store the secret)",
      input: { hint: "<id> [label]" },
      handler: async (inv: any) => {
        const parts = String(inv.rawInput ?? "").trim().split(/\s+/).filter(Boolean);
        if (!parts[0]) return { kind: "error", text: "Usage: /cursor-key-add <id> [label]" };
        try {
          await addProfile(ctx, getConfig(), { id: parts[0], label: parts.slice(1).join(" ") || undefined });
          return { kind: "success", text: `Added profile "${parts[0]}". Store its key with /cursor-key-set ${parts[0]} <key> (or Settings → Cursor).` };
        } catch (err) {
          return { kind: "error", text: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    cctx.commands.register({
      name: "cursor-key-remove",
      description: "Remove a Cursor API key profile and its stored credential (when writable)",
      input: { hint: "<profile-id>" },
      handler: async (inv: any) => {
        const id = String(inv.rawInput ?? "").trim();
        if (!id) return { kind: "error", text: "Usage: /cursor-key-remove <profile-id>" };
        try {
          await removeProfile(ctx, getConfig(), id);
          return { kind: "success", text: `Removed profile "${id}".` };
        } catch (err) {
          return { kind: "error", text: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    // recordInput:false so the secret is not written into the session log.
    cctx.commands.register({
      name: "cursor-key-set",
      description: "Store a Cursor API key for a profile (write-only; prefer Settings → Cursor)",
      input: { hint: "<profile-id> <api-key>" },
      recordInput: false,
      handler: async (inv: any) => {
        const raw = String(inv.rawInput ?? "");
        const m = raw.match(/^\s*(\S+)\s+(\S[\s\S]*)$/);
        if (!m) return { kind: "error", text: "Usage: /cursor-key-set <profile-id> <api-key>" };
        try {
          await setProfileKey(ctx, getConfig(), { id: m[1], key: m[2].trim() });
          return { kind: "success", text: `Stored key for profile "${m[1]}" in DSH credentials (value never shown).` };
        } catch (err) {
          return { kind: "error", text: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  });
}
