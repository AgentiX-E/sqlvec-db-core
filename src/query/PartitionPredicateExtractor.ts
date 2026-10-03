/**
 * PartitionPredicateExtractor — Extract partition-key predicates from SELECT SQL.
 *
 * Uses regex-based matching (no full SQL parser) to extract WHERE clause
 * predicates that reference the partition key column. Supports common patterns:
 *   - col = value
 *   - col >= value / col <= value / col > value / col < value
 *   - col IN (a, b, c)
 *   - col BETWEEN x AND y
 *
 * Complex patterns (OR branches, subqueries, function calls) are intentionally
 * skipped — fall back to full partition scan.
 *
 * @module query/PartitionPredicateExtractor
 */

import { skipSqlLiteral } from './SqlLiteralScanner';

export interface PartitionPredicate {
  col: string;
  op: '=' | '<' | '<=' | '>' | '>=' | 'IN' | 'BETWEEN';
  value: any;
  /** For IN and BETWEEN: the list of values. */
  values?: any[];
}

/**
 * Strip a trailing PostgreSQL type cast (e.g. `::int`, `::text[]`) from a
 * value so the underlying literal can be type-inferred on its own.
 */
function stripTypeCast(raw: string): string {
  // A cast suffix is `::` followed by an identifier possibly with array
  // modifiers. The value itself never legitimately contains `::`, so the
  // first such suffix terminates the literal.
  const castIdx = raw.indexOf('::');
  return castIdx === -1 ? raw : raw.slice(0, castIdx);
}

/**
 * Normalise a quoted string literal back to its plain text value.
 *
 * Handles both single-quoted strings (`'...'`) and doubled-quote identifiers
 * (`"..."`), and decodes either doubled-quote escape (SQL standard `''` for a
 * single literal quote, and `""` inside identifiers).
 */
function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  return raw;
}

/**
 * Type-infer a string value.
 * - 'null' / 'NULL' → null
 * - 'true' / 'false' (any casing) → boolean
 * - integer / float / scientific-notation numeric strings → number
 * - quoted strings → string (quotes stripped, escapes decoded)
 * - everything else → string
 */
function inferValue(raw: string): any {
  let trimmed = raw.trim();

  // Remember whether a type cast was present before stripping it: a cast pins
  // the target type, so a quoted numeric with a cast (e.g. '5'::int) must still
  // infer as a number rather than a string.
  const hadCast = trimmed.includes('::');
  trimmed = stripTypeCast(trimmed).trim();

  const lower = trimmed.toLowerCase();

  if (lower === 'null') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;

  // Quoted string — strip surrounding quotes and decode escapes.
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const inner = unquote(trimmed);
    // With an explicit cast the inner literal's type is pinned; re-infer it so
    // e.g. '5'::int resolves to the number 5. Without a cast keep the string.
    return hadCast ? inferValue(inner) : inner;
  }

  // Numeric — integers, floats, and scientific notation.
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return trimmed.includes('.') || /[eE]/.test(trimmed)
      ? parseFloat(trimmed)
      : parseInt(trimmed, 10);
  }

  return trimmed;
}

/**
 * Read a single value token starting at `pos`, treating a quoted string or
 * identifier as one atomic token (so embedded spaces and commas are preserved)
 * and otherwise reading until whitespace or a structural delimiter.
 *
 * @returns The raw token text and the index just past it.
 */
function readValueToken(sql: string, pos: number): { raw: string; end: number } {
  // Skip leading whitespace.
  while (pos < sql.length && /\s/.test(sql[pos])) pos++;

  // A quoted construct is a single token regardless of inner content.
  const skip = skipSqlLiteral(sql, pos);
  if (skip !== -1) {
    let end = skip;
    // Absorb a trailing `::type` cast immediately after the literal.
    const cast = sql.slice(end).match(/^::[A-Za-z_][A-Za-z0-9_$]*(\[\])?/);
    if (cast) end += cast[0].length;
    return { raw: sql.slice(pos, end), end };
  }

  // Bare token: read until whitespace, comma, or closing paren.
  let j = pos;
  while (j < sql.length && !/\s/.test(sql[j]) && sql[j] !== ',' && sql[j] !== ')') {
    j++;
  }
  return { raw: sql.slice(pos, j), end: j };
}

/**
 * Infer a comma-separated value list (for IN clauses), splitting only on
 * top-level commas so commas *inside* string values are preserved.
 */
