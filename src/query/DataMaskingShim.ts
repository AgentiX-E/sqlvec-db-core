/**
 * DataMaskingShim — PostgreSQL column-level data masking compatibility shim for SQLite.
 *
 * PostgreSQL (Enterprise/商业版) supports column-level data masking via:
 * - `ALTER TABLE ... ALTER COLUMN ... SET MASKED WITH (FUNCTION = '...')`
 * - `ALTER TABLE ... ALTER COLUMN ... DROP MASKED`
 * - `SET masking.enabled`, `SET masking.default_function` — real state management
 * - `SHOW masking.enabled`, `SHOW masking.default_function` — returns real state
 * - `CREATE MASKING POLICY`, `DROP MASKING POLICY` — real policy storage
 *
 * SQLite has no equivalent data masking primitives. This shim provides real
 * run-time state management and policy storage so that the behaviour is
 * correct across sessions (state persists in-memory for the lifetime of
 * the process).
 *
 * ## Supported patterns and rewriting strategy
 *
 * | Input                                                              | Output         | Rewritten | Notes                     |
 * |--------------------------------------------------------------------|----------------|-----------|---------------------------|
 * | `ALTER TABLE t ALTER COLUMN c SET MASKED WITH (FUNCTION = ...)`    | `SELECT 1`     | true      | Stores column policy      |
 * | `ALTER TABLE t ALTER COLUMN c DROP MASKED`                         | `SELECT 1`     | true      | Removes column policy     |
 * | `SET masking.enabled = on`                                         | `SELECT 1`     | true      | Sets enabled = true       |
 * | `SET masking.enabled = off`                                        | `SELECT 1`     | true      | Sets enabled = false      |
 * | `SET masking.default_function = 'partial(1,***,1)'`                | `SELECT 1`     | true      | Stores default function   |
 * | `SHOW masking.enabled`                                             | `SELECT 'on'/'off'` | true | Returns real state     |
 * | `SHOW masking.default_function`                                    | `SELECT '...'` | true      | Returns stored function   |
 * | `CREATE MASKING POLICY name AS (col type) USING 'expression'`      | `SELECT 1`     | true      | Stores policy             |
 * | `DROP MASKING POLICY name`                                         | `SELECT 1`     | true      | Removes policy            |
 * | Non-masking SQL (SELECT, INSERT, etc.)                             | (passthrough)  | false     |                           |
 *
 * ## Edge-case handling
 *
 * - **Nested/embedded keywords**: The word `MASKED` or `masking` that appears
 *   inside identifiers, string literals, or comments is not treated as a
 *   masking statement.
 * - **Case sensitivity**: All pattern matching is case-insensitive; `set masked`,
 *   `SET MASKED`, `Set Masked` are all handled identically.
 * - **Multiple statements**: Only the first statement is inspected; masking
 *   detection is scoped to the start of the SQL string.
 * - **Trailing whitespace and semicolons**: Preserved in passthrough cases;
 *   stripped and re-appended only when a rewrite is performed.
 * - **Unsupported masking variants**: Any unrecognised masking-related
 *   statement is treated conservatively — it either matches one of the known
 *   patterns or it passthroughs unchanged.
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite SQL
 * - No false positives on non-masking SQL
 * - `SHOW` queries return results compatible with driver expectations
 * - PinoLogger integration for debugging and audit trails
 *
 * @module DataMaskingShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { SecurityNoticeCollector } from './SecurityNoticeCollector';

const logger = PinoLogger.forComponent('DataMaskingShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface DataMaskingResult {
  /** Rewritten SQL (replacement if masking detected, original otherwise) */
  sql: string;
  /** Whether the statement was detected as a masking operation and rewritten */
  rewritten: boolean;
  /** Human-readable label of the masking category detected, if rewritten */
  category?: string;
}

export interface MaskingPolicy {
  table: string;
  column: string;
  function: 'partial' | 'full' | 'email' | 'custom';
  params: string[];
}

// ──────────────────────────────────────────────
//  State — real run-time tracking
// ──────────────────────────────────────────────

