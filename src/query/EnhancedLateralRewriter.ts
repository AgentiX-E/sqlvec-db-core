/**
 * EnhancedLateralRewriter — LATERAL JOIN rewriting with correlation detection.
 *
 * Builds on the basic LateralJoinRewriter to handle correlated subqueries:
 * when a LATERAL subquery references columns from the outer query via outer
 * aliases (e.g., `u.id` where `u` is an outer alias).
 *
 * SQLite 3.33+ supports the LATERAL keyword natively, including correlation
 * semantics (referencing outer columns). For SQLite versions that do support
 * LATERAL, this module passes through by default.
 *
 * **Warning strategy:**
 * The `CORRELATION-SEMANTIC-GAP` warning is only emitted for correlation refs
 * that appear OUTSIDE the WHERE clause (e.g., in the SELECT list). These truly
 * cannot be rewritten without manual SQL transformation. Most correlation refs
 * appear in WHERE clause conditions (e.g., `WHERE inner.x = outer.y`), which
 * works correctly after LATERAL → CROSS JOIN rewrite, so no warning is emitted.
 *
 * **Strategy:**
 * - Non-correlated LATERAL: use basic keyword strip via LateralJoinRewriter
 * - Correlated LATERAL with WHERE-clause refs: rewrite without semantic gap warning
 * - Correlated LATERAL with non-WHERE refs: rewrite with semantic gap warning
 *   (only these truly require manual rewriting)
 */

import { PinoLogger } from '../logger/PinoLogger';
import { detectLateral, rewriteLateral, type LateralResult } from './LateralJoinRewriter';
import { detectCorrelation, type CorrelationRef } from './CorrelationDetector';

const logger = PinoLogger.forComponent('EnhancedLateralRewriter');

// ---- Types ----

export interface EnhancedLateralOptions {
  /** Force LATERAL keyword removal (default: false — passthrough for SQLite 3.33+) */
  forceRewrite?: boolean;
  /**
   * Explicit outer aliases to use for correlation detection.
   * If not provided, the rewriter attempts to auto-detect them from the
   * FROM clause before each LATERAL keyword.
   */
  outerAliases?: string[];
}

export interface EnhancedLateralResult extends LateralResult {
  /** Whether any correlated LATERAL subqueries were detected */
  hasCorrelation: boolean;
  /** List of detected correlation references across all LATERAL subqueries */
  correlationRefs: CorrelationRef[];
  /** Warnings emitted per subquery */
  warnings: string[];
}

// ---- Constants ----

/**
 * Warning comment appended when a correlated LATERAL subquery is rewritten.
 * The user/developer must manually rewrite the SQL for production use.
 */
const CORRELATION_GAP_WARNING =
  '/* CORRELATION-SEMANTIC-GAP: LATERAL subquery references outer column(s). Cross-join may produce cartesian product. Consider manual SQL rewriting for production use. */';

/**
 * Matches LATERAL keyword as a whole word.
 */
const LATERAL_RE = /\bLATERAL\b/i;

/**
 * Matches a LATERAL subquery with balanced parentheses.
 * After LATERAL, finds the opening `(` and extracts the content between
 * matching parentheses.
 */
const LATERAL_SUBQUERY_OPEN_RE = /\bLATERAL\s*\(/gi;

// ---- Internal Helpers ----

/**
 * Extract the contents of a parenthesized group starting at `openParenIndex`.
 * Handles nested parentheses correctly.
 * Returns `{ innerSql, fullContent, endIndex }` where innerSql is the text
 * between (and excluding) the outer parens, fullContent includes the parens,
 * and endIndex is the index of the closing paren.
 */
function extractParenthesizedContent(
  sql: string,
  openParenIndex: number,
): { innerSql: string; fullContent: string; endIndex: number } | null {
  if (sql[openParenIndex] !== '(') {
    return null;
  }

  let depth = 1;
  let inString = false;
  let stringChar: string | null = null;
  let i = openParenIndex + 1;

  while (i < sql.length && depth > 0) {
    const ch = sql[i];

    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true;
      stringChar = ch;
      i++;
      continue;
    }

    if (ch === '-' && i + 1 < sql.length && sql[i + 1] === '-') {
      // Single-line comment
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && i + 1 < sql.length && sql[i + 1] === '*') {
      // Multi-line comment
      i += 2;
      while (i + 1 < sql.length) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }

    if (depth > 0) i++;
  }

  if (depth !== 0) {
    return null; // Unmatched parens
  }

  return {
    innerSql: sql.substring(openParenIndex + 1, i),
    fullContent: sql.substring(openParenIndex, i + 1),
    endIndex: i,
  };
}

