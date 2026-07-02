export function detectPgStatCollector() { return false; } export function rewritePgStatCollector(s: string) { return { sql: s, rewritten: false }; }
