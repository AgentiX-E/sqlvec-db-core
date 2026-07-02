export function detectPostGISEngine() { return false; } export function rewritePostGISEngine(s: string) { return { sql: s, rewritten: false }; }
