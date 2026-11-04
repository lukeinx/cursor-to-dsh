/**
 * Slash commands: multi-key management (no hand-edited yaml).
 */
import type { CursorUiConfig } from "./ui-state.ts";
import {
  addProfile,
  listProfileStatus,
  readActiveKeyId,
  removeProfile,
  setProfileKey,
  useProfile,
} from "./ui-state.ts";

function formatProfiles(rows: Awaited<ReturnType<typeof listProfileStatus>>): string {
  const lines = rows.map((p) => {
    const mark = p.active ? "*" : " ";
    const key = p.configured ? "key:ok" : "key:missing";
    return `${mark} ${p.id} (${p.label})  ref=${p.apiKeyEnv}  ${key}${p.source ? `  source=${p.source}` : ""}`;
  });
  return [
    "Cursor API key profiles (* = active):",
    ...lines,
    "Manage keys in Settings → Cursor, or: /cursor-key-set <id> <key>  /cursor-key-use <id>",
  ].join("\n");
}

export function registerCursorCommands(ctx: any, getConfig: () => CursorUiConfig): void {
  ctx.inject(["commands"], (cctx: any) => {
    cctx.commands.register({
      name: "cursor-keys",
      description: "List Cursor API key profiles and which one is active",
      handler: async (inv: any) => {
        const config = getConfig();
        const rows = await listProfileStatus(ctx, config);
        return {
          kind: "success",
          text: formatProfiles(rows),
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
