/**
 * PlPgSqlExtended — Extended PL/pgSQL control structures.
 *
 * Adds support for:
 *   1. `FOR rec IN SELECT * FROM t LOOP ... END LOOP` — cursor-style iteration
 *   2. `WHILE condition LOOP ... END LOOP` — conditional looping
 *   3. `FOR i IN 1..10 LOOP ... END LOOP` — integer range loop
 *   4. `CONTINUE [WHEN condition]` — skip to next iteration
 *   5. `SELECT x INTO var FROM t WHERE ...` — SELECT INTO variable assignment
 *
 * These handlers follow the existing PlPgSqlEngine architecture:
 * parser-based detection + context-aware execution.
 *
 * @module plpgsql/PlPgSqlExtended
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('PlPgSqlExtended');

// ── Detection functions ──────────────────────────────────────────────────

/**
 * Detect whether a SQL string contains a WHILE loop construct.
 * e.g. `WHILE counter < 10 LOOP ... END LOOP;`
 */
export function detectWhileLoop(sql: string): boolean {
  return /WHILE\s+.+?\s+LOOP\b/im.test(sql);
}

/**
 * Detect whether a SQL string contains a FOR loop construct — either:
 *   - FOR rec IN SELECT ... LOOP (cursor iteration)
 *   - FOR i IN 1..10 LOOP (integer range)
 */
export function detectForLoop(sql: string): boolean {
  return /\bFOR\s+\w+\s+IN\s/im.test(sql);
}

/**
 * Detect a FOR .. SELECT loop specifically:
 *   `FOR rec IN SELECT * FROM t LOOP`
 */
export function detectForSelectLoop(sql: string): boolean {
  const match = sql.match(/\bFOR\s+(\w+)\s+IN\s+SELECT\b/im);
  return match !== null;
}

/**
 * Detect a FOR integer range loop:
 *   `FOR i IN 1..10 LOOP`
 */
export function detectForRangeLoop(sql: string): boolean {
  return /\bFOR\s+\w+\s+IN\s+\d+\s*\.\.\s*\d+/im.test(sql);
}

/**
 * Detect a CONTINUE statement (optionally with WHEN condition):
 *   `CONTINUE;` or `CONTINUE WHEN condition;`
 */
export function detectContinue(sql: string): boolean {
  return /\bCONTINUE\b/im.test(sql);
}

/**
 * Detect a SELECT INTO variable assignment:
 *   `SELECT x INTO var FROM t WHERE ...`
 */
export function detectSelectInto(sql: string): boolean {
  // SELECT ... INTO [STRICT] variable FROM ...
  return /\bSELECT\b[\s\S]*?\bINTO\s+(?:STRICT\s+)?\w+\b/im.test(sql);
}

/**
 * Extract the variable name from SELECT ... INTO var ...
 */
export function extractIntoVariable(sql: string): string | null {
  const match = sql.match(/\bINTO\s+(?:STRICT\s+)?(\w+)\b/im);
  return match ? match[1] : null;
}

// ── WHILE Loop ──────────────────────────────────────────────────────────

/**
 * Extract the WHILE condition and the loop body from a WHILE...LOOP...END LOOP block.
 *
 * Returns `{ condition, body }` or `null` if parsing fails.
 */
export function extractWhileLoop(sql: string): { condition: string; body: string } | null {
  // Find WHILE ... LOOP
  const whileMatch = sql.match(/WHILE\s+(.+?)\s+LOOP\s/im);
  if (!whileMatch) return null;

  const afterWhile = whileMatch.index! + whileMatch[0].length;
  const condition = whileMatch[1].trim();

  // Find matching END LOOP (with a simple nesting counter for LOOPs)
  let depth = 1;
  let endIdx = -1;
  const bodyStart = afterWhile;

  // Scan for matching END LOOP, accounting for nested loops
  const searchStr = sql.substring(bodyStart);
  const loopRegex = /LOOP|END\s+LOOP/gi;
  let match;

  while ((match = loopRegex.exec(searchStr)) !== null) {
    if (match[0].toUpperCase() === 'LOOP') {
      depth++;
    } else if (match[0].toUpperCase() === 'END LOOP' || match[0].toUpperCase().trim() === 'END' && searchStr.substring(match.index + 3).trim().toUpperCase().startsWith('LOOP')) {
      depth--;
      if (depth === 0) {
        endIdx = bodyStart + match.index;
        break;
      }
    }
  }

  if (endIdx === -1) return null;

  const body = sql.substring(bodyStart, endIdx).trim();

  return { condition, body };
}

