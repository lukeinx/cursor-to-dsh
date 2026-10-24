/**
 * DSH plugin entry: registers Cursor as the `cursor` LLM provider route.
 *
 * The key is read per call: DSH credentials (`apiKeyEnv`, default `CURSOR_API_KEY`), then the
 * launch environment, then the `apiKey` config. The Cursor agent works in the session's
 * working directory unless `DSH_CURSOR_CWD` or `cwd` overrides it.
 */
import type { Context, Volatile } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import Schema from "@deepseek-ai/schemastery";

import { CursorAdapter } from "./adapter.ts";
import { PROVIDER_ID, setContextPreference } from "./models.ts";
import { createCursorAgent, listCursorModels, prewarmCursor } from "./sdk.ts";
import { closeAllCursorSessions, debug } from "./session.ts";

export const name = "cursor-to-dsh";
export const inject = ["llm"];

export interface Config {
  /** Volatile so the settings service gives this plugin a namespace and the Models page lists Cursor. */
  apiKeyEnv: Volatile<string> | string;
  apiKey?: string;
  context: string;
  cwd?: string;
}

export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().role("credential-ref").default("CURSOR_API_KEY").description("Credential / environment variable that holds the Cursor API key.").volatile(),
  apiKey: Schema.string().role("secret").description("Cursor API key, used only when the credential and environment are empty."),
  context: Schema.string().default("min").description("Cursor context tier: min, max, or an offered value such as 300k."),
  cwd: Schema.string().description("Cursor agent working directory; default is the session's directory."),
}) as any;

export function apply(ctx: Context, config: Config): void {
  setContextPreference(config?.context);
  const keyRef = (): string => {
    const value = config?.apiKeyEnv;
    const current = typeof value === "string" ? value : value?.get?.();
    return (typeof current === "string" && current.trim()) || "CURSOR_API_KEY";
  };

  const resolveApiKey = async (): Promise<string | undefined> => {
    const ref = keyRef();
    const credentials: any = (ctx as any).get("credentials");
    if (credentials) {
      try {
        const hit = await credentials.resolve(credentialRef(ref));
        if (hit?.value?.trim()) return hit.value.trim();
      } catch (err) {
        debug(`credentials lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const ambient = launchEnvironmentOf(ctx).get(ref)?.value?.trim();
    return ambient || config?.apiKey?.trim() || undefined;
  };

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

  const prewarm = /^(0|false|off)$/i.test(process.env.DSH_CURSOR_PREWARM ?? "")
    ? undefined
    : (opts: { apiKey: string; modelId: string }) => void prewarmCursor(opts);

  const adapter = new CursorAdapter({ createAgent: createCursorAgent, listModels: listCursorModels, resolveApiKey, cwdFor, readImage, prewarm });
  (ctx as any).llm.registerConfigurableProviders([
    { provider: PROVIDER_ID, displayName: "Cursor", settingsNs: (ctx as any).fiber?.entry?.options.id ?? name, settingsPath: [] },
  ]);
  (ctx as any).llm.registerAdapter([PROVIDER_ID], adapter);
  ctx.effect(() => () => closeAllCursorSessions(), "cursor sessions");
  void resolveApiKey()
    .then((key) => (key ? adapter.listModels(PROVIDER_ID) : undefined))
    .catch(() => {});
}
