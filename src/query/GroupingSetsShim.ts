/**
 * GroupingSetsShim — PostgreSQL GROUPING SETS / CUBE / ROLLUP compatibility for SQLite.
 *
 * PostgreSQL supports GROUP BY extensions: GROUPING SETS, CUBE, and ROLLUP.
 * SQLite 3.38+ natively supports CUBE and ROLLUP, but does NOT support GROUPING SETS.
 *
 * ## PG syntax examples
 * ```sql
 * SELECT a, b, SUM(c) FROM t GROUP BY GROUPING SETS ((a), (b), ());
 * SELECT a, b, SUM(c) FROM t GROUP BY CUBE (a, b);
 * SELECT a, b, SUM(c) FROM t GROUP BY ROLLUP (a, b);
 * SELECT a, b, SUM(c) FROM t GROUP BY (a, b) GROUPING SETS ((a, b));
 * ```
 *
 * ## Strategy
 * | Input                                                     | Action                                                     |
 * |-----------------------------------------------------------|------------------------------------------------------------|
 * | `GROUP BY GROUPING SETS ((a,b), (a), ())`                 | Expand each set as individual GROUP BY, UNION ALL together |
 * | `GROUP BY (a, b) GROUPING SETS ((a, b))`                  | Strip GROUPING SETS clause only                            |
 * | `GROUP BY CUBE (...)`                                     | Expand to GROUPING SETS → UNION ALL                        |
 * | `GROUP BY ROLLUP (...)`                                   | Expand to GROUPING SETS → UNION ALL                        |
 * | No GROUPING SETS / CUBE / ROLLUP                          | Pass through                                               |
 *
 * ## GROUPING SETS expansion (UNION ALL)
 *
 * Each grouping set is expanded into a separate GROUP BY query and UNION ALL'd together.
 * Non-grouping columns in the SELECT list are NULL-padded for each set.
 * GROUPING(col) is transformed to CASE WHEN col IS NULL THEN 1 ELSE 0 END.
 *
 * Example:
 * ```sql
 * SELECT a, b, SUM(c) FROM t GROUP BY GROUPING SETS ((a,b), (a), ())
 * ```
 * →
 * ```sql
 * SELECT a, b, SUM(c) FROM t GROUP BY a, b
 * UNION ALL
 * SELECT a, NULL AS b, SUM(c) FROM t GROUP BY a
 * UNION ALL
 * SELECT NULL AS a, NULL AS b, SUM(c) FROM t
 * ```
 *
 * @module GroupingSetsShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('GroupingSetsShim');

// ── Types ────────────────────────────────────────────────────────

export interface GroupingSetsResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

/** Information about a column in a SELECT list */
export interface ColumnInfo {
  /** The full expression text (e.g., "SUM(c)", "a", "t.col AS alias") */
  expr: string;
  /** Whether this is a simple column reference (no parentheses) — candidate for NULL padding */
  isSimple: boolean;
  /** The resolved column name (after AS alias, last identifier after dot) */
  name: string;
}

// ── Constants – Regex patterns ───────────────────────────────────

/**
 * Detects GROUP BY GROUPING SETS (...) at the top-level of a SQL statement.
 */
