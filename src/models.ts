/**
 * Cursor catalog -> DSH model info, and DSH reasoning efforts -> Cursor model params.
 *
 * Cursor describes each model with parameter definitions (`thinking`, `effort`, `fast`,
 * `context`, ...) whose allowed values differ per model. Everything here works from those
 * definitions, so a new model or value needs no code change.
 */
export const PROVIDER_ID = "cursor";

export interface ParamDef {
  id: string;
  values?: ({ value: string } | string)[];
}
export interface Param {
  id: string;
  value: string;
}
export interface CatalogModel {
  id: string;
  displayName?: string;
  parameters?: ParamDef[];
  variants?: unknown[];
}

const LEVEL_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  "extra-high": 5,
  max: 6,
};

function values(def: ParamDef | undefined): string[] {
  return (def?.values ?? []).map((v) => String(typeof v === "object" ? v.value : v));
}

function find(defs: ParamDef[], ...ids: string[]): ParamDef | undefined {
  return defs.find((d) => ids.includes(d?.id));
}

// `thinking` is Claude's on/off switch and must not be mistaken for the effort param.
const effortDef = (defs: ParamDef[]) => find(defs, "effort", "reasoning_effort", "reasoning");

function defsOf(model: any): ParamDef[] {
  const defs = model?.cursorParameters ?? model?.parameters;
  return Array.isArray(defs) ? defs : [];
}

/** Only `auto` is an alias; every other id goes to Cursor unchanged. */
export function resolveModelId(id: string): string {
  return id === "auto" ? "default" : id;
}

function tokens(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
  return m ? Math.round(Number(m[1]) * (m[2].toLowerCase() === "m" ? 1e6 : 1e3)) : undefined;
}

function tiers(def: ParamDef | undefined): { value: string; tokens: number }[] {
  return values(def)
    .map((value) => ({ value, tokens: tokens(value) ?? 0 }))
    .filter((t) => t.tokens > 0)
    .sort((a, b) => a.tokens - b.tokens);
}

/** Plugin `context` config; `DSH_CURSOR_CONTEXT` overrides it. */
let contextPreference = "min";

export function setContextPreference(value: string | undefined): void {
  contextPreference = value?.trim() || "min";
}

/** `min` (default), `max`, or an offered value such as `300k`. Unknown values mean `min`. */
export function preferredContext(
  def: ParamDef | undefined,
  pref = process.env.DSH_CURSOR_CONTEXT ?? contextPreference,
): { value: string; tokens: number } | undefined {
  const all = tiers(def);
  if (!all.length) return undefined;
  const want = pref.trim().toLowerCase();
  if (want === "max") return all[all.length - 1];
  return all.find((t) => t.value.toLowerCase() === want) ?? all[0];
}

/**
 * Cursor lists context tiers some accounts cannot use (`1m` on several Claude models) and
 * rejects the run. Returns `params` with the next smaller offered tier, or undefined.
 */
export function smallerContext(model: any, params: Param[] | undefined): Param[] | undefined {
  const current = params?.find((p) => p.id === "context");
  const size = current && tokens(current.value);
  if (!size) return undefined;
  const next = tiers(find(defsOf(model), "context"))
    .filter((t) => t.tokens < size)
    .pop();
  return next && params!.map((p) => (p.id === "context" ? { id: p.id, value: next.value } : p));
}

export function isRejectedParams(message: unknown): boolean {
  return typeof message === "string" && /invalid parameters for registry model/i.test(message);
}

/** Context tier that worked after a rejection, per model id, for the life of the process. */
export const workingContext = new Map<string, string>();

/** Cursor effort value for a level: exact match, else the nearest lower, else the lowest. */
export function effortFor(offered: string[], level: string): string | undefined {
  const target = LEVEL_RANK[level];
  if (target === undefined) return undefined;
  const ranked = offered.filter((v) => v in LEVEL_RANK).sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b]);
  const exact = ranked.find((v) => LEVEL_RANK[v] === target);
  if (exact) return exact;
  const usable = ranked.filter((v) => v !== "none");
  return usable.filter((v) => LEVEL_RANK[v] < target).pop() ?? usable[0] ?? ranked[0];
}

/**
 * Explicit Cursor params for one request. Without them Cursor picks its own defaults,
 * including Fast (priority pricing) and a smaller context than the catalog offers.
 */
export function modelParams(model: any, reasoning: string | undefined): Param[] | undefined {
  const defs = defsOf(model);
  const params: Param[] = [];
  const off = !reasoning || reasoning === "off";
  if (reasoning === ON) reasoning = "high";

  const thinking = find(defs, "thinking");
  if (thinking && values(thinking).includes(off ? "false" : "true")) {
    params.push({ id: thinking.id, value: off ? "false" : "true" });
  }

  const effort = effortDef(defs);
  if (effort) {
    const offered = values(effort);
    let value: string | undefined;
    if (!off) value = effortFor(offered, reasoning!);
    else if (!thinking) value = offered.includes("none") ? "none" : effortFor(offered, "minimal");
    if (value) params.push({ id: effort.id, value });
  }

  const fast = find(defs, "fast");
  if (fast && values(fast).includes("false")) params.push({ id: fast.id, value: "false" });

  const context = preferredContext(find(defs, "context"));
  if (context) params.push({ id: "context", value: context.value });

  return params.length ? params : undefined;
}

/** Effort id for models whose only reasoning switch is `thinking` on/off. */
export const ON = "on";

const EFFORT_NAMES: Record<string, string> = { off: "Off", on: "On", xhigh: "Extra high", "extra-high": "Extra high" };

function effortName(id: string): string {
  return EFFORT_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * DSH reasoning efforts for a model, least to greatest: Cursor's own effort values, with
 * `off` when the model can turn reasoning off. Undefined for models without reasoning params.
 */
export function reasoningInfo(model: any): { efforts: { id: string; name: string }[]; defaultEffort?: string } | undefined {
  const defs = defsOf(model);
  const thinking = find(defs, "thinking");
  const offered = values(effortDef(defs))
    .filter((v) => v in LEVEL_RANK)
    .sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b]);
  const canOff = offered.includes("none") || values(thinking).includes("false");
  const ids = offered.filter((v) => v !== "none");
  if (!ids.length && thinking) ids.push(ON);
  if (!ids.length) return undefined;
  if (canOff) ids.unshift("off");
  const defaultEffort = ids.includes("high") ? "high" : ids[ids.length - 1];
  return { efforts: ids.map((id) => ({ id, name: effortName(id) })), defaultEffort };
}

/** Display name per model id; names Cursor shares across models (`default` and `auto-smart` are both "Auto") get the id appended. */
export function modelNames(models: CatalogModel[]): Map<string, string> {
  const base = (m: CatalogModel) => m.displayName || m.id;
  const count = new Map<string, number>();
  for (const m of models) count.set(base(m), (count.get(base(m)) ?? 0) + 1);
  return new Map(models.map((m) => [m.id, count.get(base(m))! > 1 ? `${base(m)} (${m.id})` : base(m)]));
}

export function contextWindow(model: any): number {
  return preferredContext(find(defsOf(model), "context"))?.tokens ?? 200_000;
}

/** Shown until the live catalog loads (no key yet, or offline). */
export const FALLBACK_MODELS: CatalogModel[] = [
  { id: "default", displayName: "Cursor Default" },
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
  { id: "gemini-4-argon", displayName: "Gemini 4 Argon" },
];
