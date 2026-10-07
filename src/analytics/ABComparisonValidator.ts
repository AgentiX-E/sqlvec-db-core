/**
 * ABComparisonValidator — DuckDB vs SQLite cross-engine result consistency check.
 *
 * Systematically verifies that the same SQL query produces identical results on
 * the DuckDB (OLAP) and SQLite (OLTP) engines, catching cross-engine semantic
 * differences before they become silent bugs.
 *
 * ## Verification levels
 *
 * | Level | Check | Strictness |
 * |:------|:------|:----------:|
 * | 1. Schema | column name, count, type compatibility | strict |
 * | 2. Row count | rowCount == rowCount | strict |
 * | 3. Row values | per-row per-column comparison (case-insensitive column ref) | strict |
 * | 4. Types | comparison after mapping DuckDB types to JS | loose (number/string) |
 *
 * ## Usage
 *
 * ```ts
 * const validator = new ABComparisonValidator();
 * const result = validator.compare(duckResult, sqliteResult, sql);
 * if (!result.passed) {
 *   console.error(result.diffs); // difference details
 * }
 * ```
 *
 * @see docs/architecture/oltp-olap-unification.md §10
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('ABValidator');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ABQueryResult {
  columns: { name: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface ABDiff {
  path: 'schema' | 'rowCount' | 'rowValue' | 'ordering';
  description: string;
  engineA?: unknown;
  engineB?: unknown;
  rowIndex?: number;
  column?: string;
}

export interface ABComparisonResult {
  /** Whether the two results are fully identical */
  passed: boolean;
  /** The SQL query (truncated to 200 characters) */
  sql: string;
  /** Difference list (empty when passed=true) */
  diffs: ABDiff[];
  /** Detailed statistics */
  summary: {
    rowsCompared: number;
    columnsCompared: number;
    engineA: string;
    engineB: string;
  };
}

// ──────────────────────────────────────────────
//  Validator
// ──────────────────────────────────────────────

export class ABComparisonValidator {
  /**
   * Compare the query results of two engines for consistency.
   *
   * @param resultA Engine A's result (usually DuckDB)
   * @param resultB Engine B's result (usually SQLite)
   * @param sql     Original SQL (for logging/reporting)
   * @returns ABComparisonResult
   */
  compare(
    resultA: ABQueryResult,
    resultB: ABQueryResult,
    sql: string,
  ): ABComparisonResult {
    const diffs: ABDiff[] = [];
    const truncatedSql = sql.length > 200 ? sql.substring(0, 197) + '...' : sql;

    // ── Level 1: Schema (case-insensitive column name comparison) ──
    const colsA = resultA.columns || [];
    const colsB = resultB.columns || [];

    // Normalize column names (DuckDB lowercase vs SQLite uppercase)
    const schemaA = colsA.map(c => ({ original: c.name, lower: c.name.toLowerCase() }));
    const schemaB = colsB.map(c => ({ original: c.name, lower: c.name.toLowerCase() }));

    if (schemaA.length !== schemaB.length) {
      diffs.push({
        path: 'schema',
        description: `column count mismatch: ${schemaA.length} vs ${schemaB.length}`,
        engineA: schemaA.map(c => c.original),
        engineB: schemaB.map(c => c.original),
      });
    }

    for (let i = 0; i < Math.min(schemaA.length, schemaB.length); i++) {
      if (schemaA[i].lower !== schemaB[i].lower) {
        diffs.push({
          path: 'schema',
          description: `column name mismatch (index ${i}): '${schemaA[i].original}' vs '${schemaB[i].original}'`,
          engineA: schemaA[i].original,
          engineB: schemaB[i].original,
        });
      }
    }

    // Build a cross-reference: for each schemaA column, find matching schemaB column
    const colMap: { aIdx: number; bIdx: number; name: string }[] = [];
    for (let ai = 0; ai < schemaA.length; ai++) {
      const bi = schemaB.findIndex(c => c.lower === schemaA[ai].lower);
      if (bi >= 0) {
        colMap.push({ aIdx: ai, bIdx: bi, name: schemaA[ai].original });
      }
    }

    // ── Level 2: Row count ──
    const rowsA = resultA.rows || [];
    const rowsB = resultB.rows || [];
    const rowCountA = resultA.rowCount ?? rowsA.length;
    const rowCountB = resultB.rowCount ?? rowsB.length;

    if (rowCountA !== rowCountB) {
      diffs.push({
        path: 'rowCount',
        description: `row count mismatch: ${rowCountA} vs ${rowCountB}`,
        engineA: rowCountA,
        engineB: rowCountB,
      });
    }

    // ── Level 3: Row values (using case-insensitive column cross-reference) ──
    for (let ri = 0; ri < Math.min(rowsA.length, rowsB.length); ri++) {
      for (const col of colMap) {
        const valA = this.normalizeValue(rowsA[ri]?.[schemaA[col.aIdx].original]);
        const valB = this.normalizeValue(rowsB[ri]?.[schemaB[col.bIdx].original]);
        if (!this.valuesEqual(valA, valB)) {
          diffs.push({
            path: 'rowValue',
            description: `row ${ri}, column '${col.name}': ${valA} vs ${valB}`,
            engineA: valA,
            engineB: valB,
            rowIndex: ri,
            column: col.name,
          });
        }
      }
    }

    // ── Result ──
    return {
      passed: diffs.length === 0,
      sql: truncatedSql,
      diffs,
      summary: {
        rowsCompared: Math.min(rowsA.length, rowsB.length),
        columnsCompared: colMap.length,
        engineA: 'resultA',
        engineB: 'resultB',
      },
    };
  }

