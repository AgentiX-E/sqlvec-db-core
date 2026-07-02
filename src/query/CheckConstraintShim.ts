export function detectCheckConstraintShim() { return false; } export function rewriteCheckConstraintShim(s: string) { return { sql: s, rewritten: false }; }