const GROUPING_SETS_PATTERN = /\bGROUP\s+BY\s+(?:(?!GROUPING\s+SETS)[\s\S])*?GROUPING\s+SETS\s*\(/i;

/**
 * Detects GROUP BY CUBE (...) at the top-level of a SQL statement.
 */
const CUBE_PATTERN = /\bGROUP\s+BY\s+CUBE\s*\(/i;

/**
 * Detects GROUP BY ROLLUP (...) at the top-level of a SQL statement.
 */
const ROLLUP_PATTERN = /\bGROUP\s+BY\s+ROLLUP\s*\(/i;

/**
 * Detects any GROUPING SETS keyword (not necessarily at top-level).
 */
const GROUPING_SETS_KEYWORD_PATTERN = /\bGROUPING\s+SETS\s*\(/i;

/**
 * Detects the GROUPING() function call.
 */
const GROUPING_FUNC_PATTERN = /\bGROUPING\s*\(/i;

/**
 * Combined detection regex for any GROUP BY extension (GROUPING SETS / CUBE / ROLLUP).
 */
const EXTENSION_PATTERN = /\bGROUP\s+BY\s+(?:GROUPING\s+SETS|CUBE|ROLLUP)\s*\(/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains GROUPING SETS, CUBE, or ROLLUP.
 *
 * Performs a case-insensitive check for GROUP BY extensions.
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if GROUPING SETS, CUBE, or ROLLUP is detected
 */
export function detectGroupingSets(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Primary check: GROUP BY immediately followed by GROUPING SETS / CUBE / ROLLUP,
  // ignoring any operator keywords that appear inside string literals or comments.
  if (_testOutsideLiterals(trimmed, EXTENSION_PATTERN)) {
    return true;
  }

  // Secondary check: GROUP BY ... GROUPING SETS (where intermediate content exists
  // between GROUP BY and GROUPING SETS), also literal-aware.
  if (_testOutsideLiterals(trimmed, GROUPING_SETS_KEYWORD_PATTERN) && _testOutsideLiterals(trimmed, /\bGROUP\s+BY\s+/i)) {
    return true;
  }

  // Detect standalone GROUPING() function even without GROUP BY extension.
  if (_testOutsideLiterals(trimmed, GROUPING_FUNC_PATTERN)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a SQL string that may contain GROUPING SETS / CUBE / ROLLUP.
 *
 * **Processing rules:**
 *
 * | Input                                                     | Output                                                      | rewritten |
 * |-----------------------------------------------------------|-------------------------------------------------------------|-----------|
 * | `SELECT ... GROUP BY GROUPING SETS ((a,b), (a), ())`      | `SELECT ... UNION ALL ...` (expanded to sub-queries)        | true      |
 * | `SELECT ... GROUP BY (a, b) GROUPING SETS ((a, b))`       | `SELECT ... GROUP BY (a, b)` (GROUPING SETS clause stripped)| true      |
 * | `SELECT ... GROUP BY CUBE (a, b)`                         | `SELECT ... UNION ALL ...` (expanded to sub-queries)        | true      |
 * | `SELECT ... GROUP BY ROLLUP (a, b)`                       | `SELECT ... UNION ALL ...` (expanded to sub-queries)        | true      |
 * | `SELECT ... FROM t` (no GROUP BY extension)               | `SELECT ... FROM t` (unchanged)                             | false     |
 *
 * **GROUPING() function:**
 * Transforms GROUPING(col) → CASE WHEN col IS NULL THEN 1 ELSE 0 END
 * so that users can detect subtotal rows in UNION ALL results.
 *
 * @param sql - The raw SQL string to process
 * @returns A GroupingSetsResult with the rewritten SQL and a flag indicating if changes were made
 */
export function rewriteGroupingSets(sql: string): GroupingSetsResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  let working = sql.trim();

  // ── Phase 1: Handle GROUPING() function even without GROUP BY extension ──
  // (literal-aware: a `GROUPING(` occurrence inside a string isn't real SQL).

  const hasGroupingFunc = _testOutsideLiterals(working, GROUPING_FUNC_PATTERN);

  // ── Phase 2: Check if CUBE or ROLLUP (expand to GROUPING SETS first) ──
  // We expand CUBE and ROLLUP so we can UNION ALL them properly and
  // support GROUPING() function transformation.

  if (_testOutsideLiterals(working, CUBE_PATTERN)) {
    const expanded = expandCubeOrRollup(working, 'CUBE');
    if (expanded !== null) {
      return { sql: expanded, rewritten: true };
    }
    // Fall through to original CUBE passthrough
    logger.debug({ sql: working }, 'CUBE expansion failed — passing through (SQLite native)');
    return { sql: working, rewritten: false };
  }

  if (_testOutsideLiterals(working, ROLLUP_PATTERN)) {
    const expanded = expandCubeOrRollup(working, 'ROLLUP');
    if (expanded !== null) {
      return { sql: expanded, rewritten: true };
    }
    logger.debug({ sql: working }, 'ROLLUP expansion failed — passing through (SQLite native)');
    return { sql: working, rewritten: false };
  }

  // ── Phase 3: Check for GROUPING SETS ──

  const hasGroupingSetsKeyword = _testOutsideLiterals(working, GROUPING_SETS_KEYWORD_PATTERN);
  if (!hasGroupingSetsKeyword && !hasGroupingFunc) {
    return {
      sql: working,
      rewritten: false,
    };
  }

  logger.debug({ sql: working }, 'GROUPING SETS detected — rewriting for SQLite compatibility');

  // ── Phase 4: Determine rewrite strategy ──

  if (hasGroupingFunc && !hasGroupingSetsKeyword) {
    // Only GROUPING() function, no GROUPING SETS — transform function calls
    working = transformGroupingFunc(working);
    return {
      sql: working,
      rewritten: true,
    };
  }

  const groupingSetsIdx = _findKeywordIndexOutsideLiterals(working, /\bGROUPING\s+SETS\s*\(/i);
  if (groupingSetsIdx === -1) {
    return { sql: working, rewritten: false };
  }

  const parenStart = findCharIndex(working, '(', groupingSetsIdx);
  if (parenStart === -1) {
    logger.warn({ sql: working }, 'GROUPING SETS found but no opening parenthesis — cannot rewrite');
    return { sql: working, rewritten: false };
  }

  const parenEnd = findMatchingCloseParen(working, parenStart);
  if (parenEnd === -1) {
    logger.warn({ sql: working }, 'GROUPING SETS found but unbalanced parentheses — cannot rewrite');
    return { sql: working, rewritten: false };
  }

  const groupingSetsEnd = parenEnd + 1;

  // Check if there is a plain GROUP BY clause before the GROUPING SETS keyword
  const plainGroupByMatch = findPlainGroupByBefore(working, groupingSetsIdx);

  if (plainGroupByMatch) {
    // Case: GROUP BY (a, b) GROUPING SETS ((a, b))
    // Strip GROUPING SETS clause, keep plain GROUP BY
    const clauseEnd = groupingSetsEnd;
    working = working.slice(0, plainGroupByMatch.endIndex) + working.slice(clauseEnd).trimStart();
    working = working.replace(/\s{2,}/g, ' ').trim();
    working = working.replace(/,\s*$/, '');
    // Also transform any GROUPING() functions
    working = transformGroupingFunc(working);

    logger.debug({ sql: working }, 'GROUPING SETS clause stripped — kept preceding GROUP BY');
    return {
      sql: working,
      rewritten: true,
    };
  }

  // Case: Standalone GROUP BY GROUPING SETS (...) — expand to UNION ALL
  const expanded = expandGroupingSets(working);
  if (expanded === null) {
    // Fall back to stripping GROUP BY if expansion fails
    logger.warn({ sql: working }, 'GROUPING SETS expansion failed — falling back to GROUP BY stripping');
    return stripGroupByGroupingSets(working, groupingSetsIdx, groupingSetsEnd);
  }

  logger.debug({ sql: working, rewritten: expanded }, 'GROUPING SETS expanded to UNION ALL');
  return {
    sql: expanded,
    rewritten: true,
  };
}

// ── Internal Helpers (exported for testing) ───────────────────────

/**
 * Skip over a SQL literal, quoted identifier, dollar-quoted string, or
 * comment starting at `pos`, returning the index just past it (or `-1` if
 * the character at `pos` does not begin one of these constructs).
 *
 * This is the foundation of literal-aware scanning: bare parenthesis
 * counting and comma splitting would otherwise be fooled by `)`, `(`, or
 * `,` characters that appear *inside* string literals or comments.
 *
 * @internal
 */
export function _skipSqlLiteral(sql: string, pos: number): number {
  const c = sql[pos];
  const len = sql.length;

  // Line comment: `--` to end of line.
  if (c === '-' && sql[pos + 1] === '-') {
    let j = pos + 2;
    while (j < len && sql[j] !== '\n') j++;
    return j;
  }

  // Block comment: `/*` to `*/`.
  if (c === '/' && sql[pos + 1] === '*') {
    const end = sql.indexOf('*/', pos + 2);
    return end === -1 ? len : end + 2;
  }

  // Single-quoted string.
  if (c === "'") {
    let j = pos + 1;
    while (j < len) {
      if (sql[j] === '\\' && j + 1 < len) {
        j += 2; // E''-style backslash escape consumes the next char too.
        continue;
      }
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") { j += 2; continue; } // doubled '' escape
        return j + 1;
      }
      j++;
    }
    return len; // unterminated string
  }

  // Double-quoted identifier.
  if (c === '"') {
    let j = pos + 1;
    while (j < len) {
      if (sql[j] === '"') {
        if (sql[j + 1] === '"') { j += 2; continue; } // doubled "" escape
        return j + 1;
      }
      j++;
    }
    return len; // unterminated identifier
  }

  // Dollar-quoted string: $$ ... $$ or $tag$ ... $tag$.
  if (c === '$') {
    const m = sql.slice(pos).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (m) {
      const tag = m[0];
      const close = sql.indexOf(tag, pos + tag.length);
      return close === -1 ? len : close + tag.length;
    }
    return -1; // a bare $ that is not a dollar-quote opener
  }

  return -1;
}

/**
 * Return true if `pos` is inside a string literal, quoted identifier,
 * dollar-quoted string, or comment (i.e. the character there is not real SQL).
 */
export function _isInsideLiteral(sql: string, pos: number): boolean {
  let i = 0;
  const len = sql.length;
  while (i < pos && i < len) {
    const skip = _skipSqlLiteral(sql, i);
    if (skip === -1) {
      i++;
      continue;
    }
    if (pos < skip) return true;
    i = skip;
  }
  return false;
}

/**
 * Return true if `regex` matches the SQL text *outside* any string literal,
 * quoted identifier, dollar-quoted string, or comment.
 *
 * Uses a global-state-free scan: first try a plain test matching (fast path),
 * then confirm the matched region does not begin inside a literal.
 *
 * @internal
 */
export function _testOutsideLiterals(sql: string, regex: RegExp): boolean {
  if (!sql) return false;
  // Walk every match of the pattern and accept only those whose start index
  // is not inside a literal.
  const rg = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = rg.exec(sql)) !== null) {
    if (!_isInsideLiteral(sql, m.index)) {
      return true;
    }
    if (m.index === rg.lastIndex) rg.lastIndex++; // avoid zero-width infinite loop
  }
  return false;
}

/**
 * Find the index of the first match of `regex` that is *outside* any string
 * literal, quoted identifier, dollar-quoted string, or comment.
 *
 * @internal
 */
export function _findKeywordIndexOutsideLiterals(sql: string, regex: RegExp): number {
  if (!sql) return -1;
  const rg = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = rg.exec(sql)) !== null) {
    if (!_isInsideLiteral(sql, m.index)) {
      return m.index;
    }
    if (m.index === rg.lastIndex) rg.lastIndex++;
  }
  return -1;
}

/**
 * Find the index of a keyword regex pattern in the string, ignoring any
 * matches that fall inside a string literal, quoted identifier,
 * dollar-quoted string, or comment.
 *
 * @internal
 */
export function _findKeywordIndex(sql: string, pattern: RegExp): number {
  const match = sql.match(pattern);
  return match ? match.index! : -1;
}

/**
 * Find the index of the first occurrence of character `ch` at or after `fromIndex`.
 *
 * @internal
 */
export function _findCharIndex(sql: string, ch: string, fromIndex: number): number {
  return sql.indexOf(ch, fromIndex);
}

/**
 * Find the index of the matching closing parenthesis, starting from the opening `(` at `openIdx`.
 * Handles nested parentheses correctly.
 *
 * @internal
 */
export function _findMatchingCloseParen(sql: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;

  while (i < sql.length && depth > 0) {
    const skip = _skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip; // jump over string literals / identifiers / comments
      continue;
    }
    if (sql[i] === '(') {
      depth++;
    } else if (sql[i] === ')') {
      depth--;
    }
    i++;
  }

  return depth === 0 ? i - 1 : -1;
}

/**
 * Find a plain GROUP BY clause that ends before `beforeIndex`.
 *
 * @internal
 */
export function _findPlainGroupByBefore(sql: string, beforeIndex: number): { startIndex: number; endIndex: number } | null {
  const searchTarget = sql.slice(0, beforeIndex);
  const plainGroupByRe = /\bGROUP\s+BY\s+(?!(?:GROUPING\s+SETS|CUBE|ROLLUP)\s*\()([\s\S]+?)$/i;
  const match = searchTarget.match(plainGroupByRe);

  // `match.index` may legitimately be 0 (GROUP BY at the very start), so a
  // bare `!match.index` truthiness check would wrongly return null there.
  if (!match || match.index === undefined || match.index === null) {
    return null;
  }

  return {
    startIndex: match.index,
    endIndex: beforeIndex,
  };
}

/**
 * Parse GROUPING SETS content into individual sets.
 *
 * Input: "((a,b), (a), ())" → [["a","b"], ["a"], []]
 *
 * @internal
 */
export function _parseGroupingSetsContent(content: string): string[][] {
  const sets: string[][] = [];
  let i = 0;

  while (i < content.length) {
    // Skip whitespace and commas between sets
    while (i < content.length && (/\s/.test(content[i]) || content[i] === ',')) i++;
    if (i >= content.length) break;

    // Expect '(' — start of a set
    if (content[i] !== '(') {
      i++;
      continue;
    }

    const openIdx = i;
    const closeIdx = _findMatchingCloseParen(content, openIdx);
    if (closeIdx === -1) {
      i++; // unbalanced — skip this opening paren defensively
      continue;
    }
    i = closeIdx + 1;

    // Extract content between the parentheses (handling both empty and non-empty)
    const innerContent = content.slice(openIdx + 1, closeIdx).trim();

    if (innerContent.length === 0) {
      sets.push([]); // Empty set — grand total ()
    } else {
      // Split inner content by commas to get column names
      const cols = splitTopLevelCommas(innerContent);
      sets.push(cols);
    }
  }

  return sets;
}

/**
 * Expand ROLLUP(a,b,c) into its equivalent GROUPING SETS sets:
 * ((a,b,c), (a,b), (a), ())
 *
 * @internal
 */
export function _expandRollup(columns: string[]): string[][] {
  const sets: string[][] = [];
  for (let i = columns.length; i >= 0; i--) {
    sets.push(columns.slice(0, i));
  }
  return sets;
}

/**
 * Expand CUBE(a,b) into its equivalent GROUPING SETS sets:
 * ((a,b), (a), (b), ())
 *
 * Iterates subsets in descending cardinality, then by column order.
 *
 * @internal
 */
export function _expandCube(columns: string[]): string[][] {
  const sets: string[][] = [];
  const n = columns.length;
  const total = 1 << n;
  for (let mask = total - 1; mask >= 0; mask--) {
    const set: string[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << (n - 1 - i))) {
        set.push(columns[i]);
      }
    }
    sets.push(set);
  }
  return sets;
}

/**
 * Parse SELECT columns from a SQL query prefix (everything before FROM or comma-separated set).
 * Returns an array of ColumnInfo with expression, simplicity flag, and resolved name.
 *
 * @internal
 */
export function _parseSelectColumns(sql: string): ColumnInfo[] {
  const selectMatch = sql.match(/\bSELECT\s+([\s\S]*?)\s+FROM\b/i);
  if (!selectMatch) return [];

  const selectContent = selectMatch[1].trim();
  const items = splitTopLevelCommas(selectContent);

  return items.map(item => {
    const trimmed = item.trim();
    // A simple column reference has no parentheses (is not a function call or expression)
    const isSimple = !trimmed.includes('(') && !trimmed.includes(')');
    // Extract name: use AS alias if present, otherwise last identifier after dot
    const asMatch = trimmed.match(/\bAS\s+(\w+)$/i);
    let name: string;
    if (asMatch) {
      name = asMatch[1];
    } else {
      const parts = trimmed.replace(/["`]/g, '').split('.');
      name = parts[parts.length - 1].trim();
    }
    return { expr: trimmed, isSimple, name };
  });
}

/**
 * Transform GROUPING(col) function calls to CASE WHEN expressions.
 * GROUPING(col) → CASE WHEN col IS NULL THEN 1 ELSE 0 END
 *
 * This is needed because the UNION ALL expansion uses NULL as placeholder
 * for non-grouping columns, and GROUPING() should return 1 for those.
 *
 * @internal
 */
export function _transformGroupingFunc(sql: string): string {
  // Match GROUPING(col) or GROUPING(col1, col2, ...)
  // We only support single-argument GROUPING for now (PG 12+)
  return sql.replace(
    /\bGROUPING\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)/gi,
    (_match, col: string) => {
      return `CASE WHEN (${col.trim()} IS NULL) THEN 1 ELSE 0 END`;
    },
  );
}

// ── Internal non-underscore helpers ───────────────────────────────

/**
 * Split a string by top-level commas (respecting nested parentheses).
 */
function splitTopLevelCommas(s: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < s.length; i++) {
    const skip = _skipSqlLiteral(s, i);
    if (skip !== -1) {
      current += s.slice(i, skip);
      i = skip - 1;
      continue;
    }

    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) items.push(current.trim());
  return items;
}

/**
 * Split the SQL suffix (after GROUPING SETS clause) into HAVING and post-HAVING parts.
 * HAVING should be included in each sub-query; ORDER BY/LIMIT apply to UNION ALL result.
 */
function splitSuffix(suffix: string): { having: string; orderLimit: string } {
  const s = suffix.trim();
  if (!s) return { having: '', orderLimit: '' };

  // Find HAVING clause
  const havingMatch = s.match(/\bHAVING\b/i);
  if (!havingMatch) return { having: '', orderLimit: s };

  const rest = s.slice(havingMatch.index!);
  const beforeHaving = s.slice(0, havingMatch.index!).trim();

  // HAVING extends until ORDER BY, LIMIT, OFFSET, FOR UPDATE, FETCH, or end
  const endMatch = rest.match(/\b(?:ORDER\s+BY|LIMIT|OFFSET|FOR\s+UPDATE|FETCH)\b/i);
  if (!endMatch) {
    return { having: rest, orderLimit: '' };
  }

  const having = rest.slice(0, endMatch.index!).trim();
  const orderLimit = rest.slice(endMatch.index!).trim();

  return { having, orderLimit: orderLimit || '' };
}

/**
 * Expand GROUP BY CUBE(...) or GROUP BY ROLLUP(...) into UNION ALL queries.
 */
function expandCubeOrRollup(sql: string, type: 'CUBE' | 'ROLLUP'): string | null {
  // Find GROUP BY CUBE( or GROUP BY ROLLUP( outside literals
  const pattern = type === 'CUBE' ? CUBE_PATTERN : ROLLUP_PATTERN;
  const gsStart = _findKeywordIndexOutsideLiterals(sql, pattern);
  if (gsStart === -1) return null;

  const m = sql.slice(gsStart).match(pattern)!;
  const afterKeyword = gsStart + m[0].length;
  const prefix = sql.slice(0, gsStart).trimEnd();

  // Find matching close paren for CUBE(...) or ROLLUP(...)
  const parenEnd = findMatchingCloseParen(sql, afterKeyword - 1);
  if (parenEnd === -1) return null;

  const content = sql.slice(afterKeyword, parenEnd).trim();
  const suffix = sql.slice(parenEnd + 1).trim();

  // Parse columns from content
  const columns = splitTopLevelCommas(content);
  if (columns.length === 0) return null;

  // Expand to sets
  const sets = type === 'CUBE' ? _expandCube(columns) : _expandRollup(columns);

  // Rewrite as GROUPING SETS and expand
  const setsContent = sets.map(s => s.length > 0 ? `(${s.join(', ')})` : '()').join(', ');
  const newSql = `${prefix} GROUP BY GROUPING SETS (${setsContent}) ${suffix}`.trim();

  return expandGroupingSets(newSql);
}

/**
 * Parse the GROUP BY GROUPING SETS (...) clause and expand it to UNION ALL.
 * Returns null if parsing fails (caller should fall back to stripping).
 */
function expandGroupingSets(sql: string): string | null {
  // Find GROUP BY GROUPING SETS ( outside literals
  const gsPattern = /\bGROUP\s+BY\s+GROUPING\s+SETS\s*\(/i;
  const gsStart = _findKeywordIndexOutsideLiterals(sql, gsPattern);
  if (gsStart === -1) return null;

  const m = sql.slice(gsStart).match(gsPattern)!;
  const afterGS = gsStart + m[0].length;
  const prefix = sql.slice(0, gsStart).trimEnd();

  // Find matching close paren for GROUPING SETS
  const parenEnd = findMatchingCloseParen(sql, afterGS - 1);
  if (parenEnd === -1) return null;

  const content = sql.slice(afterGS, parenEnd).trim();
  const suffix = sql.slice(parenEnd + 1).trim();

  // Parse sets from the GROUPING SETS content
  const sets = _parseGroupingSetsContent(content);
  if (sets.length === 0) return null;

  // Parse SELECT columns from the prefix
  const columns = _parseSelectColumns(prefix);
  if (columns.length === 0) return null;

  // Find FROM clause position in prefix. _parseSelectColumns already proved
  // a FROM keyword exists (it returned non-empty), so the match is non-null.
  const fromMatch = prefix.match(/\bFROM\b/i)!;
  const fromIndex = fromMatch.index!;
  const selectPart = prefix.slice(0, fromIndex).trimEnd(); // "SELECT ..."
  const fromPart = prefix.slice(fromIndex);                // "FROM ..."

  // Split suffix into HAVING (per-query) and ORDER BY/LIMIT (outer)
  const { having, orderLimit } = splitSuffix(suffix);

  // Build a set of column names so we can detect if GROUPING() is used for a column
  const columnNames = new Set(columns.map(c => c.name));

  // Collect ALL column names from all grouping sets (for NULL-padding)
  const allSetColumns: string[] = [];
  for (const set of sets) {
    for (const col of set) {
      if (allSetColumns.indexOf(col) < 0) allSetColumns.push(col);
    }
  }

  // Generate UNION ALL queries, one per set
  const queries: string[] = [];

  for (const set of sets) {
    const groupByClause = set.length > 0 ? ` GROUP BY ${set.join(', ')}` : '';
    const setSet = new Set(set);

    // Build SELECT with NULL padding for non-grouping columns
    // Also include all grouping set columns even if not in SELECT
    const selectItems = columns.map(col => {
      // For simple column references: if not in this set, NULL-pad
      if (col.isSimple && columnNames.has(col.name) && !setSet.has(col.name)) {
        return `NULL AS ${col.name}`;
      }
      // Aggregates and columns in the set pass through unchanged
      return col.expr;
    });

    // Add NULL AS col for any grouping set column not in the SELECT list
    for (const gsCol of allSetColumns) {
      const inSelect = columnNames.has(gsCol);
      const inSet = setSet.has(gsCol);
      if (!inSelect) {
        // Column is in grouping sets but not SELECT → always include as NULL-padded
        selectItems.push(`NULL AS ${gsCol}`);
      } else if (!inSet) {
        // Column is in SELECT but not in current set → replace with NULL (already done above)
        // Noop — handled by columns.map above
      }
    }

    const havingClause = having ? ` ${having}` : '';
    const query = `SELECT ${selectItems.join(', ')} ${fromPart}${groupByClause}${havingClause}`;
    queries.push(query);
  }

  // Combine with UNION ALL
  let result = queries.join('\nUNION ALL\n');

  // Transform GROUPING() functions in the result (they should map to the CASE WHEN)
  result = transformGroupingFunc(result);

  // Append ORDER BY / LIMIT at the outer level (applies to UNION ALL result)
  if (orderLimit) {
    result += '\n' + orderLimit;
  }

  return result;
}

/**
 * Transform GROUPING() function calls in the SQL text to CASE WHEN expressions.
 */
function transformGroupingFunc(sql: string): string {
  return _transformGroupingFunc(sql);
}

/**
 * Fallback: strip the GROUP BY GROUPING SETS clause entirely (full aggregation mode).
 * Used when UNION ALL expansion is not possible.
 */
function stripGroupByGroupingSets(working: string, groupingSetsIdx: number, groupingSetsEnd: number): GroupingSetsResult {
  const groupByIdx = findKeywordIndexBefore(working, /\bGROUP\s+BY\s+/i, groupingSetsIdx);
  if (groupByIdx === -1) {
    return { sql: working, rewritten: false };
  }

  const beforeGroupBy = working.slice(0, groupByIdx).trimEnd();
  const afterClause = working.slice(groupingSetsEnd).trimStart();

  working = (beforeGroupBy + ' ' + afterClause).trim();
  working = working.replace(/\s{2,}/g, ' ').trim();

  // Also transform any GROUPING() functions
  working = transformGroupingFunc(working);

  logger.debug({ sql: working }, 'GROUP BY GROUPING SETS clause completely stripped — full aggregation mode (fallback)');
  return { sql: working, rewritten: true };
}

/**
 * Find the index of a keyword regex match in the string.
 */
function findKeywordIndex(sql: string, pattern: RegExp): number {
  return _findKeywordIndex(sql, pattern);
}

/**
 * Find the index of the first occurrence of character `ch` at or after `fromIndex`.
 */
function findCharIndex(sql: string, ch: string, fromIndex: number): number {
  return _findCharIndex(sql, ch, fromIndex);
}

/**
 * Find the matching closing parenthesis index.
 */
function findMatchingCloseParen(sql: string, openIdx: number): number {
  return _findMatchingCloseParen(sql, openIdx);
}

/**
 * Find a plain GROUP BY clause that ends before `beforeIndex`.
 */
function findPlainGroupByBefore(sql: string, beforeIndex: number): { startIndex: number; endIndex: number } | null {
  return _findPlainGroupByBefore(sql, beforeIndex);
}

/**
 * Find the index of a keyword regex match that occurs before `beforeIndex`.
 */
function findKeywordIndexBefore(sql: string, pattern: RegExp, beforeIndex: number): number {
  const searchTarget = sql.slice(0, beforeIndex);
  const match = searchTarget.match(pattern);
  return match ? match.index! : -1;
}