/**
 * Extract table aliases from the FROM clause before a LATERAL position.
 *
 * Parses the section `FROM ... [JOIN ...]` up to the LATERAL keyword, extracts
 * table references and their aliases.
 *
 * For nested LATERAL (LATERAL inside LATERAL), also extracts aliases from outer
 * FROM clauses (the ones in parent subqueries), not just the immediate FROM.
 *
 * e.g., `SELECT * FROM users u, LATERAL (SELECT * FROM orders o WHERE o.x = u.id)`
 *       → `['u', 'o']` (both `u` from outer and `o` from inner FROM)
 */
function extractOuterAliases(fullSql: string, lateralIndex: number): string[] {
  const before = fullSql.substring(0, lateralIndex);

  // Find ALL FROM keywords in the text before LATERAL (handles nested queries)
  const aliases: string[] = [];
  const knownKeywords = new Set([
    'as', 'on', 'using', 'where', 'group', 'order', 'having',
    'limit', 'offset', 'inner', 'outer', 'left', 'right', 'cross',
    'natural', 'join', 'full', 'select', 'from', 'lateral',
    'and', 'or', 'not', 'in', 'exists', 'is', 'null', 'true', 'false',
    'by', 'asc', 'desc', 'distinct', 'all', 'union', 'intersect',
    'except', 'when', 'then', 'else', 'end', 'case', 'with',
    'for', 'some', 'any', 'like', 'between', 'ilike',
  ]);

  // Collect from each FROM clause, working backwards
  let searchPos = before.length;
  while (searchPos > 0) {
    const fromMatch = before.substring(0, searchPos).match(/\bFROM\s+/i);
    if (!fromMatch) break;

    const fromStart = fromMatch.index! + fromMatch[0].length;
    // Find the end of this FROM clause (next SELECT/WHERE/LATERAL at same paren depth)
    const fromEnd = findClauseEnd(before, fromStart);
    const fromClauseText = before.substring(fromStart, fromEnd);

    // Split by top-level commas to get individual table references
    const parts = splitTopLevel(fromClauseText, ',');

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Skip subqueries (parenthesized expressions)
      if (trimmed.startsWith('(')) continue;
      // Remove ON/WHERE/etc. after the table ref if present
      const cleaned = trimmed.replace(/\s+(ON|WHERE|ORDER|GROUP|LIMIT|HAVING)\s.*$/i, '').trim();
      if (!cleaned) continue;
      // Get words in this table reference
      const words = cleaned.split(/\s+/).filter(w => w.length > 0);
      if (words.length === 0) continue;
      // The alias is typically the last identifier
      let aliasCandidate = words[words.length - 1].replace(/[(),;]/g, '');
      if (!aliasCandidate || knownKeywords.has(aliasCandidate.toLowerCase())) {
        for (let i = words.length - 1; i >= 0; i--) {
          const w = words[i].replace(/[(),;]/g, '');
          if (w && !knownKeywords.has(w.toLowerCase())) {
            aliasCandidate = w;
            break;
          }
        }
      }
      if (aliasCandidate && !knownKeywords.has(aliasCandidate.toLowerCase())) {
        if (!aliases.includes(aliasCandidate)) {
          aliases.push(aliasCandidate);
        }
      }
    }

    searchPos = fromMatch.index!;
  }

  return aliases;
}

/**
 * Find the end boundary of a clause starting at `startPos`.
 * Scans forward until it hits a SELECT, WHERE, LATERAL, GROUP BY, ORDER BY,
 * LIMIT, HAVING keyword at paren depth 0, or until the end of the string.
 */
