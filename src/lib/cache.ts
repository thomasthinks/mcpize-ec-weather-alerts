/**
 * Tiny in-memory TTL cache (per tool-query key).
 * Single-process by design: MCPize runs one instance per subscriber.
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export function getCached<T>(key: string): { hit: true; value: T } | { hit: false } {
  const entry = store.get(key);
  if (!entry) return { hit: false };
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return { hit: false };
  }
  return { hit: true, value: entry.value as T };
}

export function setCached(key: string, value: unknown, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  // Lightweight cap so a busy free tier cannot grow memory unboundedly.
  if (store.size > 2000) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
}

/** Test-only: isolate unit tests from each other's cached data. */
export function clearCache(): void {
  store.clear();
}
