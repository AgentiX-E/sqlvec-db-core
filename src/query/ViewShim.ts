/**
 * ViewShim — PostgreSQL CREATE VIEW compatibility shim for SQLite.
 *
 * PostgreSQL supports multiple CREATE VIEW variants that SQLite does not:
 *   - CREATE OR REPLACE VIEW
 *   - CREATE RECURSIVE VIEW
 *   - WITH [CASCADED|LOCAL] CHECK OPTION
 *
 * SQLite only supports:
 *   - CREATE VIEW [IF NOT EXISTS] name [(columns)] AS query
 *   - CREATE TEMP VIEW name [(columns)] AS query
 *   - CREATE TEMPORARY VIEW name [(columns)] AS query  (alias for TEMP)
 *
 * Strategy:
 *   1. CREATE OR REPLACE VIEW name [...] AS query → CREATE VIEW IF NOT EXISTS name [...] AS query
 *   2. CREATE RECURSIVE VIEW name [(cols)] AS query → CREATE VIEW name [(cols)] AS query
 *   3. CREATE VIEW ... WITH [CASCADED|LOCAL] CHECK OPTION → CREATE VIEW ... (strip CHECK OPTION)
 *   4. Generate CHECK OPTION enforcement triggers on the base table
 *   5. CREATE VIEW / CREATE TEMP VIEW / CREATE TEMPORARY VIEW → pass through (SQLite compatible)
 *
 * @module ViewShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';
import { protectSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('ViewShim');

// ── Types ────────────────────────────────────────────────────────

export interface ViewResult {
  /** Rewritten SQL statement */
  sql: string;
  /** Whether the SQL was rewritten */
  rewritten: boolean;
  /** Optional CHECK OPTION enforcement trigger SQL statements */
  checkOptionTriggers?: string[];
  /** Optional CHECK OPTION cleanup (DROP TRIGGER) SQL statements */
  checkOptionDropTriggers?: string[];
}

export interface CheckOptionInfo {
  /** Whether CHECK OPTION was found */
  hasCheckOption: boolean;
  /** View name */
  viewName: string;
  /** Query body (everything after AS) */
  queryBody: string;
}