function findClauseEnd(sql: string, startPos: number): number {
  let depth = 0;
  let inString = false;
  let stringChar: string | null = null;
  const clauseEnders = /\b(SELECT|WHERE|LATERAL|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING)\b/i;

  for (let i = startPos; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }

    if (depth === 0) {
      clauseEnders.lastIndex = i;
      const enderMatch = sql.substring(i).match(clauseEnders);
      if (enderMatch && enderMatch.index === 0) {
        return i;
      }
    }
  }

  return sql.length;
}

/**
 * Split a SQL text by a delimiter character at the top level
 * (depth 0 in parentheses), respecting string literals.
 */
function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (ch === '\\') {
        current += ch + (text[i + 1] || '');
        i++;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      current += ch;
      continue;
    }

    if (ch === delimiter && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    parts.push(current);
  }

  return parts;
}

/**
 * Check whether a correlation reference is inside a WHERE clause of a subquery.
 *
 * A correlation ref in the WHERE clause (e.g., `WHERE inner.x = outer.y`) is
 * safe to rewrite with LATERAL → CROSS JOIN, because the WHERE condition
 * still evaluates the same way. A ref in the SELECT list or other clause would
 * become invalid after LATERAL is stripped, so it truly needs manual rewriting.
 *
 * @param subquerySql - The SQL text inside the LATERAL subquery's parentheses
 * @param refPos       - The position of the correlation ref in subquerySql
 * @returns            - true if the ref is in WHERE clause context
 */
function isRefInWhereClause(subquerySql: string, refPos: number): boolean {
  if (refPos <= 0) return false;
  const beforeRef = subquerySql.substring(0, refPos).toLowerCase();

  // Scan backwards from refPos to find the last occurrence of WHERE, FROM, or SELECT
  // Simple approach: find the last WHERE before the ref, and check that
  // it's not inside a nested subquery (i.e., the paren depth at WHERE position
  // should be 0 for top-level WHERE).
  const whereIdx = beforeRef.lastIndexOf('where');
  if (whereIdx < 0) return false;

  // If there's a FROM keyword between WHERE and the ref, the ref might be
  // in a nested subquery, not the top-level WHERE
  const textFromWhere = beforeRef.substring(whereIdx + 5);
  if (textFromWhere.includes(' from ')) {
    return false; // Ref is after a FROM inside WHERE — likely in a nested subquery
  }

  // Check that the ref isn't in SELECT (before FROM) by verifying FROM appears before WHERE
  const fromIdx = beforeRef.lastIndexOf(' from ');
  if (fromIdx >= 0 && fromIdx > whereIdx) {
    return false; // FROM appears after WHERE — shouldn't happen, but defensive
  }

  return true;
}

/**
 * Check if a correlation reference appears in a WHERE clause context by scanning
 * the subquery SQL. Unlike isRefInWhereClause which uses position, this function
 * uses the refFullRef string to locate and check.
 */
function refIsInWhereClause(subquerySql: string, fullRef: string): boolean {
  const lowerSql = subquerySql.toLowerCase();
  const lowerRef = fullRef.toLowerCase();
  const refPos = lowerSql.indexOf(lowerRef);
  if (refPos < 0) return false;
  return isRefInWhereClause(subquerySql, refPos);
}

// ---- Public API ----

/**
 * Enhanced LATERAL rewriting with correlation detection.
 *
 * @param sql - The full SQL statement to rewrite
 * @param options - Rewrite options
 * @returns EnhancedLateralResult with rewrite + correlation metadata
 *
 * @example
 * ```ts
 * const r = rewriteLateralEnhanced(
 *   "SELECT * FROM users u, LATERAL (SELECT * FROM orders o WHERE o.user_id = u.id) sub",
 *   { forceRewrite: true }
 * );
 * // r.hasCorrelation === true
 * // r.correlationRefs === [{ alias: 'u', column: 'id', fullRef: 'u.id' }]
 * // r.sql contains placeholder and warning comment
 * ```
 */
