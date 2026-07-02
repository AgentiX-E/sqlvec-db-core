export function detectPlanExecutorSecurity() { return false; } export function rewritePlanExecutorSecurity(s: string) { return { sql: s, rewritten: false }; }
