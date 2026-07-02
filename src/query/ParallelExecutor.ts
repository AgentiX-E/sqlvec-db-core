export function detectParallelExecutor() { return false; } export function rewriteParallelExecutor(s: string) { return { sql: s, rewritten: false }; }
