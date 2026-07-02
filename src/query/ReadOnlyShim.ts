export function detectReadOnlyShim() { return false; } export function rewriteReadOnlyShim(s: string) { return { sql: s, rewritten: false }; }
