/**
 * Live UI state for multi-key profiles.
 * Prefer persisting through ctx.settings when mounted; otherwise keep an
 * in-memory overlay (keys themselves always go through credentials.set).
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";

import { cfgGet, cfgString } from "./config-value.ts";
import {
  type ApiKeyProfile,
  type KeyConfig,
  normalizeProfiles,
  profileCredentialRef,
} from "./keys.ts";

export type CursorUiConfig = KeyConfig & {
  apiKeyProfiles?: ApiKeyProfile[] | { get?: () => ApiKeyProfile[] };
  activeKeyId?: string | { get?: () => string };
};

export type ProfileStatus = {
  id: string;
  label: string;
  apiKeyEnv: string;
  active: boolean;
  configured: boolean;
  writable: boolean;
  source?: string;
};

type Overlay = {
  activeKeyId?: string;
  apiKeyProfiles?: ApiKeyProfile[];
};

const overlay: Overlay = {};

export function readProfiles(config: CursorUiConfig | undefined): ApiKeyProfile[] {
  return overlay.apiKeyProfiles ?? normalizeProfiles({
    apiKeyProfiles: cfgGet(config?.apiKeyProfiles as any),
    activeKeyId: cfgString(config?.activeKeyId) || undefined,
    apiKeyEnv: cfgString(config?.apiKeyEnv) || undefined,
    apiKey: config?.apiKey,
  });
}

export function readActiveKeyId(config: CursorUiConfig | undefined): string {
  if (overlay.activeKeyId) return overlay.activeKeyId;
  const profiles = readProfiles(config);
  const want = cfgString(config?.activeKeyId).trim();
  return want && profiles.some((p) => p.id === want) ? want : profiles[0]?.id ?? "default";
}

export function applyOverlay(next: Overlay): void {
  if (next.activeKeyId !== undefined) overlay.activeKeyId = next.activeKeyId;
  if (next.apiKeyProfiles !== undefined) overlay.apiKeyProfiles = next.apiKeyProfiles;
}

/** Test hook. */
export function resetOverlay(): void {
  delete overlay.activeKeyId;
  delete overlay.apiKeyProfiles;
}

export function settingsNamespace(ctx: any): string {
  return ctx?.fiber?.entry?.options?.id ?? "llm-cursor";
}

async function persistConfig(ctx: any, patch: Record<string, unknown>): Promise<void> {
  applyOverlay(patch as Overlay);
  const settings = ctx?.get?.("settings");
  if (!settings?.update) return;
  const ns = settingsNamespace(ctx);
  try {
    await settings.update(ns, patch);
  } catch (err) {
    // Overlay still applies for this process; caller surfaces the message.
    throw err;
  }
}

export async function listProfileStatus(ctx: any, config: CursorUiConfig | undefined): Promise<ProfileStatus[]> {
  const profiles = readProfiles(config);
  const active = readActiveKeyId(config);
  const credentials = ctx?.get?.("credentials");
  const out: ProfileStatus[] = [];
  for (const profile of profiles) {
    const refName = profileCredentialRef(profile);
    let configured = false;
    let writable = true;
    let source: string | undefined;
    if (credentials?.describe) {
      try {
        const info = await credentials.describe(credentialRef(refName));
        configured = Boolean(info?.configured);
        writable = info?.writable !== false;
        source = typeof info?.source === "string" ? info.source : undefined;
      } catch {
        /* describe failed — treat as unconfirmed / not configured */
      }
    } else if (profile.apiKey?.trim()) {
      configured = true;
      source = "inline";
    }
    out.push({
      id: profile.id,
      label: profile.label?.trim() || profile.id,
      apiKeyEnv: refName,
      active: profile.id === active,
      configured,
      writable,
      source,
    });
  }
  return out;
}

