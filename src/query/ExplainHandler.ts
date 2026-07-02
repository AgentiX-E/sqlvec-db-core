export function detectExplainHandler() { return false; } export function rewriteExplainHandler(s: string) { return { sql: s, rewritten: false }; }