export interface SimpleViewInfo {
  /** Base table name */
  tableName: string;
  /** WHERE condition (empty if no WHERE clause) */
  whereCondition: string;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * Matches: CREATE OR REPLACE VIEW [IF NOT EXISTS] name [(cols)] AS query
 *
 * Groups:
 *   1 — View name (identifier, possibly schema-qualified)
 *   2 — Optional column list, e.g. (col1, col2) (with leading space if present)
 *   3 — Query body (everything after AS)
 */
// A single PostgreSQL identifier: either a bare `ident` or a quoted `"ident"`
// (with `""` as the escape). Quoted identifiers may contain spaces and other
// characters that the bare form cannot (BUG #441).
const IDENT_PART = '(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")*")';
// A (optionally schema-qualified) name: `a`, `s.t`, `"my schema"."my view"`,
// or the mixed form `s."my view"`.
const IDENT_RE = `${IDENT_PART}(?:\\.${IDENT_PART})*`;

const OR_REPLACE_VIEW_RE = new RegExp(
  `^\\s*CREATE\\s+OR\\s+REPLACE\\s+VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT_RE})\\s*(\\([^)]*\\))?\\s+AS\\s+(.*)$`,
  'is',
);

/**
 * Matches: CREATE RECURSIVE VIEW name [(cols)] AS query
 *
 * Groups:
 *   1 — View name (identifier, possibly schema-qualified)
 *   2 — Optional column list, e.g. (col1, col2) (with leading space if present, empty if absent)
 *   3 — Query body (everything after AS)
 */
const RECURSIVE_VIEW_RE = new RegExp(
  `^\\s*CREATE\\s+RECURSIVE\\s+VIEW\\s+(${IDENT_RE})\\s*(\\([^)]*\\))?\\s+AS\\s+(.*)$`,
  'is',
);

/**
 * Matches any CREATE VIEW statement and captures CHECK OPTION if present.
 *
 * Groups:
 *   1 — Optional OR REPLACE
 *   2 — Optional RECURSIVE
 *   3 — View name
 *   4 — Optional column list
 *   5 — Query body (up to optional CHECK OPTION)
 *   6 — CASCADED or LOCAL (within CHECK OPTION, if present)
 */
const CHECK_OPTION_RE = new RegExp(
  `^\\s*CREATE\\s+(OR\\s+REPLACE\\s+)?(RECURSIVE\\s+)?(?:TEMP\\s+|TEMPORARY\\s+)?VIEW\\s+(${IDENT_RE})\\s*(\\([^)]*\\))?\\s+AS\\s+(.+?)(?:\\s+WITH\\s+(?:(CASCADED|LOCAL)\\s+)?CHECK\\s+OPTION)?\\s*;?\\s*$`,
  'is',
);

/**
 * Strips the WITH CHECK OPTION suffix from a CREATE VIEW SQL string.
 * Handles optional CASCADED/LOCAL keyword.
 */
const STRIP_CHECK_OPTION_RE =
  /\s+WITH\s+(?:(CASCADED|LOCAL)\s+)?CHECK\s+OPTION\s*;?\s*$/i;

/**
 * Enhanced regex that captures query body without CHECK OPTION.
 * Used to extract the clean query body from a CREATE VIEW that may have CHECK OPTION.
 */
const VIEW_WITH_CHECK_RE = new RegExp(
  `^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:RECURSIVE\\s+)?(?:TEMP\\s+|TEMPORARY\\s+)?VIEW\\s+(${IDENT_RE})\\s*(\\([^)]*\\))?\\s+AS\\s+(.+?)(?:\\s+WITH\\s+(?:(CASCADED|LOCAL)\\s+)?CHECK\\s+OPTION)?\\s*;?\\s*$`,
  'is',
);

// ── SQL Keywords (for WHERE clause NEW. prefixing) ────────────────

// ── View expansion regex patterns ───────────────────────────────

/**
 * Matches bare table/view references in FROM clauses: `FROM <name>`
 * Group 1 = the table/view name (simple \w+ identifier).
 */
export const VIEW_FROM_RE = /\bFROM\s+(\w+)\b/gi;

/**
 * Matches bare table/view references in JOIN clauses: `JOIN <name>`
 * Group 1 = the table/view name (simple \w+ identifier).
 */
export const VIEW_JOIN_RE = /\bJOIN\s+(\w+)\b/gi;

// ── View expansion ──────────────────────────────────────────────

/**
 * Expand view references in a SELECT query by replacing the view name
 * with its underlying subquery definition.
 *
 * Only operates on SELECT statements. DDL (CREATE/DROP/ALTER) statements
 * pass through unchanged. Only names that have a registered view definition
 * (returned by the provided callback) are expanded.
 *
 * @param sql - The SQL statement to process.
 * @param getViewDefinition - Callback that returns the view SQL for a given name,
 *   or null if the name is not a view.
 * @returns The rewritten SQL with view references expanded (or original if no expansion).
 *
 * @example
 *   expandViewInSql(
 *     'SELECT * FROM active_users',
 *     (name) => name === 'active_users'
 *       ? 'SELECT * FROM users WHERE status = \'active\''
 *       : null
 *   )
 *   // => 'SELECT * FROM (SELECT * FROM users WHERE status = \'active\') AS active_users'
 */
export function expandViewInSql(
  sql: string,
  getViewDefinition: (viewName: string) => string | null,
): string {
  if (!sql || typeof sql !== 'string') {
  /* v8 ignore next -- ?? fallback is defensive default */
    return sql ?? '';
  }

  const trimmed = sql.trim();

  // Only expand in SELECT statements. (DDL such as CREATE/DROP/ALTER cannot
  // start with SELECT, so no separate DDL guard is needed here.)
  if (!/^\s*SELECT\b/i.test(trimmed)) {
    return trimmed;
  }

  // Expand bare table/view references after `FROM` / `JOIN` using a
  // literal-aware scan so that `FROM`/`JOIN` inside string literals or
  // comments are never rewritten (BUG #438). We walk the string only on real
  // SQL tokens (outside literals/comments) and replace `FROM <name>` and
  // `JOIN <name>` where `<name>` is a registered view.
  const parts: string[] = [];
  let cursor = 0;

  // Build a combined scanner over the SQL: find the next FROM/JOIN keyword
  // that is outside a literal, then read the following identifier.
  let i = 0;
  while (i < trimmed.length) {
    const skipped = skipSqlLiteral(trimmed, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    // Match a keyword at (or just after leading whitespace from) position i.
    const rest = trimmed.slice(i);
    const kwMatch = rest.match(/^\s*(FROM|JOIN)\b/i);
    if (kwMatch) {
      const kw = kwMatch[1].toUpperCase();
      // Position of the first char after the keyword (and any leading
      // whitespace). Skip trailing whitespace to reach the table name.
      const afterKw = i + kwMatch[0].length;
      const wsMatch = trimmed.slice(afterKw).match(/^\s+/);
      const nameStart = afterKw + (wsMatch ? wsMatch[0].length : 0);
      const nameMatch = trimmed.slice(nameStart).match(/^[A-Za-z_][A-Za-z0-9_$.]*/);
      if (nameMatch) {
        const tableName = nameMatch[0];
        const viewDef = getViewDefinition(tableName);
        if (viewDef) {
          // Preserve everything up to (and including) the `FROM `/`JOIN `
          // keyword, then replace the bare name with the expanded subquery.
          parts.push(trimmed.slice(cursor, nameStart));
          parts.push(`(${viewDef}) AS ${tableName}`);
          cursor = nameStart + tableName.length;
          i = cursor;
          continue;
        }
      }
    }

    i++;
  }
  if (parts.length === 0) {
    return trimmed;
  }
  parts.push(trimmed.slice(cursor));
  return parts.join('');
}

const SQL_KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'GLOB', 'BETWEEN', 'EXISTS',
  'TRUE', 'FALSE', 'ASC', 'DESC', 'AS', 'ON', 'WHERE', 'FROM', 'HAVING',
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'TABLE', 'VIEW',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'COALESCE', 'IFNULL', 'NULLIF',
  'ALL', 'ANY', 'SOME', 'DISTINCT', 'UNIQUE', 'LIMIT', 'OFFSET', 'ORDER', 'BY',
  'GROUP', 'SET', 'INTO', 'VALUES', 'DEFAULT', 'PRIMARY', 'KEY', 'FOREIGN',
  'REFERENCES', 'CONSTRAINT', 'CHECK', 'INDEX', 'UNION', 'INTERSECT', 'EXCEPT',
  'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'NATURAL', 'JOIN', 'ON',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  // Type names (used in CAST ... AS <type> and column definitions); these must
  // never be prefixed with NEW. (BUG #439).
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'TEXT', 'VARCHAR',
  'CHAR', 'CHARACTER', 'NCHAR', 'NVARCHAR', 'REAL', 'DOUBLE', 'FLOAT',
  'BLOB', 'NUMERIC', 'DECIMAL', 'BOOLEAN', 'BOOL', 'DATE', 'DATETIME',
  'TIMESTAMP', 'TIME', 'UUID', 'JSON', 'JSONB', 'BYTEA', 'SERIAL', 'NONE',
  'BEFORE', 'AFTER', 'INSTEAD', 'OF', 'FOR', 'EACH', 'ROW', 'STATEMENT',
  'WHEN', 'THEN', 'ELSE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'ABORT', 'FAIL',
  'IGNORE', 'REPLACE', 'ROLLBACK', 'RAISE',
]);

