export function detectPgCronExecutor() { return false; } export function rewritePgCronExecutor(s: string) { return { sql: s, rewritten: false }; }
