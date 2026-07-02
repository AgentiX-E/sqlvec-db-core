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
const OR_REPLACE_VIEW_RE =
  /^\s*CREATE\s+OR\s+REPLACE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$.]*)\s*(\([^)]*\))?\s+AS\s+(.*)$/is;

/**
 * Matches: CREATE RECURSIVE VIEW name [(cols)] AS query
 *
 * Groups:
 *   1 — View name (identifier, possibly schema-qualified)
 *   2 — Optional column list, e.g. (col1, col2) (with leading space if present, empty if absent)
 *   3 — Query body (everything after AS)
 */
const RECURSIVE_VIEW_RE =
  /^\s*CREATE\s+RECURSIVE\s+VIEW\s+([A-Za-z_][A-Za-z0-9_$.]*)\s*(\([^)]*\))?\s+AS\s+(.*)$/is;

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
const CHECK_OPTION_RE =
  /^\s*CREATE\s+(OR\s+REPLACE\s+)?(RECURSIVE\s+)?(?:TEMP\s+|TEMPORARY\s+)?VIEW\s+([A-Za-z_][A-Za-z0-9_$.]*)\s*(\([^)]*\))?\s+AS\s+(.+?)(?:\s+WITH\s+(?:(CASCADED|LOCAL)\s+)?CHECK\s+OPTION)?\s*;?\s*$/is;

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
const VIEW_WITH_CHECK_RE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:RECURSIVE\s+)?(?:TEMP\s+|TEMPORARY\s+)?VIEW\s+([A-Za-z_][A-Za-z0-9_$.]*)\s*(\([^)]*\))?\s+AS\s+(.+?)(?:\s+WITH\s+(?:(CASCADED|LOCAL)\s+)?CHECK\s+OPTION)?\s*;?\s*$/is;

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
    return sql ?? '';
  }

  const trimmed = sql.trim();

  // Only expand in SELECT statements
  if (!/^\s*SELECT\b/i.test(trimmed)) {
    return trimmed;
  }

  // Skip DDL statements
  if (/^\s*(CREATE|DROP|ALTER)\b/i.test(trimmed)) {
    return trimmed;
  }

  let result = trimmed;

  // 1. Expand view references in FROM clauses
  result = result.replace(VIEW_FROM_RE, (match, tableName: string) => {
    const viewDef = getViewDefinition(tableName);
    if (viewDef) {
      return `FROM (${viewDef}) AS ${tableName}`;
    }
    return match;
  });

  // 2. Expand view references in JOIN clauses
  result = result.replace(VIEW_JOIN_RE, (match, tableName: string) => {
    const viewDef = getViewDefinition(tableName);
    if (viewDef) {
      return `JOIN (${viewDef}) AS ${tableName}`;
    }
    return match;
  });

  return result;
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

  // Group 2 has the query body *including* CHECK OPTION if present.
  // But group 5 is the query body (without CHECK OPTION suffix), and
  // we check the trailing group (WITH CHECK OPTION).
  const hasCheckOption = /\s+WITH\s+(?:(CASCADED|LOCAL)\s+)?CHECK\s+OPTION\s*;?\s*$/i.test(sql.trim());

  return {
    hasCheckOption,
    viewName: match[3] ?? '',
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
  const upper = queryBody.trim().toUpperCase();

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
    const idMatch = condition.slice(i).match(/^([A-Za-z_]\w*)\b/);
    if (idMatch) {
      const word = idMatch[1];
      if (SQL_KEYWORDS.has(word.toUpperCase())) {
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
      const columnList = viewMatch[2] ?? '';
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