// ── Helper: Detect CHECK OPTION ──────────────────────────────────

/**
 * Detect whether a CREATE VIEW SQL includes WITH CHECK OPTION.
 *
 * @param sql - The SQL statement to check.
 * @returns CheckOptionInfo with detection result and extracted view info.
 */
export function detectCheckOption(sql: string): CheckOptionInfo {
  const result: CheckOptionInfo = {
    hasCheckOption: false,
    viewName: '',
    queryBody: '',
  };

  if (!sql || typeof sql !== 'string') {
    return result;
  }

  const match = sql.trim().match(CHECK_OPTION_RE);
  if (!match) {
    return result;
  }

  // The CHECK OPTION suffix must be detected on the *protected* SQL so that
  // the literal `WITH CHECK OPTION` text inside a string or a `-- ...` comment
  // is not mistaken for a real clause (BUG #440).
  const hasCheckOption = /\s+WITH\s+(?:(CASCADED|LOCAL)\s+)?CHECK\s+OPTION\s*;?\s*$/i.test(
    protectSQL(sql.trim()).protectedSql,
  );

  return {
    hasCheckOption,
  /* v8 ignore next -- ?? fallback is defensive default */
    viewName: match[3] ?? '',
  /* v8 ignore next -- ?? fallback is defensive default */
    queryBody: match[5] ?? '',
  };
}

