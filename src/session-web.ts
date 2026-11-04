/**
 * Per-DSH-session override for Cursor webSearch/webFetch.
 * Precedence when resolving: session override → DSH_CURSOR_WEB_TOOLS env → plugin config default.
 */

const OVERRIDES = new Map<string, boolean>();

export function setSessionWebTools(sessionId: string | undefined, enabled: boolean | undefined): void {
  const id = sessionId?.trim();
  if (!id) return;
  if (enabled === undefined) OVERRIDES.delete(id);
  else OVERRIDES.set(id, enabled);
}

export function getSessionWebTools(sessionId: string | undefined): boolean | undefined {
  const id = sessionId?.trim();
  if (!id) return undefined;
  return OVERRIDES.has(id) ? OVERRIDES.get(id) : undefined;
}

export function clearSessionWebTools(sessionId: string | undefined): void {
  setSessionWebTools(sessionId, undefined);
}

/** Test hook. */
export function resetSessionWebTools(): void {
  OVERRIDES.clear();
}

/**
 * Resolve effective web-tools flag for one turn.
 * Session override wins over env and global config.
 */
export function resolveWebToolsEnabled(opts: {
  sessionId?: string;
  configFlag?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const session = getSessionWebTools(opts.sessionId);
  if (session !== undefined) return session;
  const env = opts.env ?? process.env;
  const raw = env.DSH_CURSOR_WEB_TOOLS?.trim();
  if (raw !== undefined && raw !== "") return !/^(0|false|off)$/i.test(raw);
  return Boolean(opts.configFlag);
}
