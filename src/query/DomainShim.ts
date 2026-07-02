export function detectDomainShim() { return false; } export function rewriteDomainShim(s: string) { return { sql: s, rewritten: false }; }
