/**
 * Cursor API key profiles: multiple credential refs, one active at a time.
 * Lookup order per profile: DSH credentials → launch / process env → inline apiKey.
 * When profiles are empty, falls back to the legacy single-key fields.
 */

export interface ApiKeyProfile {
  id: string;
  label?: string;
  apiKeyEnv?: string;
  apiKey?: string;
}

export interface KeyConfig {
  apiKeyProfiles?: ApiKeyProfile[];
  activeKeyId?: string;
  /** Legacy single credential / env name. */
  apiKeyEnv?: string | { get?: () => string };
  apiKey?: string;
}

export function normalizeProfiles(config: KeyConfig | undefined): ApiKeyProfile[] {
  const listed = (config?.apiKeyProfiles ?? []).filter((p) => p && typeof p.id === "string" && p.id.trim());
  if (listed.length) return listed.map((p) => ({ ...p, id: p.id.trim() }));
  const legacyEnv = readString(config?.apiKeyEnv) || "CURSOR_API_KEY";
  return [{ id: "default", label: "Default", apiKeyEnv: legacyEnv, apiKey: config?.apiKey }];
}

export function activeProfile(config: KeyConfig | undefined): ApiKeyProfile {
  const profiles = normalizeProfiles(config);
  const want = (config?.activeKeyId ?? "").trim();
  return profiles.find((p) => p.id === want) ?? profiles[0];
}

export function profileCredentialRef(profile: ApiKeyProfile): string {
  const env = profile.apiKeyEnv?.trim();
  if (env) return env;
  if (profile.id === "default") return "CURSOR_API_KEY";
  return `CURSOR_API_KEY_${profile.id}`.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object" && typeof (value as any).get === "function") {
    const current = (value as any).get();
    return typeof current === "string" && current.trim() ? current.trim() : undefined;
  }
  return undefined;
}

export type KeyLookup = {
  fromCredentials: (ref: string) => Promise<string | undefined>;
  fromEnv: (ref: string) => string | undefined;
};

/** Resolve the active profile's key. Never logs the secret. */
export async function resolveActiveApiKey(config: KeyConfig | undefined, lookup: KeyLookup): Promise<string | undefined> {
  const profile = activeProfile(config);
  const ref = profileCredentialRef(profile);
  try {
    const hit = await lookup.fromCredentials(ref);
    if (hit?.trim()) return hit.trim();
  } catch {
    /* credentials service missing or ref unknown */
  }
  const ambient = lookup.fromEnv(ref)?.trim();
  if (ambient) return ambient;
  const inline = profile.apiKey?.trim();
  if (inline) return inline;
  // Last resort: legacy top-level apiKey when the active profile has none.
  return config?.apiKey?.trim() || undefined;
}