// ── Helper: Validate simple view ─────────────────────────────────

/**
 * Validate that a view query body is a simple SELECT from a single table
 * (no joins, aggregates, subqueries, set operations, or DISTINCT).
 *
 * @param queryBody - The query SQL after the AS keyword.
 * @returns `true` if the view is simple enough for CHECK OPTION triggers.
 */
export function isSimpleView(queryBody: string): boolean {
  // Protect string literals and comments first so that keywords appearing
  // inside them (e.g. `-- JOIN u` or `x = 'GROUP BY'`) are not mistaken for
  // real structural clauses (BUG #442).
  const upper = protectSQL(queryBody).protectedSql.trim().toUpperCase();

  // Must start with SELECT
  if (!/^\s*SELECT\s/i.test(upper)) {
    return false;
  }

  // Must have a FROM clause
  if (!/\bFROM\s/i.test(upper)) {
    return false;
  }

  // Reject joins
  if (/\bJOIN\b/i.test(upper)) {
    return false;
  }

  // Reject aggregates / GROUP BY / HAVING
  if (/\bGROUP\s+BY\b/i.test(upper)) {
    return false;
  }
  if (/\bHAVING\b/i.test(upper)) {
    return false;
  }

  // Reject subqueries (nested SELECT)
  if (/\(\s*SELECT\s/i.test(upper)) {
    return false;
  }

  // Reject set operations
  if (/\bUNION\b/i.test(upper)) return false;
  if (/\bINTERSECT\b/i.test(upper)) return false;
  if (/\bEXCEPT\b/i.test(upper)) return false;

  // Reject DISTINCT
  if (/\bSELECT\s+DISTINCT\b/i.test(upper)) {
    return false;
  }

  return true;
}

// ── Helper: Extract simple view info ─────────────────────────────

/**
 * Extract the base table name and WHERE condition from a simple view query body.
 *
 * Handles:
 *   SELECT * FROM t WHERE cond
 *   SELECT col1, col2 FROM t WHERE cond
 *   SELECT * FROM t (no WHERE)
 *
 * @param queryBody - The query SQL after the AS keyword.
 * @returns SimpleViewInfo or null if extraction fails.
 */
export function extractSimpleViewInfo(queryBody: string): SimpleViewInfo | null {
  const trimmed = queryBody.trim();

  // Extract FROM clause: table name is the first identifier after FROM
  const fromMatch = trimmed.match(/\bFROM\s+([A-Za-z_][A-Za-z0-9_$.]*)/i);
  if (!fromMatch) {
    return null;
  }
  const tableName = fromMatch[1];

  // Extract WHERE clause (everything between WHERE and GROUP/ORDER/LIMIT/HAVING/end)
  const whereMatch = trimmed.match(
    /\bWHERE\s+(.+?)(?:\s+(?:GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|OFFSET)\s+|$)/is,
  );
  const whereCondition = whereMatch ? whereMatch[1].trim() : '';

  return { tableName, whereCondition };
}

// ── Helper: Prefix WHERE condition with NEW. ────────────────────

/**
 * Prefix identifiers in a WHERE condition with `NEW.` for use in SQLite triggers.
 *
 * This is a best-effort heuristic: simple column references are prefixed.
 * SQL keywords, qualified names (t.col), and string literals are handled.
 *
 * @param condition - The raw WHERE condition (e.g. "x > 0 AND y = 'active'").
 * @returns Condition with column references prefixed (e.g. "NEW.x > 0 AND NEW.y = 'active'").
 */
export function prefixWhereWithNew(condition: string): string {
  if (!condition || condition.trim() === '') {
    return '';
  }

  // Strategy: process token-by-token, skipping string literals and qualified names
  const result: string[] = [];
  let i = 0;
  const len = condition.length;

  while (i < len) {
    // Skip string literals (single-quoted)
    if (condition[i] === "'") {
      const endQuote = condition.indexOf("'", i + 1);
      if (endQuote === -1) {
        // Unterminated string — append rest and break
        result.push(condition.slice(i));
        break;
      }
      result.push(condition.slice(i, endQuote + 1));
      i = endQuote + 1;
      continue;
    }

    // Skip numeric literals
    if (/\d/.test(condition[i]) && (i === 0 || /\W/.test(condition[i - 1]))) {
      const numMatch = condition.slice(i).match(/^\d+(?:\.\d+)?/);
      if (numMatch) {
        result.push(numMatch[0]);
        i += numMatch[0].length;
        continue;
      }
    }

    // Check for qualified name pattern: identifier.identifier
    const qualMatch = condition.slice(i).match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)/);
    if (qualMatch) {
      // Qualified name — keep as-is
      result.push(qualMatch[0]);
      i += qualMatch[0].length;
      continue;
    }

    // Check for plain identifier
    const idMatch = condition.slice(i).match(/^([A-Za-z_]\w*)/);
    if (idMatch) {
      const word = idMatch[1];
      // Peek ahead: an identifier immediately followed by `(` is a function
      // *call* name (e.g. `upper`, `trim`, `coalesce`), not a column reference,
      // so it must not be prefixed. This prevents producing illegal SQL like
      // `NEW.upper(NEW.x)` (BUG #437/#439).
      const after = condition.slice(i + word.length);
      const isFunctionCall = /^\s*\(/.test(after);
      if (SQL_KEYWORDS.has(word.toUpperCase()) || isFunctionCall) {
        result.push(word);
      } else {
        result.push(`NEW.${word}`);
      }
      i += word.length;
      continue;
    }

    // Non-identifier character — pass through
    result.push(condition[i]);
    i++;
  }

  return result.join('');
}

