export function detectEncryptionPolicyShim() { return false; } export function rewriteEncryptionPolicyShim(s: string) { return { sql: s, rewritten: false }; }