export function rewriteLateralEnhanced(
  sql: string,
  options?: EnhancedLateralOptions,
): EnhancedLateralResult {
  const result: EnhancedLateralResult = {
    sql,
    rewritten: false,
    hasCorrelation: false,
    correlationRefs: [],
    warnings: [],
  };

  // No LATERAL → pass through
  if (!detectLateral(sql)) {
    return result;
  }

  // Default: passthrough for SQLite 3.33+ native support
  if (!options?.forceRewrite) {
    return {
      ...result,
      sql,
      rewritten: false,
    };
  }

  // ---
  // Force rewrite mode
  //
  // Strategy for correlated LATERAL:
  // 1. Find each LATERAL subquery, extract its inner SQL
  // 2. Detect outer aliases from the text before each LATERAL
  // 3. Detect correlation in each subquery
  // 4. Process occurrences in reverse order (preserve positions)
  //    a. Replace correlation refs with placeholders inside the subquery
  //    b. Replace the `context LATERAL (` pattern using the same regex
  //       patterns as the basic LateralJoinRewriter
  // 5. Inject gap warning comment if any correlation was found
  // ---

  let rewrittenSql = sql;
  let anyRewritten = false;
  let gapWarningAdded = false;

  // Find all LATERAL occurrences
  const occurrences = findAllCorrelatedLateralOccurrences(rewrittenSql, options?.outerAliases);

  // Process in reverse order to preserve positions after modifications
  for (let idx = occurrences.length - 1; idx >= 0; idx--) {
    const occ = occurrences[idx];

    if (occ.hasCorrelation) {
      // ---- Correlated LATERAL ----
      result.hasCorrelation = true;
      result.correlationRefs.push(...occ.correlation.refs);

      // ── Check if we can do a scalar subquery rewrite ──
      // This applies when: single-column SELECT, non-WHERE correlation refs, no own FROM
      if (occ.singleColumnSelect && !occ.allRefsInWhere && !occ.hasOwnFrom) {
        const scalarRewrite = tryScalarSubqueryRewrite(
          rewrittenSql,
          occ.lateralKwIndex,
          occ.context,
          occ.subqueryInnerSql,
          occ.subqueryAlias || '',
          occ.correlation.refs,
        );
        rewrittenSql = scalarRewrite.sql;
        anyRewritten = true;
        if (scalarRewrite.warning) {
          result.warnings.push(scalarRewrite.warning);
        }
        logger.debug(
          { subqueryAlias: occ.subqueryAlias, sqlSlice: occ.subqueryInnerSql.substring(0, 60) },
          'Single-column LATERAL with SELECT-list correlation rewritten as correlated scalar subquery',
        );
        continue; // skip CROSS JOIN + warning path
      }

      // ── Otherwise: existing CROSS JOIN + optional warning ──
      // Determine if ALL correlation refs are in WHERE clause context.
      // If all are in WHERE, the CROSS JOIN rewrite is safe (WHERE clause
      // handles correlation). If any ref is NOT in WHERE (e.g., in SELECT),
      // it would break after LATERAL is stripped, so we need a warning.
      const allRefsInWhere = occ.correlation.refs.every(r =>
        refIsInWhereClause(occ.subqueryInnerSql, r.fullRef),
      );

      // Step a: Replace correlation refs with placeholders inside the subquery
      // We need to locate the correlation ref text within the full SQL
      const subqueryStartInFull = rewrittenSql.indexOf(occ.subqueryInnerSql, occ.lateralKwIndex);
      if (subqueryStartInFull >= 0) {
        for (const ref of occ.correlation.refs) {
          const refPattern = new RegExp(`\\b${ref.alias}\\.${ref.column}\\b`);
          const subquerySlice = rewrittenSql.substring(
            subqueryStartInFull,
            subqueryStartInFull + occ.subqueryInnerSql.length,
          );
          const refMatch = subquerySlice.match(refPattern);
          if (refMatch) {
            const refStart = subqueryStartInFull + refMatch.index!;
            const refEnd = refStart + refMatch[0].length;
            rewrittenSql =
              rewrittenSql.substring(0, refStart) +
              `/* CORR(${refMatch[0]}) */` +
              rewrittenSql.substring(refEnd);
          }
        }
      }

      // Step b: Replace the `context LATERAL` with appropriate join keyword
      // Uses the same regex patterns as LateralJoinRewriter
      rewrittenSql = rewriteOneLateralContext(rewrittenSql, occ.lateralKwIndex, occ.context);

      anyRewritten = true;

      // Step c: Add gap warning only if any correlation ref is NOT in WHERE clause.
      // WHERE-clause refs are safe with CROSS JOIN; non-WHERE refs are truly problematic.
      if (!allRefsInWhere && !gapWarningAdded) {
        if (rewrittenSql.endsWith(';')) {
          rewrittenSql = rewrittenSql.slice(0, -1) + '\n' + CORRELATION_GAP_WARNING + ';';
        } else {
          rewrittenSql = rewrittenSql + '\n' + CORRELATION_GAP_WARNING;
        }
        gapWarningAdded = true;
      }

      if (!allRefsInWhere) {
        const refList = occ.correlation.refs.map(r => r.fullRef).join(', ');
        result.warnings.push(
          `LATERAL subquery references outer column(s) outside WHERE clause: [${refList}]. ` +
          'Cross-join may produce cartesian product. Manual SQL rewriting required.',
        );
        logger.warn(
          { refs: occ.correlation.refs.map(r => r.fullRef), outerAliases: occ.outerAliases },
          'Correlated LATERAL subquery with non-WHERE refs detected — semantic gap warning injected',
        );
      } else {
        logger.debug(
          { refs: occ.correlation.refs.map(r => r.fullRef) },
          'Correlated LATERAL subquery with WHERE-clause refs — no semantic gap warning needed',
        );
      }
    } else if (occ.hasCorrelation && !occ.allRefsInWhere && occ.singleColumnSelect) {
      // ---- Correlated LATERAL with single-column SELECT list refs → scalar subquery ----
      // Transformation: remove LATERAL, keep the subquery as correlated scalar subquery.
      // The outer column refs are in scope when the subquery is in scalar position.
      const scalarRewrite = tryScalarSubqueryRewrite(
        rewrittenSql,
        occ.lateralKwIndex,
        occ.context,
        occ.subqueryInnerSql,
        occ.subqueryAlias || '',
        occ.correlation.refs,
      );
      rewrittenSql = scalarRewrite.sql;
      anyRewritten = true;
      if (scalarRewrite.warning) {
        result.warnings.push(scalarRewrite.warning);
      }
      // Log success: single-column LATERAL converted to scalar subquery
      logger.debug(
        { subqueryAlias: occ.subqueryAlias, sqlSlice: occ.subqueryInnerSql.substring(0, 60) },
        'Single-column LATERAL with SELECT-list correlation rewritten as correlated scalar subquery',
      );
    } else {
      // ---- Non-correlated LATERAL: use basic keyword strip ----
      // Apply only to this specific occurrence's context area
      rewrittenSql = rewriteOneLateralContext(rewrittenSql, occ.lateralKwIndex, occ.context);
      anyRewritten = true;
    }
  }

  // Final pass: strip any remaining standalone LATERAL keywords (edge cases)
  // This handles cases where the basic patterns might not have caught everything
  if (LATERAL_RE.test(rewrittenSql)) {
    rewrittenSql = rewrittenSql.replace(LATERAL_RE, '');
    anyRewritten = true;
  }

  return {
    ...result,
    sql: rewrittenSql,
    rewritten: anyRewritten,
  };
}

