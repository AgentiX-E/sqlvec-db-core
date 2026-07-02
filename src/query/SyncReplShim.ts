export function detectSyncReplShim() { return false; } export function rewriteSyncReplShim(s: string) { return { sql: s, rewritten: false }; }
