/**
 * DefaultValuesShim.ts — SQL INSERT DEFAULT value replacement
 *
 * SQLite does not support the `DEFAULT` keyword in INSERT ... VALUES (...).
 * PG / Drizzle / Prisma generate queries like:
 *   INSERT INTO t (id, name) VALUES (DEFAULT, $1)
 *
 * This shim strips DEFAULT-value columns (and their corresponding VALUES)
 * so SQLite can use column-level defaults or auto-increment the primary key.
 */

/**
 * Strip DEFAULT-valued columns from INSERT ... VALUES statements.
 *
 * Input:  INSERT INTO t (id, name, created_at) VALUES (default, 'hello', default)
 * Output: INSERT INTO t (name) VALUES ('hello')
 */
export function stripDefaultValues(sql: string): string {
  // Only applies to INSERT ... VALUES ... statements. Use balanced-paren
  // scanning to locate the column and value lists so nested function calls
  // (e.g. VALUES (DEFAULT, func(1,2))) are not truncated at their first `)`.
  const insertMatch = sql.match(
    /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(`?"?\w+"?`?(?:\s*\.\s*`?"?\w+"?`?)?)\s*\(/is
  );
  if (!insertMatch) return sql;

  const tableName = insertMatch[1];
  const colsOpen = insertMatch[0].length; // position just after the `(` of columns
  const colsClose = findMatchingParen(sql, colsOpen - 1);
  if (colsClose === -1) return sql;

  const columnsRaw = sql.slice(colsOpen, colsClose);
  const afterCols = sql.slice(colsClose + 1);

  const valuesMatch = afterCols.match(/^\s*VALUES\s*\(/is);
  if (!valuesMatch) return sql;

  const valsOpen = valuesMatch[0].length; // position just after the `(` of values
  const valsClose = findMatchingParen(afterCols, valsOpen - 1);
  if (valsClose === -1) return sql;

  const valuesRaw = afterCols.slice(valsOpen, valsClose);
  const suffix = afterCols.slice(valsClose + 1).trim(); // RETURNING clause etc.

  const columns = splitCSV(columnsRaw);
  const values = splitCSV(valuesRaw);

  if (columns.length !== values.length) return sql; // can't process

  // Filter out pairs where value is DEFAULT (case-insensitive)
  const kept: Array<[string, string]> = [];
  for (let i = 0; i < columns.length; i++) {
    const val = values[i].trim();
    if (/^default$/i.test(val)) {
      continue; // strip this column+value pair
    }
    kept.push([columns[i].trim(), val]);
  }

  // If nothing kept, return original (shouldn't happen)
  if (kept.length === 0) return sql;
  if (kept.length === columns.length) return sql; // no DEFAULT found

  // Rebuild
  const newCols = kept.map(([c]) => c).join(', ');
  const newVals = kept.map(([, v]) => v).join(', ');
  const suffixPart = suffix.length > 0 ? ` ${suffix}` : '';
  return `INSERT INTO ${tableName} (${newCols}) VALUES (${newVals})${suffixPart}`;
}

/**
 * Find the closing parenthesis matching the one at `openPos`, accounting for
 * nesting and skipping string literals and `--` line comments so a `)` inside
 * a string or comment never terminates the scan prematurely.
 */
function findMatchingParen(sql: string, openPos: number): number {
  let depth = 1;
  let i = openPos + 1;
  while (i < sql.length && depth > 0) {
    const ch = sql[i];
    if (ch === "'") {
      // Skip a single-quoted string, including doubled '' escapes.
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2; // escaped quote
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      // Skip to end of line comment.
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

/**
 * Split a comma-separated list respecting quoted identifiers and nested parens.
 */
function splitCSV(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let parenDepth = 0;
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      current += ch;
      // A doubled quote (`''` or `""` or ````) is an escaped quote inside the
      // string, not the closing delimiter.
      if (ch === quoteChar && input[i + 1] === quoteChar) {
        current += input[i + 1];
        i++;
        continue;
      }
      if (ch === quoteChar) {
        inQuote = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = true;
      quoteChar = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      parenDepth--;
      current += ch;
      continue;
    }
    if (ch === ',' && parenDepth === 0) {
      result.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) result.push(current);
  return result;
}
