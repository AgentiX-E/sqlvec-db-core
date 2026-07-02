export function detectSerializable() { return false; }
export function rewriteSerializable(s: string) { return { sql: s, rewritten: false }; }