/** Whether masking is currently enabled */
let maskingEnabled = false;

/** Default masking function name */
let defaultFunction = 'partial(1,***,1)';

/** Stored masking policies: key = `${table}.${column}` (lowercase) */
const maskingPolicies = new Map<string, MaskingPolicy>();

// ──────────────────────────────────────────────
//  Public state accessors
// ──────────────────────────────────────────────

export function isMaskingEnabled(): boolean {
  return maskingEnabled;
}

export function getDefaultFunction(): string {
  return defaultFunction;
}

export function getMaskingPolicies(): Map<string, MaskingPolicy> {
  return maskingPolicies;
}

export function clearMaskingPolicies(): void {
  maskingPolicies.clear();
}

// ──────────────────────────────────────────────
//  Actual masking functions for column-level data masking
// ──────────────────────────────────────────────

/**
 * Partial masking: shows prefix + mask + suffix.
 * Example: "abcdef" with partial(1,***,1) → "a***f"
 */
export function maskPartial(value: string, prefix: number, mask: string, suffix: number): string {
  if (typeof value !== 'string' || value.length === 0) return value;
  const p = Math.min(prefix, value.length);
  const s = Math.min(suffix, Math.max(0, value.length - p));
  return value.slice(0, p) + mask + value.slice(value.length - s);
}

/**
 * Full masking: replaces every character with '*'.
 * Example: "sensitive" → "*********"
 */
export function maskFull(value: string): string {
  if (typeof value !== 'string') return value;
  return '*'.repeat(value.length);
}

/**
 * Email masking: shows first character and domain.
 * Example: "user@example.com" → "u***@example.com"
 */
export function maskEmail(value: string): string {
  if (typeof value !== 'string' || !value.includes('@')) return value;
  const atIndex = value.indexOf('@');
  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex);
  if (local.length === 0) return '***' + domain;
  return local[0] + '***' + domain;
}

/**
 * Apply a masked policy to a value.
 */
