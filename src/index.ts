/**
 * DSH plugin entry: registers Cursor as the `cursor` LLM provider route.
 *
 * The active API key is resolved per call from `apiKeyProfiles` + `activeKeyId`
 * (credentials → env → inline), falling back to the legacy `apiKeyEnv` / `apiKey`.
 * The Cursor agent works in the session's working directory unless `DSH_CURSOR_CWD`
 * or `cwd` overrides it.
 */
import type { Context, Volatile } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import Schema from "@deepseek-ai/schemastery";

import { CursorAdapter } from "./adapter.ts";
import { type ApiKeyProfile, type KeyConfig, resolveActiveApiKey } from "./keys.ts";
import { PROVIDER_ID, setContextPreference } from "./models.ts";
import { createCursorAgent, listCursorModels, prewarmCursor } from "./sdk.ts";
import { closeAllCursorSessions, debug } from "./session.ts";
import { webToolsEnabled } from "./web-tools.ts";

export const name = "cursor-to-dsh";
export const inject = ["llm"];

export interface Config extends KeyConfig {
  /** Volatile so the settings service gives this plugin a namespace and the Models page lists Cursor. */
  apiKeyEnv: Volatile<string> | string;
  apiKey?: string;
  context: string;
  cwd?: string;
  /** When true (or DSH_CURSOR_WEB_TOOLS=1), Cursor may call webSearch / webFetch; DSH stream shows cards. */
  enableWebTools?: boolean;
  apiKeyProfiles?: ApiKeyProfile[];
  activeKeyId?: string;
}

const ApiKeyProfileSchema = Schema.object({
  id: Schema.string().required().description("Stable profile id (referenced by activeKeyId)."),
  label: Schema.string().description("Display label in settings."),
  apiKeyEnv: Schema.string().role("credential-ref").description("Credential / environment variable that holds this profile's Cursor API key."),
  apiKey: Schema.string().role("secret").description("Inline key for this profile; used only when the credential and environment are empty."),
});

export const Config: Schema<Config> = Schema.object({
  enableWebTools: Schema.boolean()
    .default(false)
    .description("Enable Cursor built-in webSearch / webFetch. They run on the Cursor side (not DSH sandbox/approvals). DSH UI shows tool cards and a short progress line when they finish. Override with DSH_CURSOR_WEB_TOOLS=1|0."),
  apiKeyProfiles: Schema.array(ApiKeyProfileSchema)
    .default([{ id: "default", label: "Default", apiKeyEnv: "CURSOR_API_KEY" }])
    .description("Multiple Cursor API keys. Put values in ~/.dsh/.credentials.yaml under refs, then point apiKeyEnv at the ref name."),
  activeKeyId: Schema.string().default("default").description("Which apiKeyProfiles.id is used for new Cursor agents."),
  apiKeyEnv: Schema.string().role("credential-ref").default("CURSOR_API_KEY").description("Legacy single-key credential / env name (used when apiKeyProfiles is empty).").volatile(),
  apiKey: Schema.string().role("secret").description("Legacy inline Cursor API key, used only when credentials and environment are empty."),
  context: Schema.string().default("min").description("Cursor context tier: min, max, or an offered value such as 300k."),
  cwd: Schema.string().description("Cursor agent working directory; default is the session's directory."),
}) as any;

export function apply(ctx: Context, config: Config): void {
  setContextPreference(config?.context);

  const resolveApiKey = async (): Promise<string | undefined> =>
    resolveActiveApiKey(config, {
      fromCredentials: async (ref) => {
        const credentials: any = (ctx as any).get("credentials");
        if (!credentials) return undefined;
        try {
          const hit = await credentials.resolve(credentialRef(ref));
          return hit?.value?.trim() || undefined;
        } catch (err) {
          debug(`credentials lookup failed (${ref}): ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
      },
      fromEnv: (ref) => launchEnvironmentOf(ctx).get(ref)?.value ?? process.env[ref],
    });

  const cwdFor = (sessionId: string | undefined): string => {
    const override = process.env.DSH_CURSOR_CWD?.trim() || config?.cwd?.trim();
    if (override) return override;
    try {
      const session = sessionId ? (ctx as any).get("sessions")?.get?.(sessionId) : undefined;
      const dir = session ? (ctx as any).get("workingDirectory")?.get?.(session) : undefined;
      if (typeof dir === "string" && dir) return dir;
    } catch (err) {
      debug(`working directory lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return process.cwd();
  };

  const readImage = async (ref: any, signal?: AbortSignal) => {
    const attachments: any = (ctx as any).get("attachments");
    if (!attachments?.readImage) return undefined;
    const stored = await attachments.readImage(ref, signal);
    return { data: Buffer.from(stored.data).toString("base64"), mimeType: stored.ref?.mediaType ?? ref.mediaType };
  };

  const enableWeb = () => webToolsEnabled(config?.enableWebTools);

  const prewarm = /^(0|false|off)$/i.test(process.env.DSH_CURSOR_PREWARM ?? "")
    ? undefined
    : (opts: { apiKey: string; modelId: string }) => void prewarmCursor({ ...opts, enableWebTools: enableWeb() });

  const adapter = new CursorAdapter({
    createAgent: createCursorAgent,
    listModels: listCursorModels,
    resolveApiKey,
    cwdFor,
    readImage,
    prewarm,
    enableWebTools: enableWeb,
  });
  (ctx as any).llm.registerConfigurableProviders([
    { provider: PROVIDER_ID, displayName: "Cursor", settingsNs: (ctx as any).fiber?.entry?.options.id ?? name, settingsPath: [] },
  ]);
  (ctx as any).llm.registerAdapter([PROVIDER_ID], adapter);
  ctx.effect(() => () => closeAllCursorSessions(), "cursor sessions");
  void resolveApiKey()
    .then((key) => (key ? adapter.listModels(PROVIDER_ID) : undefined))
    .catch(() => {});
}
