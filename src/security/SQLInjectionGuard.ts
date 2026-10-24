/**
 * SQLInjectionGuard — SQL injection detection for the query router.
 *
 * Inspects incoming SQL before execution and flags well-known injection
 * patterns.  It is intentionally conservative: it only blocks patterns that
 * are strongly indicative of injection, so legitimate PostgreSQL/SQLite SQL
 * (including the valid `UNION SELECT`) is not rejected outright.
 *
 * Detection categories and their disposition in the router:
 *
 * | Pattern                 | Blocked | Notes                                  |
 * |-------------------------|---------|----------------------------------------|
 * | union-based-injection   | true*   | valid PG SQL; router downgrades to warn|
 * | stacked-query-injection | true    | multiple statements via `;`            |
 * | comment-based-injection | true    | `--` / `#` / C-style comment truncation|
 * | tautology-injection     | true    | `OR 1=1`, `'1'='1` always-true guards  |
 * | time-based-injection    | true    | `SLEEP(...)`, `pg_sleep(...)`          |
 * | error-based-injection   | true    | `EXTRACTVALUE(...)`, `UPDATEXML(...)`  |
 *
 * @module security/SQLInjectionGuard
 */

/** Result of an injection check. */
export interface InjectionCheckResult {
  /** Whether the statement should be blocked. */
  blocked: boolean;
  /** Machine-readable pattern id (present only when blocked). */
  pattern?: string;
  /** Human-readable explanation (present only when blocked). */
  reason?: string;
}

/**
 * A named detection rule: a regex and a human-readable reason.
 */
interface InjectionRule {
  pattern: string;
  regex: RegExp;
  reason: string;
}

/**
 * Matches a `UNION [ALL] SELECT` clause — the classic union-based injection
 * payload.  Also covers `UNION SELECT` without `ALL`.
 */
const UNION_SELECT = /\bUNION\s+(ALL\s+)?SELECT\b/i;

/**
 * Matches stacked queries: a statement terminator `;` followed by another
 * DML/DDL/DCL verb (not a stray semicolon or an empty tail).
 */
const STACKED_QUERY =
  /;\s*(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|DECLARE|BEGIN|COMMIT|ROLLBACK|MERGE)\b/i;

/**
 * Matches SQL comment markers used to truncate the remainder of a query
 * (`--`, `#`, or a C-style block comment).  A block comment is only flagged
 * when it does not span the whole statement (i.e. used to hide a tail).
 *
 * The pg_hint_plan hint marker `/*+` is explicitly exempt: PostgreSQL treats
 * `/*+ SeqScan(t) *​/` as a legitimate planner directive, and QueryHintShim
 * strips it during the rewrite pipeline. Flagging it as comment-truncation
 * injection would break a supported PG feature.
 */
const COMMENT_TRUNCATION = /(--|#|\/\*(?!\+))/;

/**
 * Matches always-true tautologies commonly used in boolean/union injection:
 * `OR 1=1`, `AND 1=1`, `'1'='1'`, `"1"="1"`, `1=1`.
 */
const TAUTOLOGY = /\b(OR|AND)\s+\d+\s*=\s*\d+\b|['"]\s*\d+\s*['"]\s*=\s*['"]\s*\d+\s*['"]|\b\d+\s*=\s*\d+\b/i;

/**
 * Matches time-based blind injection primitives: `SLEEP(...)`, `pg_sleep(...)`,
 * `BENCHMARK(...)`.
 */
const TIME_BASED = /\b(SLEEP|PG_SLEEP|BENCHMARK)\s*\(/i;

/**
 * Matches error-based injection primitives (MySQL/XPath): `EXTRACTVALUE(...)`
 * and `UPDATEXML(...)`.
 */
const ERROR_BASED = /\b(EXTRACTVALUE|UPDATEXML)\s*\(/i;

/**
 * Ordered detection rules.  Order matters: earlier patterns (union) take
 * precedence so the router can apply its union-specific downgrade logic.
 */
const RULES: InjectionRule[] = [
  { pattern: 'union-based-injection', regex: UNION_SELECT, reason: 'UNION SELECT clause detected' },
  { pattern: 'stacked-query-injection', regex: STACKED_QUERY, reason: 'Stacked query (multiple statements) detected' },
  { pattern: 'comment-based-injection', regex: COMMENT_TRUNCATION, reason: 'SQL comment truncation detected' },
  { pattern: 'tautology-injection', regex: TAUTOLOGY, reason: 'Always-true tautology detected' },
  { pattern: 'time-based-injection', regex: TIME_BASED, reason: 'Time-based blind injection primitive detected' },
  { pattern: 'error-based-injection', regex: ERROR_BASED, reason: 'Error-based injection primitive detected' },
];

/**
 * Inspect SQL for known injection patterns.
 *
 * @param sql - The SQL statement to inspect.
 * @returns An {@link InjectionCheckResult}.  `blocked` is `false` (and no
 *   `pattern`/`reason` are set) for benign SQL.
 */
export function checkInjection(sql: string): InjectionCheckResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { blocked: false };
  }

  for (const rule of RULES) {
    if (rule.regex.test(sql)) {
      return { blocked: true, pattern: rule.pattern, reason: rule.reason };
    }
  }

  return { blocked: false };
}

/**
 * SQL injection guard facade (kept for backward compatibility with callers
 * that reference the class).
 */
export class SQLInjectionGuard {
  static check(sql: string): InjectionCheckResult {
    return checkInjection(sql);
  }

  static getInstance(): SQLInjectionGuard {
    return new SQLInjectionGuard();
  }
}