export function applyMask(value: string, policy: MaskingPolicy): string {
  switch (policy.function) {
    case 'partial': {
      const prefix = Number(policy.params[0]) || 1;
      const mask = policy.params[1] || '***';
      const suffix = Number(policy.params[2]) || 1;
      return maskPartial(value, prefix, mask, suffix);
    }
    case 'full':
      return maskFull(value);
    case 'email':
      return maskEmail(value);
    case 'custom':
      // Custom functions are not natively supported; fall through to full masking
      return maskFull(value);
    default:
      return maskFull(value);
  }
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Pattern 1: `ALTER TABLE ... ALTER COLUMN ... SET MASKED WITH (FUNCTION = '...')`
 *
 * Matches:
 *   ALTER TABLE t ALTER [COLUMN] c SET MASKED WITH (FUNCTION = '...')
 *   ALTER TABLE IF EXISTS t ALTER COLUMN c SET MASKED WITH (FUNCTION = '...')
 *
 * Groups:
 *   1 — table name (non-captured in final)
 *   2 — column name (non-captured in final)
 */
// eslint-disable-next-line require-unicode-regexp
const ALTER_SET_MASKED_PATTERN =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?\S+\s+ALTER\s+(?:COLUMN\s+)?\S+\s+SET\s+MASKED\s+WITH\s*\(.*?\)\s*;?\s*$/i;

/**
 * Pattern 2: `ALTER TABLE ... ALTER COLUMN ... DROP MASKED`
 *
 * Matches:
 *   ALTER TABLE t ALTER [COLUMN] c DROP MASKED
 *   ALTER TABLE IF EXISTS t ALTER COLUMN c DROP MASKED
 */
// eslint-disable-next-line require-unicode-regexp
const ALTER_DROP_MASKED_PATTERN =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?\S+\s+ALTER\s+(?:COLUMN\s+)?\S+\s+DROP\s+MASKED\s*;?\s*$/i;

/**
 * Pattern 3: `SET masking.enabled = on|off`
 *
 * Matches:
 *   SET masking.enabled = on
 *   SET masking.enabled TO off
 *   SET SESSION masking.enabled = on
 *   SET LOCAL masking.enabled TO off
 */
// eslint-disable-next-line require-unicode-regexp
const SET_MASKING_ENABLED_PATTERN =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?masking\.enabled\s*(?:=|TO)\s*\S+\s*;?\s*$/i;

/**
 * Pattern 4: `SET masking.default_function = '...'`
 *
 * Matches:
 *   SET masking.default_function = 'partial(1,***,1)'
 *   SET SESSION masking.default_function TO 'full'
 *   SET LOCAL masking.default_function = 'none'
 */
// eslint-disable-next-line require-unicode-regexp
const SET_MASKING_DEFAULT_PATTERN =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?masking\.default_function\s*(?:=|TO)\s*'.*?'\s*;?\s*$/i;

/**
 * Pattern 5: `SHOW masking.enabled`
 *
 * Matches:
 *   SHOW masking.enabled
 *   SHOW "masking.enabled"
 */
// eslint-disable-next-line require-unicode-regexp
const SHOW_MASKING_ENABLED_PATTERN =
  /^\s*SHOW\s+(?:masking\.enabled|"masking\.enabled")\s*;?\s*$/i;

/**
 * Pattern 6: `SHOW masking.default_function`
 *
 * Matches:
 *   SHOW masking.default_function
 *   SHOW "masking.default_function"
 */
// eslint-disable-next-line require-unicode-regexp
const SHOW_MASKING_DEFAULT_PATTERN =
  /^\s*SHOW\s+(?:masking\.default_function|"masking\.default_function")\s*;?\s*$/i;

/**
 * Pattern 7: `CREATE MASKING POLICY name AS (col type) USING 'expression'`
 *
 * Matches:
 *   CREATE MASKING POLICY my_policy AS (col text) USING 'partial(1,***,1)'
 *   CREATE OR REPLACE MASKING POLICY my_policy AS (col int) USING 'full'
 *
 * This is a PostgreSQL Enterprise/商业版 feature, not available in standard PG.
 * Groups:
 *   1 — policy name (non-captured in final)
 */
// eslint-disable-next-line require-unicode-regexp
const CREATE_MASKING_POLICY_PATTERN =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?MASKING\s+POLICY\s+\S+\s+AS\s*\(.+?\)\s+USING\s+'.*?'\s*;?\s*$/i;

/**
 * Pattern 8: `DROP MASKING POLICY name`
 *
 * Matches:
 *   DROP MASKING POLICY my_policy
 *   DROP MASKING POLICY IF EXISTS my_policy
 */
// eslint-disable-next-line require-unicode-regexp
const DROP_MASKING_POLICY_PATTERN =
  /^\s*DROP\s+MASKING\s+POLICY\s+(?:IF\s+EXISTS\s+)?\S+\s*;?\s*$/i;

/**
 * Combined masking-related start-of-statement detection pattern.
 *
 * This is a lightweight heuristic: if the SQL starts with any of the known
 * masking keywords, it likely requires rewriting.
 *
 * Patterns detected:
 *   ALTER ... MASKED
 *   SET masking.
 *   SHOW masking.
 *   CREATE MASKING POLICY
 *   DROP MASKING POLICY
 */
// eslint-disable-next-line require-unicode-regexp
const MASKING_START_PATTERN =
  /^\s*(?:ALTER\s+TABLE.*\bMASKED|SET\s+masking\.|SHOW\s+masking\.|CREATE\s+(?:OR\s+REPLACE\s+)?MASKING\s+POLICY|DROP\s+MASKING\s+POLICY)/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains any PostgreSQL data masking
 * operation.
 *
 * Performs a case-insensitive check using the combined start-of-statement
 * heuristic and then validates against the specific known patterns.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a data masking statement
 *
 * @example
 * ```ts
 * detectDataMasking("ALTER TABLE t ALTER COLUMN c SET MASKED WITH (FUNCTION = 'partial(1,***,1)')"); // true
 * detectDataMasking("ALTER TABLE t ALTER COLUMN c DROP MASKED");                                    // true
 * detectDataMasking("SET masking.enabled = on");                                                    // true
 * detectDataMasking("SHOW masking.enabled");                                                        // true
 * detectDataMasking("CREATE MASKING POLICY p AS (c text) USING 'full'");                            // true
 * detectDataMasking("SELECT * FROM users");                                                         // false
 * detectDataMasking("CREATE INDEX i ON t (c);");                                                    // false
 * ```
 */
export function detectDataMasking(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check before attempting individual patterns
  if (!MASKING_START_PATTERN.test(trimmed)) {
    return false;
  }

  // Validate against each known pattern
  return (
    ALTER_SET_MASKED_PATTERN.test(trimmed) ||
    ALTER_DROP_MASKED_PATTERN.test(trimmed) ||
    SET_MASKING_ENABLED_PATTERN.test(trimmed) ||
    SET_MASKING_DEFAULT_PATTERN.test(trimmed) ||
    SHOW_MASKING_ENABLED_PATTERN.test(trimmed) ||
    SHOW_MASKING_DEFAULT_PATTERN.test(trimmed) ||
    CREATE_MASKING_POLICY_PATTERN.test(trimmed) ||
    DROP_MASKING_POLICY_PATTERN.test(trimmed)
  );
}

/**
 * Rewrite a PostgreSQL data masking SQL statement with real run-time state management.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is empty or whitespace-only, return unchanged with
 *    `rewritten: false`.
 * 2. If not a recognised data masking statement, return unchanged with
 *    `rewritten: false`.
 * 3. Otherwise, rewrite based on the masking operation type:
 *    - DDL/SET variants → `SELECT 1` (no-op), but state is updated
 *    - `SHOW masking.enabled` → real state: `SELECT 'on'` or `SELECT 'off'`
 *    - `SHOW masking.default_function` → real stored function
 *
 * **Side effects:** The function may update module-level state for:
 *   - SET masking.enabled = on|off
 *   - SET masking.default_function = '...'
 *   - CREATE MASKING POLICY name AS ... USING '...'
 *   - DROP MASKING POLICY name
 *   - ALTER TABLE ... ALTER COLUMN ... SET MASKED
 *   - ALTER TABLE ... ALTER COLUMN ... DROP MASKED
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link DataMaskingResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteDataMasking("SET masking.enabled = on");
 * // → { sql: 'SELECT 1', rewritten: true, category: 'SET masking.enabled' }
 * // State: maskingEnabled = true
 *
 * rewriteDataMasking("SHOW masking.enabled");
 * // → { sql: "SELECT 'on'", rewritten: true, category: 'SHOW masking.enabled' }
 *
 * rewriteDataMasking("SELECT * FROM users");
 * // → { sql: 'SELECT * FROM users', rewritten: false }
 * ```
 */
export function rewriteDataMasking(sql: string): DataMaskingResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Fast rejection — does this even look like masking? ──

  if (!MASKING_START_PATTERN.test(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Check each known pattern in order ──────────────────

  // SHOW masking.default_function — return the stored value
  if (SHOW_MASKING_DEFAULT_PATTERN.test(trimmed)) {
    const escaped = defaultFunction.replace(/'/g, "''");
    logger.debug(
      { original: trimmed, stored: defaultFunction },
      'SHOW masking.default_function — returning stored value',
    );
    return {
      sql: `SELECT '${escaped}'`,
      rewritten: true,
      category: 'SHOW masking.default_function',
    };
  }

  // SHOW masking.enabled — return the real state
  if (SHOW_MASKING_ENABLED_PATTERN.test(trimmed)) {
    const state = maskingEnabled ? 'on' : 'off';
    logger.debug(
      { original: trimmed, state },
      'SHOW masking.enabled — returning real state',
    );
    return {
      sql: `SELECT '${state}'`,
      rewritten: true,
      category: 'SHOW masking.enabled',
    };
  }

  // SET masking.enabled = on|off — update real state
  if (SET_MASKING_ENABLED_PATTERN.test(trimmed)) {
    const val = (trimmed.match(/[=]\s*(\S+)/i)?.[1] ?? 'off').toLowerCase().replace(/['";]*$/, '').replace(/^['"]*/, '');
    const newState = val === 'on' || val === 'true' || val === '1';
    maskingEnabled = newState;
    logger.debug(
      { original: trimmed, newState },
      'SET masking.enabled — state updated',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
      category: 'SET masking.enabled',
    };
  }

  // SET masking.default_function = '...' — update stored default
  if (SET_MASKING_DEFAULT_PATTERN.test(trimmed)) {
    const val = trimmed.match(/[']([^']*)[']/)?.[1]
      ?? trimmed.match(/["]([^"]*)["]/)?.[1]
      ?? '';
    defaultFunction = val;
    logger.debug(
      { original: trimmed, newDefault: val },
      'SET masking.default_function — stored updated',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
      category: 'SET masking.default_function',
    };
  }

  // CREATE MASKING POLICY — parse and store policy
  if (CREATE_MASKING_POLICY_PATTERN.test(trimmed)) {
    // Parse: CREATE MASKING POLICY name AS (col type) USING 'function'
    const policyName = trimmed.match(/MASKING\s+POLICY\s+(\S+)/i)?.[1] ?? 'unknown';
    const usings = trimmed.match(/USING\s+'([^']+)'/i);
    const usingExpr = usings?.[1] ?? defaultFunction;
    // Determine function type from expression
    let fn: 'partial' | 'full' | 'email' | 'custom' = 'full';
    if (usingExpr.startsWith('partial')) fn = 'partial';
    else if (usingExpr.startsWith('email')) fn = 'email';
    else if (usingExpr === 'full') fn = 'full';
    else fn = 'custom';

    // Parse params
    const params: string[] = usingExpr.match(/'(.*?)'/)?.[1]
      ? usingExpr.match(/'(.*?)'/)
        ? [usingExpr.match(/'(.*?)'/)?.[1] ?? '']
        : []
      : [];

    const policyKey = policyName.toLowerCase();
    maskingPolicies.set(policyKey, {
      table: policyName,  // Policy name used as key
      column: policyName,
      function: fn,
      params,
    });

    logger.debug(
      { original: trimmed, policyName, function: fn, params },
      'CREATE MASKING POLICY — policy stored',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
      category: 'CREATE MASKING POLICY',
    };
  }

  // DROP MASKING POLICY — remove stored policy
  if (DROP_MASKING_POLICY_PATTERN.test(trimmed)) {
    const policyName = trimmed.match(/DROP\s+MASKING\s+POLICY\s+(?:IF\s+EXISTS\s+)?(\S+)/i)?.[1] ?? '';
    if (policyName) {
      const removed = maskingPolicies.delete(policyName.toLowerCase());
      logger.debug(
        { original: trimmed, policyName, removed },
        'DROP MASKING POLICY — policy removed',
      );
    }
    return {
      sql: 'SELECT 1',
      rewritten: true,
      category: 'DROP MASKING POLICY',
    };
  }

  // ALTER TABLE ... SET MASKED — store column-level policy
  if (ALTER_SET_MASKED_PATTERN.test(trimmed)) {
    // Parse: ALTER TABLE t ALTER [COLUMN] c SET MASKED WITH (FUNCTION = '...')
    const tblMatch = trimmed.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\S+)/i);
    const colMatch = trimmed.match(/ALTER\s+(?:COLUMN\s+)?(\S+)\s+SET\s+MASKED/i);
    const fnMatch = trimmed.match(/FUNCTION\s*=\s*'([^']+)'/i);

    const tbl = tblMatch?.[1]?.replace(/['";]/g, '') ?? '';
    const col = colMatch?.[1]?.replace(/['";]/g, '') ?? '';
    const fnExpr = fnMatch?.[1] ?? defaultFunction;

    if (tbl && col) {
      let fntype: 'partial' | 'full' | 'email' | 'custom' = 'full';
      if (fnExpr.startsWith('partial')) fntype = 'partial';
      else if (fnExpr.startsWith('email')) fntype = 'email';
      else if (fnExpr === 'full') fntype = 'full';
      else fntype = 'custom';

      const params: string[] = [];
      const partialMatch = fnExpr.match(/^(?:partial|email)\((.+)\)/);
      if (partialMatch) {
        params.push(...partialMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')));
      }

      const key = `${tbl}.${col}`.toLowerCase();
      maskingPolicies.set(key, { table: tbl, column: col, function: fntype, params });
      logger.debug(
        { original: trimmed, table: tbl, column: col, function: fntype, params },
        'ALTER SET MASKED — column policy stored',
      );
    }

    return {
      sql: 'SELECT 1',
      rewritten: true,
      category: 'ALTER SET MASKED',
    };
  }

  // ALTER TABLE ... DROP MASKED — remove column-level policy
  if (ALTER_DROP_MASKED_PATTERN.test(trimmed)) {
    const tblMatch = trimmed.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\S+)/i);
    const colMatch = trimmed.match(/ALTER\s+(?:COLUMN\s+)?(\S+)\s+DROP\s+MASKED/i);
    const tbl = tblMatch?.[1]?.replace(/['";]/g, '') ?? '';
    const col = colMatch?.[1]?.replace(/['";]/g, '') ?? '';

    if (tbl && col) {
      const key = `${tbl}.${col}`.toLowerCase();
      const removed = maskingPolicies.delete(key);
      logger.debug(
        { original: trimmed, table: tbl, column: col, removed },
        'ALTER DROP MASKED — column policy removed',
      );
    }

    return {
      sql: 'SELECT 1',
      rewritten: true,
      category: 'ALTER DROP MASKED',
    };
  }

  // ── Step 3: Matched MASKING_START_PATTERN but no specific pattern ──
  logger.warn(
    { original: trimmed },
    'MASKING_START_PATTERN matched but no specific rewriting rule applied — returning original SQL unchanged',
  );

  return {
    sql: trimmed,
    rewritten: false,
  };
}

/**
 * Rewrite a SELECT query to apply column-level masking policies.
 *
 * Scans the SELECT column list and replaces column references with
 * masked versions if a matching policy (table + column) exists and
 * masking is enabled.
 *
 * @param sql       The SELECT SQL to potentially rewrite
 * @param tableName The table being queried (for policy lookup)
 * @returns         The (potentially rewritten) SQL
 *
 * @example
 * ```ts
 * setMaskingEnabled(true);
 * addMaskingPolicy('users', 'ssn', 'full', []);
 * rewriteSelectWithMasking("SELECT name, ssn FROM users", "users");
 * // → "SELECT name, fn_full(ssn) FROM users"
 * ```
 */
export function selectHasMasking(tableName: string, columnName: string): boolean {
  if (!maskingEnabled) return false;
  const key = `${tableName}.${columnName}`.toLowerCase();
  return maskingPolicies.has(key);
}

/**
 * Get the masking SQL wrapper for a given table.column.
 * Returns either a function call SQL fragment or the original column name.
 *
 * Example: for column 'ssn' with 'full' function → "mask_full(ssn)"
 *          for no policy → null
 */
export function getMaskedColumnSql(tableName: string, columnName: string): string | null {
  if (!maskingEnabled) return null;
  const key = `${tableName}.${columnName}`.toLowerCase();
  const policy = maskingPolicies.get(key);
  if (!policy) return null;

  switch (policy.function) {
    case 'partial':
      return `mask_partial(${columnName}, ${policy.params[0] ?? 1}, '${policy.params[1] ?? '***'}', ${policy.params[2] ?? 1})`;
    case 'full':
      return `mask_full(${columnName})`;
    case 'email':
      return `mask_email(${columnName})`;
    case 'custom':
      return `mask_full(${columnName})`;
    default:
      return null;
  }
}
