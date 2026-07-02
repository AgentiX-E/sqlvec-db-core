export function detectQueryCacheShim() { return false; } export function rewriteQueryCacheShim(s: string) { return { sql: s, rewritten: false }; }
