export function detectSerializablShim() { return false; } export function rewriteSerializablShim(s: string) { return { sql: s, rewritten: false }; }