// ── Helper: Build CHECK OPTION triggers ──────────────────────────

/**
 * Build enforcement triggers for a view with CHECK OPTION.
 *
 * Creates AFTER INSERT and AFTER UPDATE triggers on the base table
 * that reject rows not satisfying the view's WHERE condition.
 *
 * @param viewName - The view name.
 * @param tableName - The base table name.
 * @param whereCondition - The WHERE condition (raw, without NEW. prefix).
 * @returns Array of CREATE TRIGGER SQL statements.
 */
export function buildCheckOptionTriggers(
  viewName: string,
  tableName: string,
  whereCondition: string,
): string[] {
  const triggers: string[] = [];
  const newCondition = prefixWhereWithNew(whereCondition);
  const errorMsg = `new row violates CHECK OPTION for view ${viewName}`;

  if (newCondition) {
    // INSERT trigger
    triggers.push(
      [
        `CREATE TRIGGER _sqlvec_check_${viewName}_insert`,
        `AFTER INSERT ON ${tableName}`,
        'BEGIN',
        `  SELECT RAISE(ABORT, '${errorMsg}')`,
        `  WHERE NOT (${newCondition});`,
        'END',
      ].join('\n'),
    );

    // UPDATE trigger
    triggers.push(
      [
        `CREATE TRIGGER _sqlvec_check_${viewName}_update`,
        `AFTER UPDATE ON ${tableName}`,
        'BEGIN',
        `  SELECT RAISE(ABORT, '${errorMsg}')`,
        `  WHERE NOT (${newCondition});`,
        'END',
      ].join('\n'),
    );
  }

  return triggers;
}

// ── Helper: Build CHECK OPTION cleanup triggers ──────────────────

/**
 * Build DROP TRIGGER statements to clean up CHECK OPTION enforcement triggers
 * when a view is dropped.
 *
 * @param viewName - The view name whose triggers should be dropped.
 * @returns Array of DROP TRIGGER SQL statements.
 */
export function buildDropCheckTriggerSql(viewName: string): string[] {
  const cleanName = viewName.replace(/[^A-Za-z0-9_$]/g, '_');
  return [
    `DROP TRIGGER IF EXISTS _sqlvec_check_${cleanName}_insert`,
    `DROP TRIGGER IF EXISTS _sqlvec_check_${cleanName}_update`,
  ];
}

// ── Helper: Process CHECK OPTION in any CREATE VIEW ──────────────

