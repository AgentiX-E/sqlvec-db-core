export function detectPgCronShim() { return false; } export function rewritePgCronShim(s: string) { return { sql: s, rewritten: false }; }
