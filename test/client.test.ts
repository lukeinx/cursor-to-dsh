/**
 * The browser half is hand-written plain JavaScript loaded by the Web shell, so its contract is
 * checked here: the factory registers one settings-namespace card, and the Host callbacks it
 * hands that card write through the credentials remote under the published reference.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

interface ClientDefinition {
  id: string;
  factory(require: (specifier: string) => unknown): any;
}

interface Harness {
  plugin: any;
  registrations: any[];
  dictionaries: any[];
  written: { ref: string; value: string }[];
  removed: string[];
}

/** The baseline modules the shell's frozen table hands a factory; the card only renders. */
const react = {
  createElement: () => null,
  useState: (initial: unknown) => [initial, () => {}],
  useCallback: (callback: unknown) => callback,
};

/** Evaluate `client.js` against a stub loader, returning the definition and its page realm. */
function load(): { definition: ClientDefinition; page: any } {
  const code = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const loaded: ClientDefinition[] = [];
  const page: any = { console, window: { __ModuleLoader__: { load: (entry: ClientDefinition) => loaded.push(entry) } } };
  vm.runInNewContext(code, page);
  assert.equal(loaded.length, 1, "client.js registers exactly one module definition");
  return { definition: loaded[0]!, page };
}

/** Apply the plugin to a fake browser context and record what it registered. */
function harness(options: { boot?: unknown; set?: (ref: string, value: string) => Promise<unknown>; unset?: (ref: string) => Promise<unknown> } = {}): Harness {
  const { definition, page } = load();
  assert.equal(definition.id, "cursor-to-dsh");
  if (options.boot !== undefined) page.__DSH_CURSOR_TO_DSH__ = options.boot;
  const plugin = definition.factory((specifier: string) => {
    assert.equal(specifier, "react");
    return react;
  });
  const written: Harness["written"] = [];
  const removed: Harness["removed"] = [];
  const registrations: any[] = [];
  const dictionaries: any[] = [];
  plugin.apply({
    effect: (create: () => unknown) => {
      const disposer = create();
      return typeof disposer === "function" ? disposer : () => {};
    },
    locale: {
      register: (ns: string, dicts: any) => {
        dictionaries.push({ ns, dicts });
        return () => {};
      },
    },
    remote: {
      credentials: {
        set: async (ref: string, value: string) => {
          written.push({ ref, value });
          return (await options.set?.(ref, value)) ?? { ok: true, value: null };
        },
        unset: async (ref: string) => {
          removed.push(ref);
          return (await options.unset?.(ref)) ?? { ok: true, value: null };
        },
      },
    },
    slots: {
      inject: (name: string, callback: () => unknown) => {
        assert.equal(name, "settings.models.provider-card");
        return callback();
      },
      register: (registration: any, component: any) => {
        registrations.push({ registration, component });
        return () => {};
      },
    },
  });
  return { plugin, registrations, dictionaries, written, removed };
}

test("the card registers into the Cursor row's settings namespace", () => {
  const { plugin, registrations, dictionaries } = harness();
  assert.deepEqual([...plugin.inject].sort(), ["locale", "remote", "remote.credentials", "slots"]);
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].ns, "cursor-to-dsh");
  for (const key of Object.keys(dictionaries[0].dicts.zh)) {
    assert.ok(dictionaries[0].dicts.en[key], `en copy for ${key}`);
  }
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].registration.name, "settings.models.provider-card");
  assert.equal(registrations[0].registration.key, "llm-cursor");
  assert.equal(registrations[0].registration.locale, "cursor-to-dsh");
  assert.equal(typeof registrations[0].component, "function");
});

test("saving writes the Host-published reference, not a hard-coded name", async () => {
  const { registrations, written, removed } = harness({ boot: { provider: "cursor", keyRef: "MY_CURSOR_KEY" } });
  const injected = registrations[0].registration.inject();
  assert.equal(injected.keyRef, "MY_CURSOR_KEY");
  const answer = await injected.save("  key_abc  ");
  assert.equal(answer.code, undefined);
  assert.deepEqual(written, [{ ref: "MY_CURSOR_KEY", value: "key_abc" }]);
  await injected.clear();
  assert.deepEqual(removed, ["MY_CURSOR_KEY"]);
});

test("a garbled or foreign published reference falls back to the default", async () => {
  for (const keyRef of ["", "not a ref", "cursor/api@key", 7, null]) {
    const injected = harness({ boot: { provider: "cursor", keyRef } }).registrations[0].registration.inject();
    assert.equal(injected.keyRef, "CURSOR_API_KEY", `falls back for ${JSON.stringify(keyRef)}`);
  }
});

test("the reference falls back to CURSOR_API_KEY when the page predates the row", async () => {
  const { registrations, written } = harness();
  const injected = registrations[0].registration.inject();
  assert.equal(injected.keyRef, "CURSOR_API_KEY");
  await injected.save("key_abc");
  assert.deepEqual(written, [{ ref: "CURSOR_API_KEY", value: "key_abc" }]);
});

test("empty, non-ASCII and Host-refused keys answer with their own codes", async () => {
  const empty = harness().registrations[0].registration.inject();
  assert.equal((await empty.save("   ")).code, "empty");
  assert.equal((await empty.save("key_abc def")).code, "format");
  assert.equal((await empty.save("密钥")).code, "format");
  const refused = harness({ set: async () => ({ ok: false, error: { message: "Credential storage is read-only" } }) })
    .registrations[0].registration.inject();
  const answer = await refused.save("key_abc");
  assert.equal(answer.code, "host");
  assert.equal(answer.message, "Credential storage is read-only");
  const thrown = harness({ set: async () => { throw new Error("offline"); } }).registrations[0].registration.inject();
  assert.equal((await thrown.save("key_abc")).message, "offline");
});