function inferValues(raw: string): any[] {
  // Strip the surrounding parentheses (the IN regex already captured the
  // balanced inner list; be defensive against a caller passing parens too).
  let inner = raw.trim();
  if (inner.startsWith('(') && inner.endsWith(')')) {
    inner = inner.slice(1, -1).trim();
  }

  const values: any[] = [];
  let i = 0;
  while (i < inner.length) {
    // Skip whitespace and stray structural delimiters between values.
    while (i < inner.length && (/\s/.test(inner[i]) || inner[i] === ',')) i++;
    if (i >= inner.length) break;

    const { raw: token, end } = readValueToken(inner, i);
    // A bare `)` (or any token read as empty) cannot be a value — step past it
    // so the loop always makes progress and never spins on a stray delimiter.
    if (end <= i) {
      i++;
      continue;
    }
    values.push(inferValue(token));
    i = end;
  }
  return values;
}

/**
 * Extract the WHERE clause text from a SELECT SQL string.
 *
 * Returns the text between WHERE and the next clause keyword
 * (GROUP BY, ORDER BY, LIMIT, HAVING, etc.), or null if no WHERE exists.
 */
export function extractWhereClause(sql: string): string | null {
  const whereMatch = sql.match(/\bWHERE\b\s+/i);
  if (!whereMatch) return null;

  const afterWhere = sql.slice((whereMatch.index || 0) + whereMatch[0].length);

  // Find the next clause keyword that ends the WHERE clause.
  const clauseMatch = afterWhere.match(
    /\b(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|OFFSET|FOR\s+UPDATE|FOR\s+SHARE|WINDOW|INTERSECT|EXCEPT|UNION)\b/i,
  );

  if (clauseMatch) {
    return afterWhere.slice(0, clauseMatch.index).trim();
  }

  // No following clause — everything after WHERE is the WHERE clause.
  return afterWhere.trim();
}

/**
 * Build a regex pattern that matches the partition key with optional double-quoted
 * identifier quotes. Handles both `col` and `"col"` syntax.
 */
function quotedKeyPattern(partitionKey: string): string {
  const escaped = escapeRegex(partitionKey.replace(/^"|"$/g, ''));
  // Match: col, "col" (optional surrounding double quotes)
  return `"?${escaped}"?`;
}

/**
 * Extract partition-key-related predicates from a SELECT SQL string.
 *
 * @param sql - The full SELECT SQL statement.
 * @param partitionKey - The partition key column name.
 * @returns An array of matching PartitionPredicate objects.
 */
export function extractPartitionPredicates(
  sql: string,
  partitionKey: string,
): PartitionPredicate[] {
  const whereClause = extractWhereClause(sql);
  if (!whereClause) return [];

  const predicates: PartitionPredicate[] = [];
  const keyPattern = quotedKeyPattern(partitionKey);

  // Split by AND — we only handle simple conjunction patterns.
  // Split carefully: we need to avoid splitting inside parenthesized subexpressions
  // or BETWEEN ... AND ... (which contains a literal 'AND').
  const andParts = splitOnAndOutsideParens(whereClause);

  for (const part of andParts) {
    const trimmed = part.trim();

    // Skip OR branches entirely (complex nested logic)
    if (containsOrOutsideParens(trimmed)) continue;

    // Match the key, then read the operator and value via literal-aware scanning
    // so quoted values containing spaces/commas/parentheses are not truncated.
    const pred = extractSinglePredicate(trimmed, partitionKey, keyPattern);
    if (pred) predicates.push(pred);
  }

  return predicates;
}

/**
 * Try to parse a single `key <op> value` predicate from a non-OR conjunction
 * fragment. Returns the predicate, or null if the fragment does not reference
 * the partition key with a supported operator.
 */
