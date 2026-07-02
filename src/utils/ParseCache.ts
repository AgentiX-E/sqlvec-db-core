/**
 * ParseCache — Template-based LRU cache for pgsql-ast-parser calls.
 *
 * Normalizes SQL by replacing literal values with '?' placeholders,
 * then caches and retrieves results keyed by the normalized template.
 * This enables cache hits across queries that differ only in parameter values
 * (e.g. pgbench -M simple sends structurally identical queries with varying values).
 *
 * Thread-safe for Node.js single-thread use (Map is synchronous).
 */

const CACHE_MAX = 512;
const stores = new Map<string, Map<string, unknown>>();

/**
 * Normalize SQL by replacing literal values with '?' placeholders.
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/(?<=\s|^|,|\(|=|>|<|!)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|$|,|\)|;)/g, '?')
    .replace(/'[^']*(?:''[^']*)*'/g, "'?'")
    .replace(/\$[^$]*\$[^$]*\$[^$]*\$/g, '?')
    .replace(/\b(true|false)\b/gi, '?')
    .replace(/\bNULL\b/gi, '?')
    .replace(/\?\s*\?/g, '?');
}

/**
 * Get or create a named cache store.
 */
function getStore(name: string): Map<string, unknown> {
  let store = stores.get(name);
  if (!store) {
    store = new Map<string, unknown>();
    stores.set(name, store);
  }
  return store;
}

/**
 * Retrieve a cached value by SQL template.
 * Returns undefined on cache miss.
 */
export function cacheGet<T>(cacheName: string, sql: string): T | undefined {
  const norm = normalizeSql(sql);
  const store = getStore(cacheName);
  return store.get(norm) as T | undefined;
}

/**
 * Store a value in the cache, keyed by SQL template.
 * Evicts oldest entry when at capacity.
 */
export function cacheSet<T>(cacheName: string, sql: string, value: T): void {
  const norm = normalizeSql(sql);
  const store = getStore(cacheName);
  if (store.size >= CACHE_MAX) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
  }
  store.set(norm, value);
}

/**
 * Clear a named cache store (useful in tests).
 */
export function cacheClear(cacheName: string): void {
  stores.delete(cacheName);
}

/**
 * Clear all cache stores.
 */
export function cacheClearAll(): void {
  stores.clear();
}
