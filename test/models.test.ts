import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contextWindow,
  effortFor,
  isRejectedParams,
  modelParams,
  preferredContext,
  reasoningInfo,
  resolveModelId,
  setContextPreference,
  smallerContext,
} from "../src/models.ts";

const v = (...values: string[]) => values.map((value) => ({ value }));
const claude = [
  { id: "thinking", values: v("true", "false") },
  { id: "effort", values: v("low", "medium", "high", "extra-high", "max") },
  { id: "fast", values: v("true", "false") },
  { id: "context", values: v("200k", "1m") },
];

test("only auto is aliased", () => {
  assert.equal(resolveModelId("auto"), "default");
  assert.equal(resolveModelId("claude-opus-5-5"), "claude-opus-5-5");
});

test("Claude: thinking switch on, effort mapped, Fast off, smallest context", () => {
  assert.deepEqual(modelParams({ cursorParameters: claude }, "extra-high"), [
    { id: "thinking", value: "true" },
    { id: "effort", value: "extra-high" },
    { id: "fast", value: "false" },
    { id: "context", value: "200k" },
  ]);
  assert.deepEqual(modelParams({ cursorParameters: claude }, "off"), [
    { id: "thinking", value: "false" },
    { id: "fast", value: "false" },
    { id: "context", value: "200k" },
  ]);
});

test("effort-only models map off to none and missing levels to the nearest lower", () => {
  const gpt = [{ id: "reasoning_effort", values: v("none", "low", "medium", "high") }];
  assert.deepEqual(modelParams({ cursorParameters: gpt }, "off"), [{ id: "reasoning_effort", value: "none" }]);
  assert.deepEqual(modelParams({ cursorParameters: gpt }, "xhigh"), [{ id: "reasoning_effort", value: "high" }]);
  assert.equal(effortFor(["medium", "high"], "minimal"), "medium");
  assert.equal(effortFor([], "high"), undefined);
  assert.equal(modelParams({ cursorParameters: [] }, "high"), undefined);
});

test("context preference: config default, env override, step-down", () => {
  const def = { id: "context", values: v("200k", "300k", "1m") };
  assert.equal(preferredContext(def, "max")?.value, "1m");
  assert.equal(preferredContext(def, "300K")?.value, "300k");
  assert.equal(preferredContext(def, "bogus")?.value, "200k");
  assert.equal(preferredContext(def)?.value, "200k");
  setContextPreference("max");
  try {
    assert.equal(preferredContext(def)?.value, "1m");
    process.env.DSH_CURSOR_CONTEXT = "300k";
    assert.equal(preferredContext(def)?.value, "300k");
  } finally {
    delete process.env.DSH_CURSOR_CONTEXT;
    setContextPreference(undefined);
  }
  const model = { cursorParameters: [def] };
  assert.equal(contextWindow(model), 200_000);
  assert.equal(contextWindow({}), 200_000);
  assert.deepEqual(smallerContext(model, [{ id: "fast", value: "false" }, { id: "context", value: "1m" }]), [
    { id: "fast", value: "false" },
    { id: "context", value: "300k" },
  ]);
  assert.equal(smallerContext(model, [{ id: "context", value: "200k" }]), undefined);
  assert.ok(isRejectedParams('Invalid parameters for registry model: "m"'));
});

test("DSH reasoning efforts follow Cursor's offered values, least to greatest", () => {
  const ids = (m: any) => reasoningInfo(m)?.efforts.map((e) => e.id);
  assert.deepEqual(ids({ parameters: claude }), ["off", "low", "medium", "high", "extra-high", "max"]);
  assert.equal(reasoningInfo({ parameters: claude })?.defaultEffort, "high");
  assert.deepEqual(ids({ parameters: [{ id: "reasoning_effort", values: v("high", "none", "low") }] }), ["off", "low", "high"]);
  assert.deepEqual(ids({ parameters: [{ id: "effort", values: v("medium", "xhigh") }] }), ["medium", "xhigh"]);
  assert.equal(reasoningInfo({ parameters: [{ id: "effort", values: v("medium", "xhigh") }] })?.defaultEffort, "xhigh");
  assert.deepEqual(ids({ parameters: [{ id: "thinking", values: v("true", "false") }] }), ["off", "on"]);
  assert.equal(reasoningInfo({ parameters: [{ id: "fast", values: v("false") }] }), undefined);
  assert.equal(reasoningInfo({ id: "default" }), undefined);
});

test("the `on` effort turns a thinking-only model's switch on", () => {
  const defs = [{ id: "thinking", values: v("true", "false") }];
  assert.deepEqual(modelParams({ cursorParameters: defs }, "on"), [{ id: "thinking", value: "true" }]);
});
