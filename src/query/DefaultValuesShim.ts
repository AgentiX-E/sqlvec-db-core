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
  // Only applies to INSERT ... VALUES ... statements
  const insertMatch = sql.match(
    /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(`?"?\w+"?`?(?:\s*\.\s*`?"?\w+"?`?)?)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*(.*)$/is
  );
  if (!insertMatch) return sql;

  const tableName = insertMatch[1];
  const columnsRaw = insertMatch[2];
  const valuesRaw = insertMatch[3];
  const suffix = insertMatch[4]; // RETURNING clause etc.

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
  return `INSERT INTO ${tableName} (${newCols}) VALUES (${newVals}) ${suffix}`.trim();
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