function extractSinglePredicate(
  fragment: string,
  partitionKey: string,
  keyPattern: string,
): PartitionPredicate | null {
  // Locate the key (optionally double-quoted) at the start of the fragment.
  // The trailing `(?![\w"])` guard prevents a partial match of a longer
  // identifier (e.g. `id` matching `idx`) while still allowing a closing
  // double quote to be followed directly by an operator or whitespace.
  const keyMatch = fragment.match(new RegExp(`^${keyPattern}(?![\\w"])`, 'i'));
  if (!keyMatch) return null;

  let i = keyMatch[0].length;
  const rest = fragment.slice(i);

  // IN ( ... )
  const inMatch = rest.match(/^\s+IN\s*\(/i);
  if (inMatch) {
    // `inMatch[0]` ends with the opening paren; point `openParen` at that
    // `(` character (not the token just after it).
    const openParen = i + (inMatch.index ?? 0) + inMatch[0].length - 1;
    // Find the matching close paren, skipping literals.
    const closeParen = findMatchingCloseParen(fragment, openParen);
    if (closeParen === -1) return null;
    const inner = fragment.slice(openParen + 1, closeParen);
    // An empty `IN ()` list is not a meaningful partition constraint — skip it.
    if (inner.trim() === '') return null;
    return {
      col: partitionKey,
      op: 'IN',
      value: null,
      values: inferValues(inner),
    };
  }

  // BETWEEN x AND y
  const betweenMatch = rest.match(/^\s+BETWEEN\s+/i);
  if (betweenMatch) {
    let j = i + (betweenMatch.index ?? 0) + betweenMatch[0].length;
    const first = readValueToken(fragment, j);
    j = first.end;
    // Expect ` AND ` after the first bound.
    const andMatch = fragment.slice(j).match(/^\s+AND\s+/i);
    if (!andMatch) return null;
    j += (andMatch.index ?? 0) + andMatch[0].length;
    const second = readValueToken(fragment, j);
    return {
      col: partitionKey,
      op: 'BETWEEN',
      value: null,
      values: [inferValue(first.raw), inferValue(second.raw)],
    };
  }

  // comparison: >=, <=, >, <, =
  const opMatch = rest.match(/^\s*(>=|<=|>|<|=)\s*/i);
  if (!opMatch) return null;
  const op = opMatch[1] as '>=' | '<=' | '>' | '<' | '=';
  const valuePos = i + (opMatch.index ?? 0) + opMatch[0].length;
  const valueToken = readValueToken(fragment, valuePos);
  return {
    col: partitionKey,
    op,
    value: inferValue(valueToken.raw),
  };
}

/**
 * Find the index of the `)` that closes the `(` at `openParen`, skipping over
 * any nested parentheses and quoted literals. Returns -1 if unbalanced.
 */
function findMatchingCloseParen(sql: string, openParen: number): number {
  let depth = 0;
  let i = openParen;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Split a WHERE clause string on AND, but only at the top level (outside parens)
 * and not inside BETWEEN ... AND.
 */
function splitOnAndOutsideParens(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;

  while (i < clause.length) {
    if (clause[i] === '(') {
      depth++;
      current += clause[i];
      i++;
      continue;
    }
    if (clause[i] === ')') {
      depth--;
      current += clause[i];
      i++;
      continue;
    }

    // Check for BETWEEN ... AND — we treat the whole BETWEEN as one unit
    if (depth === 0) {
      const betweenMatch = clause.slice(i).match(/^\s+BETWEEN\s+/i);
      if (betweenMatch) {
        // Find the corresponding AND that closes this BETWEEN
        const rest = clause.slice(i);
        const andIdx = findBetweenAndEnd(rest);
        if (andIdx > 0) {
          current += rest.slice(0, andIdx);
          i += andIdx;
          continue;
        }
      }
    }

    const andMatch = clause.slice(i).match(/^\s+AND\s+/i);
    if (depth === 0 && andMatch) {
      parts.push(current.trim());
      current = '';
      // Skip the AND keyword.
      i += andMatch[0].length;
      continue;
    }

    current += clause[i];
    i++;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

/**
 * Find the position of the AND that ends a BETWEEN clause.
 */
function findBetweenAndEnd(clause: string): number {
  let depth = 0;
  for (let i = 1; i < clause.length; i++) {
    if (clause[i] === '(') depth++;
    if (clause[i] === ')') depth--;
    if (depth === 0 && clause.slice(i).match(/^\s+AND\s+/i)) {
      // This is the AND that ends BETWEEN x AND y
      return i + clause.slice(i).match(/^\s+AND\s+/i)![0].length;
    }
  }
  return -1;
}

/**
 * Check if a clause contains OR at the top level (outside parens).
 */
function containsOrOutsideParens(clause: string): boolean {
  let depth = 0;
  for (let i = 0; i < clause.length; i++) {
    if (clause[i] === '(') depth++;
    if (clause[i] === ')') depth--;
    if (depth === 0 && clause.slice(i).match(/^\s+OR\s+/i)) {
      return true;
    }
  }
  return false;
}

/**
 * Escape regex metacharacters from a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
