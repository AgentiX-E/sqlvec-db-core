export function detectDMLTriggerManager() { return false; } export function rewriteDMLTriggerManager(s: string) { return { sql: s, rewritten: false }; }
