export function detectFuzzystrmatchShim() { return false; } export function rewriteFuzzystrmatchShim(s: string) { return { sql: s, rewritten: false }; }
