/**
 * The Host half's browser-facing wiring: the Models card must learn the credential reference this
 * plugin resolves, and a key saved there must reach the catalog without waiting out its cache.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BOOT_GLOBAL, apply } from "../src/index.ts";

interface FakeContext {
  ctx: any;
  listeners: Record<string, Function[]>;
  providers: any[];
  adapters: any[];
}

/** A context carrying only what the entry touches: the llm registry, events and effects. */
function fakeContext(): FakeContext {
  const listeners: Record<string, Function[]> = {};
  const providers: any[] = [];
  const adapters: any[] = [];
  const ctx: any = {
    get: () => undefined,
    on: (name: string, listener: Function) => {
      (listeners[name] ??= []).push(listener);
      return () => {};
    },
    effect: () => () => {},
    fiber: { entry: { options: { id: "llm-cursor" } } },
    llm: {
      registerConfigurableProviders: (entries: any[]) => {
        providers.push(...entries);
        return { dispose: () => {} };
      },
      registerAdapter: (ids: string[], adapter: any) => {
        adapters.push({ ids, adapter });
        return { dispose: () => {} };
      },
    },
  };
  return { ctx, listeners, providers, adapters };
}

test("the entry exposes Cursor under its settings namespace", () => {
  const { ctx, providers, adapters } = fakeContext();
  apply(ctx, { apiKeyEnv: "CURSOR_API_KEY", context: "min" } as any);
  assert.deepEqual(providers, [
    { provider: "cursor", displayName: "Cursor", settingsNs: "llm-cursor", settingsPath: [] },
  ]);
  assert.deepEqual(adapters.map((entry) => entry.ids), [["cursor"]]);
});

test("the page global names the reference the adapter actually resolves", () => {
  const { ctx, listeners } = fakeContext();
  apply(ctx, { apiKeyEnv: "MY_CURSOR_KEY", context: "min" } as any);
  const table: any[] = [];
  listeners["webserver/index-inject"]![0]!(table, {});
  assert.deepEqual(table, [
    { kind: "global", name: BOOT_GLOBAL, value: { provider: "cursor", keyRef: "MY_CURSOR_KEY" } },
  ]);
});

test("an unusable apiKeyEnv resolves to the default reference everywhere", () => {
  const { ctx, listeners } = fakeContext();
  apply(ctx, { apiKeyEnv: "not a name", context: "min" } as any);
  const table: any[] = [];
  listeners["webserver/index-inject"]![0]!(table, {});
  assert.equal(table[0].value.keyRef, "CURSOR_API_KEY");
});

test("a credential change drops the cached catalog", () => {
  const { ctx, listeners, adapters } = fakeContext();
  apply(ctx, { apiKeyEnv: "CURSOR_API_KEY", context: "min" } as any);
  const adapter = adapters[0]!.adapter;
  let invalidated = 0;
  adapter.invalidateCatalog = () => {
    invalidated += 1;
  };
  listeners["credentials/reference-updated"]![0]!("CURSOR_API_KEY");
  assert.equal(invalidated, 1);
});