/**
 * Process CHECK OPTION in a CREATE VIEW statement.
 *
 * Strips the CHECK OPTION suffix from the SQL, and if the view is simple enough,
 * generates enforcement triggers.
 *
 * @param viewName - The view name.
 * @param queryBody - The query body (may include CHECK OPTION suffix).
 * @param sql - The original SQL statement (for logging).
 * @returns An object with the cleaned query body and optional trigger arrays.
 */
export function processCheckOption(
  viewName: string,
  queryBody: string,
  sql: string,
): { cleanQueryBody: string; triggers: string[] } {
  const triggers: string[] = [];

  // Detect CHECK OPTION
  const checkInfo = detectCheckOption(sql);
  const hasCheckOption = checkInfo.hasCheckOption;

  // Clean query body by stripping CHECK OPTION
  let cleanQueryBody = queryBody;
  if (hasCheckOption) {
    cleanQueryBody = queryBody.replace(STRIP_CHECK_OPTION_RE, '');
  }

  // If CHECK OPTION was found, validate and generate triggers
  if (hasCheckOption) {
    if (!isSimpleView(cleanQueryBody)) {
      throw new Error(
        `CHECK OPTION only supported on simple views (single table, no aggregates): ${viewName}`,
      );
    }

    const viewInfo = extractSimpleViewInfo(cleanQueryBody);
    if (viewInfo && viewInfo.whereCondition) {
      // Generate enforcement triggers
      const checkTriggers = buildCheckOptionTriggers(
        viewName,
        viewInfo.tableName,
        viewInfo.whereCondition,
      );
      triggers.push(...checkTriggers);
      logger.debug(
        { viewName, tableName: viewInfo.tableName, condition: viewInfo.whereCondition },
        'Generated CHECK OPTION enforcement triggers',
      );
    }
  }

  return { cleanQueryBody, triggers };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL uses PostgreSQL-specific CREATE VIEW syntax
 * (OR REPLACE or RECURSIVE).
 *
 * @param sql - The SQL statement to check.
 * @returns `true` if the statement contains PG-specific view syntax.
 */
export function detectPgViewSyntax(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  const trimmed = sql.trim();

  // Match: CREATE OR REPLACE VIEW ... or CREATE RECURSIVE VIEW ...
  return /^\s*CREATE\s+(?:OR\s+REPLACE\s+VIEW|RECURSIVE\s+VIEW)\s/i.test(trimmed);
}

/**
 * Rewrite a CREATE VIEW statement from PostgreSQL syntax to SQLite-compatible syntax.
 *
 * Processing rules:
 * - CREATE OR REPLACE VIEW name [...] AS query → CREATE VIEW IF NOT EXISTS name [...] AS query
 *   (IF NOT EXISTS is added if absent; if present in the original, it is preserved)
 * - CREATE RECURSIVE VIEW name [(cols)] AS query → CREATE VIEW name [(cols)] AS query
 *   (the RECURSIVE keyword is removed; the column list, if present, is preserved)
 * - Any CREATE VIEW with WITH CHECK OPTION → CHECK OPTION suffix stripped,
 *   enforcement triggers generated in `checkOptionTriggers`
 * - CREATE VIEW / CREATE TEMP VIEW / CREATE TEMPORARY VIEW → pass through unchanged
 *   (these forms are already SQLite-compatible, but CHECK OPTION may still be stripped)
 *
 * @param sql - The SQL statement to process.
 * @returns A ViewResult with the rewritten SQL and a flag indicating whether rewriting occurred.
 */
export function rewriteViewSql(sql: string): ViewResult {
  if (!sql || typeof sql !== 'string') {
  /* v8 ignore next -- ?? fallback is defensive default */
    return { sql: sql ?? '', rewritten: false };
  }

  const trimmed = sql.trim();

  // Detect CHECK OPTION early — we need to know if it's present before we rewrite PG syntax
  const checkInfo = detectCheckOption(trimmed);
  const hasCheckOption = checkInfo.hasCheckOption;

  // ── CREATE OR REPLACE VIEW ──────────────────────────────
  //
  // Transform: CREATE OR REPLACE VIEW name [(cols)] AS query
  //        → CREATE VIEW IF NOT EXISTS name [(cols)] AS query
  //
  // Note: IF NOT EXISTS in the original is stripped by the regex's optional
  // group, so we always re-add it.  This is fine — it's idempotent.

  const orReplaceMatch = trimmed.match(OR_REPLACE_VIEW_RE);
  if (orReplaceMatch) {
    const viewName = orReplaceMatch[1];
  /* v8 ignore next -- ?? fallback is defensive default */
    const columnList = orReplaceMatch[2] ?? '';
    const queryBody = orReplaceMatch[3];

    // Process CHECK OPTION (strip from query body and generate triggers)
    const { cleanQueryBody, triggers } = processCheckOption(
      viewName,
      queryBody,
      trimmed,
    );

    const rewritten = `CREATE VIEW IF NOT EXISTS ${viewName}${columnList ? ' ' + columnList : ''} AS ${cleanQueryBody}`;
    logger.debug({ original: trimmed, rewritten }, 'Rewrote CREATE OR REPLACE VIEW to CREATE VIEW IF NOT EXISTS');

    const result: ViewResult = { sql: rewritten, rewritten: true };
    if (triggers.length > 0) {
      result.checkOptionTriggers = triggers;
    }
    return result;
  }

  // ── CREATE RECURSIVE VIEW ───────────────────────────────
  //
  // Transform: CREATE RECURSIVE VIEW name [(cols)] AS query
  //        → CREATE VIEW name [(cols)] AS query

  const recursiveMatch = trimmed.match(RECURSIVE_VIEW_RE);
  if (recursiveMatch) {
    const viewName = recursiveMatch[1];
  /* v8 ignore next -- ?? fallback is defensive default */
    const columnList = recursiveMatch[2] ?? '';
    const queryBody = recursiveMatch[3];

    // Process CHECK OPTION (strip from query body and generate triggers)
    const { cleanQueryBody, triggers } = processCheckOption(
      viewName,
      queryBody,
      trimmed,
    );

    const rewritten = `CREATE VIEW ${viewName}${columnList ? ' ' + columnList : ''} AS ${cleanQueryBody}`;
    logger.debug({ original: trimmed, rewritten }, 'Rewrote CREATE RECURSIVE VIEW to CREATE VIEW');

    const result: ViewResult = { sql: rewritten, rewritten: true };
    if (triggers.length > 0) {
      result.checkOptionTriggers = triggers;
    }
    return result;
  }

  // ── Plain CREATE VIEW (including TEMP/TEMPORARY) ────────
  //
  // Check for CHECK OPTION on any CREATE VIEW form

  if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP\s+|TEMPORARY\s+)?VIEW\s/i.test(trimmed)) {
    const viewMatch = trimmed.match(VIEW_WITH_CHECK_RE);
    if (viewMatch) {
      const viewName = viewMatch[1];
  /* v8 ignore next -- ?? fallback is defensive default */
      const columnList = viewMatch[2] ?? '';
  /* v8 ignore next -- ?? fallback is defensive default */
      const queryBody = viewMatch[5] ?? viewMatch[3] ?? '';

      // Process CHECK OPTION (strip from query body and generate triggers)
      const { cleanQueryBody, triggers } = processCheckOption(
        viewName,
        queryBody,
        trimmed,
      );

      if (hasCheckOption || triggers.length > 0) {
        // We had CHECK OPTION to strip or triggers to generate
        const columnStr = columnList ? ' ' + columnList : '';
        
        // Reconstruct the SQL with the original prefix
        let prefix = 'CREATE VIEW';
        if (/^\s*CREATE\s+TEMP\s/i.test(trimmed)) {
          prefix = 'CREATE TEMP VIEW';
        } else if (/^\s*CREATE\s+TEMPORARY\s/i.test(trimmed)) {
          prefix = 'CREATE TEMPORARY VIEW';
        }

        const rewritten = `${prefix} ${viewName}${columnStr} AS ${cleanQueryBody}`;
        logger.debug({ original: trimmed, rewritten, hasCheckOption }, 'Stripped CHECK OPTION from CREATE VIEW');

        const result: ViewResult = { sql: rewritten, rewritten: true };
        if (triggers.length > 0) {
          result.checkOptionTriggers = triggers;
        }
        return result;
      }
    }
  }

  // Not a PG-specific form and no CHECK OPTION — pass through unchanged
  return { sql: trimmed, rewritten: false };
}
