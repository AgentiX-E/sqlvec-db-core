export function detectParallelQueryExecutor() { return false; } export function rewriteParallelQueryExecutor(s: string) { return { sql: s, rewritten: false }; }
