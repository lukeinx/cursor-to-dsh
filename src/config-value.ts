/** Read a Schemastery volatile field or a plain value. */

export function cfgGet<T>(value: T | { get?: () => T } | undefined | null): T | undefined {
  if (value == null) return undefined;
  if (typeof value === "object" && typeof (value as { get?: unknown }).get === "function") {
    try {
      return (value as { get: () => T }).get();
    } catch {
      return undefined;
    }
  }
  return value as T;
}

export function cfgString(value: unknown, fallback = ""): string {
  const raw = cfgGet(value as any);
  return typeof raw === "string" ? raw : fallback;
}

export function cfgBool(value: unknown, fallback = false): boolean {
  const raw = cfgGet(value as any);
  return typeof raw === "boolean" ? raw : fallback;
}
