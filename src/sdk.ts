import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * The SDK scans the workspace with its bundled ripgrep and expects the host to say where it
 * is. the host does not put package binaries on PATH, so point the SDK at the platform package.
 */
export function configureRipgrep(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // A path inherited from an earlier install may no longer exist.
  const explicit = env.CURSOR_RIPGREP_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const platform = `${process.platform}-${process.arch}`;
  const binaries = process.platform === "win32" ? ["bin/rg.exe", "bin/rg"] : ["bin/rg"];
  for (const binary of binaries) {
    try {
      const path = require.resolve(`@cursor/sdk-${platform}/${binary}`);
      if (existsSync(path)) return (env.CURSOR_RIPGREP_PATH = path);
    } catch {
      /* optional platform package not installed */
    }
  }
  return undefined;
}

export async function createCursorAgent(opts: any): Promise<any> {
  const { Agent } = await import("@cursor/sdk");
  configureRipgrep();
  return Agent.create(opts);
}

/**
 * The SDK's first agent in a process pays ~8s of one-time setup (key exchange, model
 * catalog, feature flags) split between `Agent.create` and the first `send`; later agents,
 * any model, start in about a second. Pay it in the background with a throwaway agent whose
 * run is cancelled as soon as the send is accepted. Once per process; failures are ignored.
 * It works in an empty directory because the SDK scans its working directory, and the
 * host process may run from `/`.
 */
let warming: Promise<void> | undefined;

export function prewarmCursor(opts: { apiKey: string; modelId: string }, create = createCursorAgent): Promise<void> {
  warming ??= (async () => {
    let agent: any;
    let local: any;
    try {
      const cwd = join(tmpdir(), "cursor-to-dsh-warmup");
      mkdirSync(cwd, { recursive: true });
      local = { cwd, settingSources: [] };
      agent = await create({ model: { id: opts.modelId }, apiKey: opts.apiKey, tools: ["mcp"], local });
      const run = await agent.send(".");
      await Promise.resolve(run.cancel?.()).catch(() => {});
      await Promise.resolve(run.wait?.()).catch(() => {});
    } catch {
      /* warm-up is best effort */
    } finally {
      try {
        agent?.close?.();
      } catch {
        /* ignore */
      }
      const id = agent?.agentId;
      if (id) void deleteCursorAgent(id, { apiKey: opts.apiKey, local }).catch(() => {});
    }
  })();
  return warming;
}

/** Test hook. */
export function resetPrewarm(): void {
  warming = undefined;
}

async function deleteCursorAgent(id: string, opts: any): Promise<void> {
  const { Agent } = await import("@cursor/sdk");
  await Agent.delete(id, opts);
}

export async function listCursorModels(opts: { apiKey: string }): Promise<any[]> {
  const { Cursor } = await import("@cursor/sdk");
  return Cursor.models.list(opts);
}
