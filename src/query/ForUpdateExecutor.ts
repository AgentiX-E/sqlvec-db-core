export function detectForUpdateExecutor() { return false; } export function rewriteForUpdateExecutor(s: string) { return { sql: s, rewritten: false }; }
