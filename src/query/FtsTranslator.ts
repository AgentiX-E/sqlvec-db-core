export function detectFtsTranslator() { return false; } export function rewriteFtsTranslator(s: string) { return { sql: s, rewritten: false }; }
