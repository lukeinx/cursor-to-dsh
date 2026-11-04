/**
 * DSH plugin entry: registers Cursor as the `cursor` LLM provider route.
 *
 * Keys and the global web-tools default are managed from Settings → Cursor
 * (and slash commands). Secrets go through credentials.set — never hand-edit
 * ~/.dsh/.credentials.yaml. Per-chat web tools: /cursor-web on|off.
 */
import type { Context, Volatile } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import Schema from "@deepseek-ai/schemastery";

import { CursorAdapter } from "./adapter.ts";
import { registerCursorCommands } from "./commands.ts";
import { cfgString } from "./config-value.ts";
import { registerHostApi } from "./host-api.ts";
import { type ApiKeyProfile, type KeyConfig, resolveActiveApiKey } from "./keys.ts";
import { PROVIDER_ID, setContextPreference } from "./models.ts";
import { createCursorAgent, listCursorModels, prewarmCursor } from "./sdk.ts";
import { closeAllCursorSessions, debug } from "./session.ts";
import { resolveWebToolsEnabled } from "./session-web.ts";
import { readActiveKeyId, readEnableWebTools, readProfiles, type CursorUiConfig } from "./ui-state.ts";

export const name = "cursor-to-dsh";
export const inject = ["llm"];

export interface Config {
  /** Volatile so the settings service gives this plugin a namespace and the Models page lists Cursor. */
  apiKeyEnv: Volatile<string> | string;
  apiKey?: string;
  context: string | Volatile<string>;
  cwd?: string | Volatile<string>;
  /** Global default; session /cursor-web override wins. Env DSH_CURSOR_WEB_TOOLS overrides this when set. */
  enableWebTools?: boolean | Volatile<boolean>;
  apiKeyProfiles?: ApiKeyProfile[] | Volatile<ApiKeyProfile[]>;
  activeKeyId?: string | Volatile<string>;
}

const ApiKeyProfileSchema = Schema.object({
  id: Schema.string().required().description("Stable profile id (referenced by activeKeyId)."),
  label: Schema.string().description("Display label in Settings → Cursor."),
  apiKeyEnv: Schema.string().role("credential-ref").description("Credential reference that holds this profile's Cursor API key (filled via Settings → Cursor, never hand-edited yaml)."),
  apiKey: Schema.string().role("secret").description("Deprecated inline key; prefer Settings → Cursor which stores via credentials."),
});

export const Config: Schema<Config> = Schema.object({
  enableWebTools: Schema.boolean()
    .default(false)
    .description("Default: enable Cursor built-in webSearch / webFetch. Per-chat override: /cursor-web on|off. Env DSH_CURSOR_WEB_TOOLS=1|0 overrides this default.")
    .volatile(),
  apiKeyProfiles: Schema.array(ApiKeyProfileSchema)
    .default([{ id: "default", label: "Default", apiKeyEnv: "CURSOR_API_KEY" }])
    .description("Cursor API key profiles. Add/select/store keys in Settings → Cursor (or /cursor-key-* commands).")
    .volatile(),
  activeKeyId: Schema.string().default("default").description("Which apiKeyProfiles.id is used for new Cursor agents.").volatile(),
  apiKeyEnv: Schema.string().role("credential-ref").default("CURSOR_API_KEY").description("Legacy single-key credential / env name (used when apiKeyProfiles is empty).").volatile(),
  apiKey: Schema.string().role("secret").description("Legacy inline Cursor API key; prefer Settings → Cursor."),
  context: Schema.string().default("min").description("Cursor context tier: min, max, or an offered value such as 300k."),
  cwd: Schema.string().description("Cursor agent working directory; default is the session's directory."),
}) as any;

export function apply(ctx: Context, config: Config): void {
  const getConfig = (): CursorUiConfig => config as CursorUiConfig;

  setContextPreference(cfgString(config?.context, "min"));
  (ctx as any).on?.("loader/volatile-update", () => {
    setContextPreference(cfgString(config?.context, "min"));
  });

  // Own settings page (Settings → Cursor); disable auto-generated form.
  ctx.inject?.(["settings"], (sctx: any) => {
    sctx.effect?.(
      () => sctx.settings.configure({ auto: false }, ctx.fiber),
      "cursor-to-dsh: settings page policy",
    );
  });

  const resolveApiKey = async (): Promise<string | undefined> => {
    const live: KeyConfig = {
      apiKeyProfiles: readProfiles(getConfig()),
      activeKeyId: readActiveKeyId(getConfig()),
      apiKeyEnv: cfgString(config?.apiKeyEnv) || "CURSOR_API_KEY",
      apiKey: config?.apiKey,
    };
    return resolveActiveApiKey(live, {
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
  };

  const cwdFor = (sessionId: string | undefined): string => {
    const override = process.env.DSH_CURSOR_CWD?.trim() || cfgString(config?.cwd).trim();
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

  const enableWebForSession = (sessionId?: string) =>
    resolveWebToolsEnabled({
      sessionId,
      configFlag: readEnableWebTools(getConfig()),
    });

  const prewarm = /^(0|false|off)$/i.test(process.env.DSH_CURSOR_PREWARM ?? "")
    ? undefined
    : (opts: { apiKey: string; modelId: string }) => void prewarmCursor({ ...opts, enableWebTools: enableWebForSession() });

  const adapter = new CursorAdapter({
    createAgent: createCursorAgent,
    listModels: listCursorModels,
    resolveApiKey,
    cwdFor,
    readImage,
    prewarm,
    enableWebTools: enableWebForSession,
  });
  (ctx as any).llm.registerConfigurableProviders([
    { provider: PROVIDER_ID, displayName: "Cursor", settingsNs: (ctx as any).fiber?.entry?.options.id ?? name, settingsPath: [] },
  ]);
  (ctx as any).llm.registerAdapter([PROVIDER_ID], adapter);
  ctx.effect(() => () => closeAllCursorSessions(), "cursor sessions");

  registerHostApi(ctx, getConfig);
  registerCursorCommands(ctx, getConfig);

  void resolveApiKey()
    .then((key) => (key ? adapter.listModels(PROVIDER_ID) : undefined))
    .catch(() => {});

}