  /**
   * Compare multiple queries and return batch results.
   */
  compareBatch(
    queries: { sql: string; resultA: ABQueryResult; resultB: ABQueryResult }[],
  ): { allPassed: boolean; results: ABComparisonResult[] } {
    const results = queries.map(q => this.compare(q.resultA, q.resultB, q.sql));
    return {
      allPassed: results.every(r => r.passed),
      results,
    };
  }

  /**
   * Normalize a value: null/undefined → null, bigint → number, Date → ISO
   * string, Buffer → hex string, other non-primitives → string. Numbers,
   * strings, and booleans pass through unchanged.
   *
   * The return type is narrowed to the only runtime types this function can
   * produce (number, string, boolean, null), which lets callers rely on the
   * narrowing instead of re-checking for object values.
   */
  private normalizeValue(val: unknown): number | string | boolean | null {
    if (val === null || val === undefined) return null;
    if (typeof val === 'bigint') return Number(val);
    if (typeof val === 'number') return val;
    if (typeof val === 'string') return val;
    if (typeof val === 'boolean') return val;
    if (val instanceof Date) return val.toISOString();
    if (Buffer.isBuffer(val)) return val.toString('hex');
    return String(val);
  }

  /**
   * Value comparison (NULL-safe, numeric-tolerant, Buffer-independent).
   *
   * Numeric tolerance strategy:
   *   - absolute difference < 1e-10 → equal (handles IEEE 754 rounding in AVG)
   *   - relative difference < 1e-6 → equal (handles DuckDB REAL=float32 vs SQLite REAL=float64)
   *
   * The numeric branch applies only when both operands genuinely represent
   * numbers (number or non-empty numeric string). Booleans and empty/blank
   * strings must never collapse onto `0` via `Number()`.
   */
  private valuesEqual(a: number | string | boolean | null, b: number | string | boolean | null): boolean {
    // Both null
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;

    // Strict equality
    if (a === b) return true;

    // Booleans are never equal to numbers or strings (false !== 0, false !== "")
    if (typeof a === 'boolean' || typeof b === 'boolean') return false;

    const aIsNumeric = this.isNumeric(a);
    const bIsNumeric = this.isNumeric(b);

    // Numeric tolerance (handles DuckDB float32 vs SQLite float64 precision differences)
    if (aIsNumeric && bIsNumeric) {
      const numA = Number(a);
      const numB = Number(b);
      if (numA === numB) return true;
      // Absolute tolerance (for values near zero)
      if (Math.abs(numA - numB) < 1e-10) return true;
      // Relative tolerance (for values affected by float32 vs float64 precision)
      const maxAbs = Math.max(Math.abs(numA), Math.abs(numB));
      if (maxAbs > 0 && Math.abs(numA - numB) / maxAbs < 1e-6) return true;
      return false;
    }

    // String comparison (non-numeric)
    return String(a) === String(b);
  }

  /**
   * True when a value participates in numeric comparison: an actual number or
   * a numeric string. Booleans and null are excluded by the caller (and by the
   * narrowed parameter type), so no `false` fallback is needed here.
   */
  private isNumeric(val: number | string): boolean {
    if (typeof val === 'number') return true;
    const trimmed = val.trim();
    return trimmed !== '' && !isNaN(Number(trimmed));
  }
}