/**
 * Execute a WHILE loop.
 *
 * @param parser - Simple parser eval function (takes expression string, returns value).
 * @param context - Execution context with evaluateExpression and executeBody.
 * @param sql - The full WHILE...LOOP...END LOOP block.
 */
export async function executeWhileLoop(
  parser: { evaluateCondition: (expr: string) => Promise<boolean> | boolean },
  context: { executeBody: (body: string) => Promise<void> },
  sql: string,
): Promise<void> {
  const extracted = extractWhileLoop(sql);
  if (!extracted) {
    throw new Error('Failed to parse WHILE loop');
  }

  const { condition, body } = extracted;
  let iterations = 0;
  const maxIterations = 100000;

  while (iterations < maxIterations) {
    const shouldRun = await parser.evaluateCondition(condition);
    if (!shouldRun) break;

    await context.executeBody(body);
    iterations++;
  }

  if (iterations >= maxIterations) {
    logger.warn('WHILE loop reached max iterations (100000)');
  }
}

// ── FOR Loop (SELECT) ────────────────────────────────────────────────────

/**
 * Extract FOR-SELECT loop: `FOR rec IN SELECT * FROM t LOOP ... END LOOP`
 *
 * Returns `{ variable, query, body }` or null.
 */
export function extractForSelectLoop(sql: string): { variable: string; query: string; body: string } | null {
  const match = sql.match(
    /\bFOR\s+(\w+)\s+IN\s+(SELECT[\s\S]*?)\s+LOOP\s/im,
  );
  if (!match) return null;

  const variable = match[1];
  const afterForSelect = match.index! + match[0].length;
  const queryPart = match[2].trim();

  // Find matching END LOOP
  let depth = 1;
  let endIdx = -1;
  const bodyStart = afterForSelect;
  const searchStr = sql.substring(bodyStart);
  const loopRegex = /LOOP|END\s+LOOP/gi;
  let lMatch;

  while ((lMatch = loopRegex.exec(searchStr)) !== null) {
    if (lMatch[0].toUpperCase() === 'LOOP') {
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        endIdx = bodyStart + lMatch.index;
        break;
      }
    }
  }

  if (endIdx === -1) return null;

  const body = sql.substring(bodyStart, endIdx).trim();

  return { variable, query: queryPart, body };
}

/**
 * Execute a FOR-SELECT loop.
 *
 * For each row returned by the query, the record is assigned to a variable
 * (as a string representation) and the loop body is executed.
 *
 * @param db - Database-like object with a `query` method.
 * @param context - Execution context with executeBody and setVariable.
 * @param sql - The full FOR...SELECT...LOOP...END LOOP block.
 */
export async function executeForSelectLoop(
  db: { query: (sql: string) => Promise<{ rows: any[] }> },
  context: {
    executeBody: (body: string) => Promise<void>;
    setVariable: (name: string, value: any) => void;
  },
  sql: string,
): Promise<void> {
  const extracted = extractForSelectLoop(sql);
  if (!extracted) {
    throw new Error('Failed to parse FOR-SELECT loop');
  }

  const { variable, query, body } = extracted;

  let result;
  try {
    result = await db.query(query);
  } catch (err: any) {
    logger.error({ query, err: err.message }, 'FOR-SELECT query failed');
    throw new Error(`FOR query failed: ${err.message}`);
  }

  const rows = result.rows || [];

  for (const row of rows) {
    // Set the record variable — assign the first column as a scalar,
    // or the entire row as an object if record type is needed
    context.setVariable(variable, row);

    await context.executeBody(body);
  }
}

// ── FOR Range Loop ───────────────────────────────────────────────────────

/**
 * Extract FOR range loop: `FOR i IN 1..10 LOOP ... END LOOP`
 *
 * Returns `{ variable, start, end, body }` or null.
 */