// ---- Internal: Scalar subquery rewrite for single-column SELECT-list correlation ----

interface ScalarRewriteResult {
  sql: string;
  warning: string | null;
}

/**
 * Attempt to rewrite a correlated LATERAL subquery with SELECT-list correlation
 * into a correlated scalar subquery in the outer SELECT list.
 *
 * Only applicable when the LATERAL subquery has a single-column SELECT list.
 *
 * ## No-FROM Case (fully resolved):
 *   `SELECT * FROM users u, LATERAL (SELECT u.name AS uname) sub`
 *   → `SELECT *, (SELECT u.name) AS uname FROM users u`
 *
 * ## With-FROM Case (kept in FROM as scalar, still needs manual review):
 *   → warning message returned
 *
 * @param fullSql - Full SQL statement
 * @param lateralKwIndex - Index of LATERAL keyword in fullSql
 * @param context - Context text before LATERAL (e.g., ", ", "FROM ")
 * @param subqueryInnerSql - Inner SQL of the LATERAL subquery (between parens)
 * @param subqueryAlias - Alias after the closing paren (e.g., "sub")
 * @param correlationRefs - Correlation references detected
 */
function tryScalarSubqueryRewrite(
  fullSql: string,
  lateralKwIndex: number,
  context: string,
  subqueryInnerSql: string,
  subqueryAlias: string,
  correlationRefs: CorrelationRef[],
): ScalarRewriteResult {
  // Only handle single-column SELECT subqueries
  if (!checkSingleColumnSelect(subqueryInnerSql)) {
    return { sql: fullSql, warning: null };
  }

  const innerClean = subqueryInnerSql.trim();

  // Extract the SELECT expression (remove the SELECT keyword)
  const selectExpr = innerClean.replace(/^SELECT\s+/i, '').trim();

  // Determine the effective alias for the scalar subquery
  const alias = subqueryAlias || extractColumnAlias(selectExpr);

  // Check if the subquery has its own FROM clause
  const hasOwnFrom = /\bFROM\b/i.test(innerClean);

  if (!hasOwnFrom) {
    // ── No FROM case: move to outer SELECT list ──
    const beforeLateral = fullSql.substring(0, lateralKwIndex);
    const fromMatch = beforeLateral.match(/\bFROM\b/i);
    if (!fromMatch) return { sql: fullSql, warning: null };
    const selectFromIdx = fromMatch.index!;

    // Build scalar subquery expression, unqualified
    let scalarExpr = selectExpr;
    for (const ref of correlationRefs) {
      const refPattern = new RegExp(`\\b${escapeRegex(ref.alias)}\\.${escapeRegex(ref.column)}\\b`, 'g');
      scalarExpr = scalarExpr.replace(refPattern, ref.column);
    }

    // Strip the inline AS alias from the scalar expression
    const scalarExprClean = scalarExpr.replace(/\s+AS\s+\w+\s*$/i, '').trim();
    const scalarSubqueryExpr = `(SELECT ${scalarExprClean}) AS ${alias}`;

    // Find end of LATERAL entry (closing paren + optional alias)
    const afterLateralEntry = fullSql.indexOf(')', lateralKwIndex);
    if (afterLateralEntry < 0) return { sql: fullSql, warning: null };
    let entryEnd = afterLateralEntry + 1;
    const afterClose = fullSql.substring(entryEnd).match(/^\s+(?:AS\s+)?(\w+)/);
    if (afterClose) entryEnd += afterClose[0].length;

    // Reconstruct: insert scalar into SELECT list, remove LATERAL entry from FROM clause.
    // The entry to remove spans from the context keyword (e.g. comma, JOIN) up to the
    // end of the subquery alias. Find its start by scanning backwards from LATERAL.
    const beforeLateralForEntry = fullSql.substring(0, lateralKwIndex);
    const entryStartMatch = beforeLateralForEntry.match(/(?:FROM|,)\s*$/i);
    const entryStart = entryStartMatch
      ? lateralKwIndex - entryStartMatch[0].length
      : lateralKwIndex - context.length;
    const beforeFrom = fullSql.substring(0, selectFromIdx).trimEnd();
    const fromPart = fullSql.substring(selectFromIdx);

    // Add to SELECT list
    const newSelect = beforeFrom.endsWith(',')
      ? beforeFrom + ` ${scalarSubqueryExpr}`
      : beforeFrom + `, ${scalarSubqueryExpr}`;

    // Remove LATERAL entry from FROM clause
    const lateralEntryStr = fullSql.substring(entryStart, entryEnd);
    let fromCleaned = fromPart.replace(lateralEntryStr, '').replace(/,\s*,/g, ',').trim();
    fromCleaned = fromCleaned.replace(/,(\s*FROM)/i, ' $1');
    fromCleaned = fromCleaned.replace(/^(FROM\s*),/i, '$1 ');

    return {
      sql: newSelect + ' ' + fromCleaned,
      warning: null,
    };
  }

  // ── With FROM case: can't auto-rewrite. Return actionable warning ──
  return {
    sql: fullSql,
    warning: `LATERAL subquery with FROM clause has SELECT-list correlation refs. ` +
      `Cannot auto-rewrite. Move the subquery manually to the outer SELECT list: ` +
      `replace "LATERAL (SELECT ...)" with "(SELECT ...) AS ${alias}" in the outer SELECT list.`,
  };
}

