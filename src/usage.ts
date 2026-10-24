/**
 * Cursor usage -> DSH usage.
 *
 * Cursor reports one cumulative usage per run, at its end, summed over every model call in
 * it, and its `inputTokens` already include cache reads and writes. DSH reads disjoint
 * buckets as one request: `inputTokens + cacheReadTokens + cacheWriteTokens` is the context
 * fill, and a `totalTokens` that disagrees with the buckets is discarded, so it is omitted.
 */
import type { TokenUsage } from "./reply.ts";

export interface CursorUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Disjoint buckets; Cursor counts cache tokens inside `inputTokens`. */
export function buckets(u: CursorUsage) {
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  const input = Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite);
  const output = u.outputTokens ?? 0;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** Tokens Cursor adds on top of the transcript (its own prompt and rules), per model id. */
const overhead = new Map<string, number>();

export function cursorOverhead(modelId: string): number {
  return overhead.get(modelId) ?? 0;
}

/** Test hook. */
export function resetCursorOverhead(): void {
  overhead.clear();
}

/** A single-call run is one exact request, so its gap to the transcript estimate is Cursor's share. */
export function calibrateOverhead(modelId: string, usage: CursorUsage | undefined, transcriptTokens: number): void {
  if (usage) overhead.set(modelId, Math.max(0, buckets(usage).total - transcriptTokens));
}

/**
 * DSH usage for a finished run.
 *
 * A single-call run is reported as is. A multi-call run includes calls DSH never sees, so its
 * cumulative input is no context size: the input buckets keep their ratio but are scaled to
 * `estimatedContext`, and output is the run's real output.
 */
export function runUsage(usage: CursorUsage | undefined, calls: number, estimatedContext: number): TokenUsage | undefined {
  if (!usage) return undefined;
  const b = buckets(usage);
  let { input, cacheRead, cacheWrite } = b;
  const prompt = input + cacheRead + cacheWrite;
  if (calls > 1 && estimatedContext > 0 && prompt > 0) {
    const fit = estimatedContext / prompt;
    cacheRead = Math.round(cacheRead * fit);
    cacheWrite = Math.round(cacheWrite * fit);
    input = Math.max(0, estimatedContext - cacheRead - cacheWrite);
  }
  return { inputTokens: input, outputTokens: b.output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}
