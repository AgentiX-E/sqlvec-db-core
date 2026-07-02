export function detectCertMapShim() { return false; } export function rewriteCertMapShim(s: string) { return { sql: s, rewritten: false }; }
