export function detectScopedConnection() { return false; } export function rewriteScopedConnection(s: string) { return { sql: s, rewritten: false }; }
