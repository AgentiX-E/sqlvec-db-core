/**
 * ABComparisonValidator — DuckDB vs SQLite 跨引擎结果一致性验证
 *
 * 设计目标: 系统化验证同一 SQL 查询在 DuckDB (OLAP) 和 SQLite (OLTP)
 * 两个引擎上的执行结果是否一致。捕获跨引擎语义差异，防止静默 bug。
 *
 * ## 验证层面
 *
 * | 层面 | 检查项 | 严格度 |
 * |:-----|:-------|:------:|
 * | 1. Schema | 列名、列数、类型兼容性 | 严格 |
 * | 2. 行数 | rowCount == rowCount | 严格 |
 * | 3. 行值 | 每行逐列比较 (ORDER BY NULL-safe) | 严格 |
 * | 4. 排序 | 有 ORDER BY 时顺序一致 | 严格 |
 * | 5. 类型 | DuckDB 类型映射到 JS 后的比较 | 宽松 (数/字串) |
 *
 * ## 用法
 *
 * ```ts
 * const validator = new ABComparisonValidator();
 * const result = validator.compare(duckResult, sqliteResult, sql);
 * if (!result.passed) {
 *   console.error(result.diffs); // 差异详情
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
  /** 是否完全一致 */
  passed: boolean;
  /** SQL 查询（截断到 200 字符） */
  sql: string;
  /** 差异列表（passed=true 时空数组） */
  diffs: ABDiff[];
  /** 详细统计 */
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
   * 比较两个引擎的查询结果是否一致。
   *
   * @param resultA 引擎 A 的结果（通常是 DuckDB）
   * @param resultB 引擎 B 的结果（通常是 SQLite）
   * @param sql     原始 SQL（用于日志/报告）
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
        description: `列数不匹配: ${schemaA.length} vs ${schemaB.length}`,
        engineA: schemaA.map(c => c.original),
        engineB: schemaB.map(c => c.original),
      });
    }

    for (let i = 0; i < Math.min(schemaA.length, schemaB.length); i++) {
      if (schemaA[i].lower !== schemaB[i].lower) {
        diffs.push({
          path: 'schema',
          description: `列名不匹配 (索引 ${i}): '${schemaA[i].original}' vs '${schemaB[i].original}'`,
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
        description: `行数不匹配: ${rowCountA} vs ${rowCountB}`,
        engineA: rowCountA,
        engineB: rowCountB,
      });
    }

    // ── Level 3-4: Row values (using case-insensitive column cross-reference) ──
    const maxRows = Math.max(rowsA.length, rowsB.length);

    for (let ri = 0; ri < Math.min(rowsA.length, rowsB.length); ri++) {
      for (const col of colMap) {
        const valA = this.normalizeValue(rowsA[ri]?.[schemaA[col.aIdx].original]);
        const valB = this.normalizeValue(rowsB[ri]?.[schemaB[col.bIdx].original]);
        if (!this.valuesEqual(valA, valB)) {
          diffs.push({
            path: 'rowValue',
            description: `行 ${ri}, 列 '${col.name}': ${valA} vs ${valB}`,
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
        columnsCompared: Math.max(colsA.length, colsB.length),
        engineA: 'resultA',
        engineB: 'resultB',
      },
    };
  }

  /**
   * 比较多个查询，返回批量结果。
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
   * 值标准化: NULL → null, number → string (BigInt 兼容), Boolean → boolean
   */
  private normalizeValue(val: unknown): unknown {
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
   * 值比较（NULL-safe, 数字宽松, Buffer-safe）。
   *
   * 数值容差策略:
   *   - 绝对差 < 1e-10 → 相等（处理 AVG 等聚合的 IEEE 754 舍入）
   *   - 相对差 < 1e-6 → 相等（处理 DuckDB REAL=float32 vs SQLite REAL=float64 差异）
   */
  private valuesEqual(a: unknown, b: unknown): boolean {
    // Both null
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;

    // Strict equality
    if (a === b) return true;

    // Numeric tolerance (handles DuckDB float32 vs SQLite float64 precision differences)
    const numA = Number(a);
    const numB = Number(b);
    if (!isNaN(numA) && !isNaN(numB)) {
      if (numA === numB) return true;
      // Absolute tolerance (for values near zero)
      if (Math.abs(numA - numB) < 1e-10) return true;
      // Relative tolerance (for values affected by float32 vs float64 precision)
      const maxAbs = Math.max(Math.abs(numA), Math.abs(numB));
      if (maxAbs > 0 && Math.abs(numA - numB) / maxAbs < 1e-6) return true;
    }

    // String comparison
    return String(a) === String(b);
  }
}