export function extractForRangeLoop(sql: string): { variable: string; start: number; end: number; body: string } | null {
  const match = sql.match(
    /\bFOR\s+(\w+)\s+IN\s+(\d+)\s*\.\.\s*(\d+)\s+LOOP\s/im,
  );
  if (!match) return null;

  const variable = match[1];
  const start = parseInt(match[2], 10);
  const end = parseInt(match[3], 10);
  const afterMatch = match.index! + match[0].length;

  // Find matching END LOOP
  let depth = 1;
  let endIdx = -1;
  const searchStr = sql.substring(afterMatch);
  const loopRegex = /LOOP|END\s+LOOP/gi;
  let lMatch;

  while ((lMatch = loopRegex.exec(searchStr)) !== null) {
    if (lMatch[0].toUpperCase() === 'LOOP') {
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        endIdx = afterMatch + lMatch.index;
        break;
      }
    }
  }

  if (endIdx === -1) return null;

  const body = sql.substring(afterMatch, endIdx).trim();

  return { variable, start, end, body };
}

/**
 * Execute a FOR range loop.
 *
 * @param context - Execution context with executeBody and setVariable.
 * @param sql - The full FOR...IN x..y LOOP...END LOOP block.
 */
export async function executeForRangeLoop(
  context: {
    executeBody: (body: string) => Promise<void>;
    setVariable: (name: string, value: any) => void;
  },
  sql: string,
): Promise<void> {
  const extracted = extractForRangeLoop(sql);
  if (!extracted) {
    throw new Error('Failed to parse FOR range loop');
  }

  const { variable, start, end, body } = extracted;

  for (let i = start; i <= end; i++) {
    context.setVariable(variable, i);
    await context.executeBody(body);
  }
}

// ── CONTINUE statement ──────────────────────────────────────────────────

/**
 * Extract CONTINUE condition:
 *   - `CONTINUE;` → no condition
 *   - `CONTINUE WHEN counter < 5;` → condition "counter < 5"
 *
 * @param sql - The CONTINUE substring.
 * @returns The condition string, or null if unconditional.
 */
export function extractContinueCondition(sql: string): string | null {
  const match = sql.match(
    /\bCONTINUE\s+(?:WHEN\s+(.+?))?\s*;?\s*$/im,
  );
  if (!match) return null;
  return match[1] ? match[1].trim() : null;
}

// ── SELECT INTO ──────────────────────────────────────────────────────────

/**
 * Extract SELECT INTO details: `SELECT expr INTO [STRICT] var FROM ...`
 *
 * Returns `{ variable, query }` — the rewritten query WITHOUT the INTO clause,
 * and the target variable name.
 */
export function extractSelectInto(sql: string): { variable: string; query: string } | null {
  const match = sql.match(
    /\bSELECT\b([\s\S]*?)\bINTO\s+(?:STRICT\s+)?(\w+)\b([\s\S]*)/im,
  );
  if (!match) return null;

  const variable = match[2];
  // Rebuild query: SELECT <whats-left> <from-rest> with INTO removed
  const selectPart = match[1].trim();
  const restPart = match[3].trim();
  const cleanQuery = `SELECT ${selectPart} ${restPart}`.trim();

  return { variable, query: cleanQuery };
}

/**
 * Execute a SELECT INTO statement: runs the query and assigns the result
 * to the specified variable in the execution context.
 *
 * @param sql - The SELECT INTO SQL statement.
 * @param db - Database-like object with a `query` method.
 * @param context - Execution context with setVariable.
 */
export async function executeSelectInto(
  sql: string,
  db: { query: (sql: string) => Promise<{ rows: any[] }> },
  context: { setVariable: (name: string, value: any) => void },
): Promise<void> {
  const extracted = extractSelectInto(sql);
  if (!extracted) {
    throw new Error('Failed to parse SELECT INTO');
  }

  const { variable, query } = extracted;

  let result;
  try {
    result = await db.query(query);
  } catch (err: any) {
    logger.error({ query, err: err.message }, 'SELECT INTO query failed');
    throw new Error(`SELECT INTO failed: ${err.message}`);
  }

  const rows = result.rows || [];

  if (rows.length === 0) {
    // No rows: variable is set to null, also marks FOUND = false
    context.setVariable(variable, null);
    context.setVariable('found', false);
    return;
  }

  // Get the first column value of the first row
  const row = rows[0];
  const keys = Object.keys(row);
  if (keys.length > 0) {
    context.setVariable(variable, row[keys[0]]);
  } else {
    context.setVariable(variable, null);
  }
  context.setVariable('found', true);
}

// ── Convenience helpers ─────────────────────────────────────────────────

/**
 * Check if a SQL string contains any of the extended control structures.
 */
export function hasExtendedControlStructure(sql: string): boolean {
  return (
    detectWhileLoop(sql) ||
    detectForLoop(sql) ||
    detectContinue(sql) ||
    detectSelectInto(sql)
  );
}