export async function setProfileKey(
  ctx: any,
  config: CursorUiConfig | undefined,
  opts: { id: string; label?: string; key: string },
): Promise<ProfileStatus[]> {
  const id = opts.id.trim();
  if (!id) throw new Error("Profile id is required");
  const key = opts.key.trim();
  if (!key) throw new Error("API key is required");
  if (!/^[\x21-\x7E]+$/.test(key)) throw new Error("API key must be non-empty printable ASCII");

  const profiles = readProfiles(config).map((p) => ({ ...p }));
  let profile = profiles.find((p) => p.id === id);
  if (!profile) {
    profile = {
      id,
      label: opts.label?.trim() || id,
      apiKeyEnv: id === "default" ? "CURSOR_API_KEY" : `CURSOR_API_KEY_${id}`.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase(),
    };
    profiles.push(profile);
  } else if (opts.label?.trim()) {
    profile.label = opts.label.trim();
  }
  // Never keep plaintext in config once credentials can store it.
  delete profile.apiKey;

  const refName = profileCredentialRef(profile);
  const credentials = ctx?.get?.("credentials");
  if (!credentials?.set) throw new Error("credentials service is not mounted; cannot store API keys from the UI");
  await credentials.set(credentialRef(refName), key);

  const activeKeyId = readActiveKeyId(config);
  await persistConfig(ctx, {
    apiKeyProfiles: profiles.map(({ id: pid, label, apiKeyEnv }) => ({
      id: pid,
      label: label || pid,
      apiKeyEnv: apiKeyEnv || profileCredentialRef({ id: pid, apiKeyEnv }),
    })),
    activeKeyId: profiles.some((p) => p.id === activeKeyId) ? activeKeyId : profiles[0].id,
  });
  return listProfileStatus(ctx, { ...config, apiKeyProfiles: profiles, activeKeyId });
}

export async function addProfile(
  ctx: any,
  config: CursorUiConfig | undefined,
  opts: { id: string; label?: string },
): Promise<ProfileStatus[]> {
  const id = opts.id.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) throw new Error("Profile id must start with a letter and use only letters, digits, _ or -");
  const profiles = readProfiles(config).map((p) => ({ ...p }));
  if (profiles.some((p) => p.id === id)) throw new Error(`Profile "${id}" already exists`);
  profiles.push({
    id,
    label: opts.label?.trim() || id,
    apiKeyEnv: id === "default" ? "CURSOR_API_KEY" : `CURSOR_API_KEY_${id}`.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase(),
  });
  await persistConfig(ctx, {
    apiKeyProfiles: profiles.map(({ id: pid, label, apiKeyEnv }) => ({ id: pid, label: label || pid, apiKeyEnv })),
    activeKeyId: readActiveKeyId(config),
  });
  return listProfileStatus(ctx, { ...config, apiKeyProfiles: profiles });
}

export async function removeProfile(
  ctx: any,
  config: CursorUiConfig | undefined,
  idRaw: string,
): Promise<ProfileStatus[]> {
  const id = idRaw.trim();
  const profiles = readProfiles(config).map((p) => ({ ...p }));
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`Profile "${id}" not found`);
  if (profiles.length === 1) throw new Error("Cannot remove the last profile");
  const [removed] = profiles.splice(idx, 1);
  const credentials = ctx?.get?.("credentials");
  const refName = profileCredentialRef(removed);
  if (credentials?.unset && credentials?.describe) {
    try {
      const info = await credentials.describe(credentialRef(refName));
      if (info?.writable && info?.configured) await credentials.unset(credentialRef(refName));
    } catch {
      /* best effort */
    }
  }
  let activeKeyId = readActiveKeyId(config);
  if (activeKeyId === id) activeKeyId = profiles[0].id;
  await persistConfig(ctx, {
    apiKeyProfiles: profiles.map(({ id: pid, label, apiKeyEnv }) => ({ id: pid, label: label || pid, apiKeyEnv })),
    activeKeyId,
  });
  return listProfileStatus(ctx, { ...config, apiKeyProfiles: profiles, activeKeyId });
}

export async function useProfile(ctx: any, config: CursorUiConfig | undefined, idRaw: string): Promise<ProfileStatus[]> {
  const id = idRaw.trim();
  const profiles = readProfiles(config);
  if (!profiles.some((p) => p.id === id)) throw new Error(`Profile "${id}" not found`);
  await persistConfig(ctx, { activeKeyId: id });
  return listProfileStatus(ctx, { ...config, activeKeyId: id });
}

export function uiSnapshot(ctx: any, config: CursorUiConfig | undefined) {
  return (async () => ({
    activeKeyId: readActiveKeyId(config),
    profiles: await listProfileStatus(ctx, config),
    settingsNs: settingsNamespace(ctx),
  }))();
}