/**
 * Extract a column alias from a SELECT expression.
 * Matches `expr AS alias` or `expr alias`.
 */
function extractColumnAlias(selectExpr: string): string {
  const asMatch = selectExpr.match(/\s+AS\s+([a-zA-Z_]\w*)\s*$/i);
  if (asMatch) return asMatch[1];
  const bareMatch = selectExpr.match(/\s+([a-zA-Z_]\w*)\s*$/);
  if (bareMatch) return bareMatch[1];
  const words = selectExpr.trim().split(/\s+/);
  return words[words.length - 1] || 'scalar';
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Internal: One occurrence at a time ----

interface LateralOccurrenceInfo {
  lateralKwIndex: number;
  context: string; // e.g. ", ", "FROM ", "LEFT JOIN ", etc.
  hasCorrelation: boolean;
  correlation: { refs: CorrelationRef[]; sqlWithoutCorrelation: string };
  subqueryInnerSql: string;
  outerAliases: string[];
  /** true if ALL correlation refs are in WHERE clause context */
  allRefsInWhere: boolean;
  /** true if the SELECT list has exactly 1 expression */
  singleColumnSelect: boolean;
  /** Alias name after the closing paren, e.g. "sub" from `LATERAL (...) sub` */
  subqueryAlias: string;
  /** true if the subquery inner SQL contains a FROM clause */
  hasOwnFrom: boolean;
}

/**
 * Find all LATERAL occurrences in SQL and detect correlation for each.
 */
function findAllCorrelatedLateralOccurrences(
  sql: string,
  explicitOuterAliases?: string[],
): LateralOccurrenceInfo[] {
  const occurrences: LateralOccurrenceInfo[] = [];
  const lateralRe = /\bLATERAL\s*\(/gi;
  let match: RegExpExecArray | null;

  // Collect all LATERAL positions first (before any modifications)
  const positions: Array<{ index: number; matchLen: number }> = [];
  while ((match = lateralRe.exec(sql)) !== null) {
    positions.push({ index: match.index, matchLen: match[0].length });
  }

  for (const pos of positions) {
    const lateralKwIndex = pos.index;
    const openParenIndex = lateralKwIndex + pos.matchLen - 1; // the `(` at the end

    // Extract context before LATERAL
    const before = sql.substring(0, lateralKwIndex);
    const context = extractContextBeforeLateral(before);

    // Extract subquery content (balanced parens)
    const parenContent = extractParenthesizedContent(sql, openParenIndex);
    if (!parenContent) continue;

    const subqueryInnerSql = parenContent.innerSql.trim();

    // Extract outer aliases
    let outerAliases: string[];
    if (explicitOuterAliases && explicitOuterAliases.length > 0) {
      outerAliases = explicitOuterAliases;
    } else {
      outerAliases = extractOuterAliases(sql, lateralKwIndex);
    }

    // Detect correlation
    const correlation = detectCorrelation(subqueryInnerSql, outerAliases);

    // Determine if ALL correlation refs are in WHERE clause context
    const allRefsInWhere = correlation.hasCorrelation
      ? correlation.refs.every(r => refIsInWhereClause(subqueryInnerSql, r.fullRef))
      : true;

    // Determine if single-column SELECT
    const singleColumnSelect = checkSingleColumnSelect(subqueryInnerSql);

    // Check if subquery has its own FROM clause
    const hasOwnFrom = /\bFROM\b/i.test(subqueryInnerSql);

    // Extract subquery alias (text after closing paren)
    const subqueryAlias = extractSubqueryAlias(sql, parenContent.endIndex);

    occurrences.push({
      lateralKwIndex,
      context,
      hasCorrelation: correlation.hasCorrelation,
      correlation,
      subqueryInnerSql,
      outerAliases,
      allRefsInWhere,
      singleColumnSelect,
      subqueryAlias,
      hasOwnFrom,
    });
  }

  return occurrences;
}

/**
 * Check if a subquery SQL has exactly one expression in its SELECT list.
 * Looks for the SELECT keyword and counts comma-separated expressions before FROM (or end).
 */
function checkSingleColumnSelect(subquerySql: string): boolean {
  // Strip leading/trailing whitespace
  const sql = subquerySql.trim();
  // Must start with SELECT
  if (!/^SELECT\s/i.test(sql)) return false;

  // Find the SELECT list: content between SELECT keyword and FROM (or WHERE, or end)
  const afterSelect = sql.replace(/^SELECT\s/i, '');
  // Find FROM keyword at top level
  const fromMatch = afterSelect.match(/\bFROM\b/i);
  const selectList = fromMatch
    ? afterSelect.substring(0, fromMatch.index).trim()
    : afterSelect.trim();

  if (!selectList) return false;

  // Split by commas at top level (respecting parens)
  const expressions = splitTopLevel(selectList, ',');
  return expressions.length === 1;
}

/**
 * Extract the alias name after a closing paren for a LATERAL subquery.
 * Pattern: `LATERAL (...content...) AS? alias_name`
 * Returns empty string if no alias is found.
 */
function extractSubqueryAlias(sql: string, closeParenIndex: number): string {
  const afterParen = sql.substring(closeParenIndex + 1).trim();
  // Try WITH or WITHOUT AS keyword
  const asMatch = afterParen.match(/^(?:\s+AS\s+|\s+)([a-zA-Z_]\w*)/);
  if (asMatch) return asMatch[1];
  return '';
}

/**
 * Extract the context keyword (e.g. ", ", "FROM ", "JOIN ", "LEFT JOIN ")
 * that appears immediately before LATERAL.
 */
function extractContextBeforeLateral(before: string): string {
  // Match common patterns: comma, FROM, JOIN variants
  const trimmed = before.trimEnd();
  const contextRe = /((?:FROM|,|(?:LEFT\s+|RIGHT\s+|INNER\s+|CROSS\s+|NATURAL\s+)?JOIN)\s*)$/i;
  const contextMatch = trimmed.match(contextRe);
  return contextMatch ? contextMatch[1] : '';
}

/**
 * Replace a single LATERAL occurrence (non-correlated) with the appropriate
 * join keyword, based on its context.
 *
 * Examples:
 *   `, LATERAL (`  → CROSS JOIN (
 *   `FROM LATERAL (` → CROSS JOIN (
 *   `JOIN LATERAL (` → INNER JOIN (
 *   `LEFT JOIN LATERAL (` → INNER JOIN (
 */
function rewriteOneLateralContext(
  sql: string,
  lateralKwIndex: number,
  context: string,
): string {
  if (!context) {
    // No context found — just strip LATERAL
    return sql.substring(0, lateralKwIndex) + sql.substring(lateralKwIndex + 7);
  }

  // Determine replacement based on context
  const ctxLower = context.trim().toLowerCase();
  let joinReplacement: string;

  if (ctxLower === 'from' || ctxLower === ',') {
    joinReplacement = 'CROSS JOIN ';
  } else if (ctxLower.endsWith('join') || ctxLower === 'join') {
    joinReplacement = 'INNER JOIN ';
  } else {
    // Unknown context — just remove LATERAL keyword
    joinReplacement = ' ';
  }

  // Remove context + LATERAL keyword, insert joinReplacement
  const contextEnd = lateralKwIndex;
  const contextStart = contextEnd - context.length;

  return (
    sql.substring(0, contextStart) +
    joinReplacement +
    sql.substring(contextEnd + 7) // skip "LATERAL" (7 chars)
  );
}
