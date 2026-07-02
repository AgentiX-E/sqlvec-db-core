export function detectPgStatReplicationShim() { return false; } export function rewritePgStatReplicationShim(s: string) { return { sql: s, rewritten: false }; }
