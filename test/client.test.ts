import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

/** Minimal element representation for checking the links registered with DSH's slot. */
interface Element {
  tag: string;
  props: { href?: string } | null;
  children: (Element | string)[];
}

test("the usage client requests slots and renders both official links on its bundle page", () => {
  let client: any;
  runInNewContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), {
    document: { documentElement: { lang: "zh-CN" } },
    window: {
      __ModuleLoader__: {
        load({ factory }: any) {
          client = factory(() => ({
            createElement: (tag: string, props: Element["props"], ...children: Element["children"]): Element =>
              ({ tag, props, children }),
          }));
        },
      },
    },
  });

  assert.deepEqual(Array.from(client.inject), ["slots"]);
  let render!: (props: { subject: { kind: string; pkg: { name: string } } }) => Element | null;
  client.apply({
    slots: {
      inject(name: string, register: () => void) {
        assert.equal(name, "plugins.detail.section");
        register();
      },
      register(meta: { name: string }, callback: typeof render) {
        assert.equal(meta.name, "plugins.detail.section");
        render = callback;
      },
    },
  });

  assert.equal(render({ subject: { kind: "bundle", pkg: { name: "other" } } }), null);
  const section = render({ subject: { kind: "bundle", pkg: { name: "cursor-to-dsh" } } })!;
  const list = section.children[1] as Element;
  assert.deepEqual(list.children.map((item) => ((item as Element).children[0] as Element).props?.href), [
    "https://cursor.com/dashboard/spending",
    "https://grok.com/dashboard",
  ]);
});
