export function detectPgDumpCompatibilityShim() { return false; } export function rewritePgDumpCompatibilityShim(s: string) { return { sql: s, rewritten: false }; }
