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

export interface PartitionPredicate {
  col: string;
  op: '=' | '<' | '<=' | '>' | '>=' | 'IN' | 'BETWEEN';
  value: any;
  /** For IN and BETWEEN: the list of values. */
  values?: any[];
}

/**
 * Type-infer a string value.
 * - Numeric strings → number
 * - 'null' / 'NULL' → null
 * - Everything else → string (stripped of surrounding quotes)
 */
function inferValue(raw: string): any {
  const trimmed = raw.trim();

  if (trimmed.toLowerCase() === 'null') return null;

  // Quoted string — strip surrounding quotes
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }

  // Numeric
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed.includes('.') ? parseFloat(trimmed) : parseInt(trimmed, 10);
  }

  return trimmed;
}

/**
 * Infer multiple values from a parenthesized list (for IN clause).
 */
function inferValues(raw: string): any[] {
  // Strip surrounding parentheses and split by comma
  const inner = raw.trim();
  const trimmed = inner.startsWith('(') && inner.endsWith(')')
    ? inner.slice(1, -1)
    : inner;

  return trimmed.split(',').map((part) => inferValue(part.trim()));
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

    // col IN (a, b, c)
    const inMatch = trimmed.match(
      new RegExp(
        `${keyPattern}\\s+IN\\s*\\(([^)]+)\\)`,
        'i',
      ),
    );
    if (inMatch) {
      predicates.push({
        col: partitionKey,
        op: 'IN',
        value: null,
        values: inferValues(inMatch[1]),
      });
      continue;
    }

    // col BETWEEN x AND y
    const betweenMatch = trimmed.match(
      new RegExp(
        `${keyPattern}\\s+BETWEEN\\s+(\\S+)\\s+AND\\s+(\\S+)`,
        'i',
      ),
    );
    if (betweenMatch) {
      predicates.push({
        col: partitionKey,
        op: 'BETWEEN',
        value: null,
        values: [inferValue(betweenMatch[1]), inferValue(betweenMatch[2])],
      });
      continue;
    }

    // col >= value, col <= value, col > value, col < value, col = value
    const opMatch = trimmed.match(
      new RegExp(
        `${keyPattern}\\s*(>=|<=|>|<|=)\\s*(\\S+)`,
        'i',
      ),
    );
    if (opMatch) {
      const op = opMatch[1] as '>=' | '<=' | '>' | '<' | '=';
      predicates.push({
        col: partitionKey,
        op,
        value: inferValue(opMatch[2]),
      });
    }
  }

  return predicates;
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

    if (depth === 0 && clause.slice(i).match(/^\s+AND\s+/i)) {
      parts.push(current.trim());
      current = '';
      // Skip the AND keyword
      const andMatch = clause.slice(i).match(/^\s+AND\s+/i);
      if (andMatch) i += andMatch[0].length;
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
