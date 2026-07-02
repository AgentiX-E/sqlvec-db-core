export function detectSetResetShim() { return false; } export function rewriteSetResetShim(s: string) { return { sql: s, rewritten: false }; }
