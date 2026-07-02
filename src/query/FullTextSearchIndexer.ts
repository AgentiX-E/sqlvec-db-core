export function detectFullTextSearchIndexer() { return false; } export function rewriteFullTextSearchIndexer(s: string) { return { sql: s, rewritten: false }; }
