export function detectQueryHintShim() { return false; } export function rewriteQueryHintShim(s: string) { return { sql: s, rewritten: false }; }
