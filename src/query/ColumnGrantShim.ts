export function detectColumnGrantShim() { return false; } export function rewriteColumnGrantShim(s: string) { return { sql: s, rewritten: false }; }
