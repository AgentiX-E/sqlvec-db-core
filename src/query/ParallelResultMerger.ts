/**
 * ParallelResultMerger — Merge and re-aggregate scatter-gather results
 * from parallel shard queries.
 *
 * Handles:
 *   - Simple aggregate re-summation (COUNT, SUM)
 *   - GROUP BY re-aggregation via temp SQLite table
 *   - ORDER BY + LIMIT on merged results
 *   - Non-aggregate row concatenation
 *   - Error isolation (failed shard → skipped, not aborted)
 *
 * Usage:
 *   const merger = new ParallelResultMerger();
 *   const result = merger.merge(originalSql, shardResults, originalColNames);
 *
 * @module query/ParallelResultMerger
 */

import { PinoLogger } from '../logger/PinoLogger';
import * as os from 'node:os';

const logger = PinoLogger.forComponent('ParallelResultMerger');

export interface ShardResult {
  rows: Record<string, any>[];
  shardId?: number;
}

export interface MergeOptions {
  /** Original SQL query (for re-aggregation analysis) */
  sql: string;
  /** Results from each shard */
  shardResults: ShardResult[];
  /** Column names from the first shard result (for type detection) */
  columnNames: string[];
  /** Name of the original table (for _buildReaggregateSql) */
  tableName?: string | null;
}

const AGG_FN = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i;
const HAS_GROUP_BY = /\bGROUP\s+BY\b/i;
const HAS_ORDER_BY = /\bORDER\s+BY\b/i;
const HAS_LIMIT = /\bLIMIT\b/i;

/**
 * Merges scatter-gather results from parallel shard queries into
 * a single coherent result set, handling aggregation correctly.
 */
export class ParallelResultMerger {
  /**
   * Merge shard results into a single result set.
   * Handles aggregation, grouping, ordering, and limiting.
   */
  merge(options: MergeOptions): Record<string, any>[] {
    const { sql, shardResults, columnNames, tableName } = options;

    // ── Collect all rows ──
    const allRows: Record<string, any>[] = [];
    for (const sr of shardResults) {
      allRows.push(...sr.rows);
    }

    if (allRows.length === 0) return [];

    // ── Non-aggregate / non-ordered: just concatenate ──
    const hasAggOrOrder = AGG_FN.test(sql) || HAS_ORDER_BY.test(sql) || HAS_LIMIT.test(sql);
    if (!hasAggOrOrder) {
      return allRows;
    }

    // ── Simple aggregate detection (no GROUP BY, each shard returns 1 row) ──
    // Only applies to single-column aggregates (COUNT or SUM) where JS
    // re-summation is correct. Multi-column aggregates fall through to
    // temp table path.
    const hasGroupBy = HAS_GROUP_BY.test(sql);
    const isSimpleAgg = columnNames.length === 1 && !hasGroupBy &&
      !HAS_ORDER_BY.test(sql) && !HAS_LIMIT.test(sql) &&
      allRows.length === shardResults.length;

    if (isSimpleAgg) {
      // Simple single-column COUNT or SUM → JS re-summation
      const colName = columnNames[0];
      if (colName && allRows[0][colName] != null) {
        if (/\bCOUNT\s*\(/i.test(sql) || /\bSUM\s*\(/i.test(sql)) {
          const numerical = allRows.map(r => Number(r[colName])).filter(v => !isNaN(v));
          if (numerical.length === allRows.length) {
            return [{ [colName]: numerical.reduce((a, b) => a + b, 0) }];
          }
        }
      }
    }

    // ── GROUP BY / ORDER BY + LIMIT / AVG / multi-column aggregate ──
    // Use proper re-aggregation SQL via temp table
    return this.tempTableMerge(options, allRows, columnNames);
  }

  /**
   * Merge using an in-memory SQLite temp table with proper re-aggregation SQL.
   */
  private tempTableMerge(
    options: MergeOptions,
    rows: Record<string, any>[],
    colNames: string[],
  ): Record<string, any>[] {
    try {
      const Database = require('better-sqlite3');
      const memDb = new Database(':memory:');
      try {
        const colDefs = colNames.map(c => {
          const val = rows[0][c];
          let sqlType = 'TEXT';
          if (typeof val === 'number') sqlType = 'NUMERIC';
          else if (typeof val === 'bigint') sqlType = 'INTEGER';
          return `"${c.replace(/"/g, '""')}" ${sqlType}`;
        });

        memDb.exec(`CREATE TABLE _ms_scatter (${colDefs.join(', ')})`);

        const placeholders = colNames.map(() => '?').join(',');
        const colQuoted = colNames.map(n => `"${n.replace(/"/g, '""')}"`).join(',');
        const insert = memDb.prepare(`INSERT INTO _ms_scatter (${colQuoted}) VALUES (${placeholders})`);

        const insertMany = memDb.transaction((batch: Record<string, any>[]) => {
          for (const row of batch) {
            const vals = colNames.map(n => row[n] ?? null);
            insert.run(...vals);
          }
        });
        insertMany(rows);

        // Build proper re-aggregation SQL with aggregate function mapping.
        // If the caller omitted an explicit tableName (e.g. for a non-aggregate
        // ORDER BY/LIMIT query), infer it from the `FROM` clause so the rewrite
        // still targets `_ms_scatter` instead of re-running the original SQL
        // against a non-existent source table.
        const effectiveTable = options.tableName || extractTableName(options.sql) || '';
        const reAggSql = effectiveTable
          ? buildReaggregateSql(options.sql, colNames, effectiveTable)
          : options.sql;

        return memDb.prepare(reAggSql).all() as Record<string, any>[];
      } finally {
        try { memDb.close(); } catch { /* ok */ }
      }
    } catch (err: any) {
      logger.warn(
        { err: err.message, sql: options.sql.substring(0, 100) },
        'temp table re-aggregation failed, returning raw rows',
      );
      return rows;
    }
  }
}

/**
 * Build re-aggregation SQL from the original scatter SQL.
 *
 * Transforms aggregate functions for correct re-aggregation:
 *   COUNT → SUM(alias), SUM → SUM(alias), MIN → MIN(alias), MAX → MAX(alias)
 *   AVG  → weighted average SUM(alias * cnt) / SUM(cnt)
 *
 * Non-aggregate columns (GROUP BY keys) are passed through unchanged.
 */
export function buildReaggregateSql(
  sql: string,
  perShardCols: string[],
  tableName: string,
): string {
  const selectMatch = sql.match(/SELECT\s+([\s\S]*?)\s+FROM\s/i);
  if (!selectMatch) {
    return replaceTableName(sql, tableName, '_ms_scatter');
  }

  const selectClause = selectMatch[1];

  // Extract GROUP BY / ORDER BY / LIMIT / HAVING.
  // The clauses are delimited by a following keyword OR end-of-string. The
  // previous pattern required `\s+` before `$`, which failed to match when a
  // clause sat at the very end of the SQL (no trailing whitespace), dropping
  // the clause entirely.
  const groupByMatch = sql.match(/\bGROUP\s+BY\b\s+(.+?)(?=$|\s+(?:ORDER\s+BY|LIMIT|HAVING))/is);
  const orderByMatch = sql.match(/\bORDER\s+BY\b\s+(.+?)(?=$|\s+LIMIT)/i);
  const limitMatch = sql.match(/\bLIMIT\b\s+(\d+)/i);
  const havingMatch = sql.match(/\bHAVING\b\s+(.+?)(?=$|\s+(?:ORDER\s+BY|LIMIT))/i);

  const groupByCols = groupByMatch ? groupByMatch[1].trim().split(/\s*,\s*/) : [];
  const groupKeys = groupByCols.map(c => c.replace(/"/g, '').trim());
  const hasCountCol = perShardCols.some(c => /^cnt|^count$/i.test(c) || /^count\s*\(\s*\*?\s*\)$/i.test(c));

  // Parse SELECT expressions (split by top-level commas)
  const exprs = splitTopLevelCommas(selectClause);
  const newExprs: string[] = [];

  for (const expr of exprs) {
    const trimmed = expr.trim();

    // Detect: AGG_FUNC(args) [AS alias]
    const aggMatch = trimmed.match(/^(COUNT|SUM|MIN|MAX|AVG)\s*\(\s*([\s\S]*?)\s*\)\s*(?:AS\s+(\w+))?$/i);
    if (aggMatch) {
      const funcName = aggMatch[1].toUpperCase();
      const argStr = aggMatch[2];
      const alias = aggMatch[3];

      // Find matching per-shard column:
      // 1) AS alias 2) inferred alias 3) raw expression text
      const matchCol = alias
        ? (perShardCols.includes(alias) ? alias : null)
        : perShardCols.find(c =>
            c.toLowerCase() === inferAggAlias(argStr, funcName).toLowerCase() ||
            c.toLowerCase() === trimmed.trim().toLowerCase()
          );
      const colName = matchCol || inferAggAlias(argStr, funcName);
      const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

      if (matchCol || perShardCols.includes(colName)) {
        switch (funcName) {
          case 'COUNT':
          case 'SUM':
            newExprs.push(`SUM(${q(colName)})${alias ? ` AS ${alias}` : ` AS ${funcName.toLowerCase()}`}`);
            break;
          case 'MIN':
            newExprs.push(`MIN(${q(colName)})${alias ? ` AS ${alias}` : ` AS ${funcName.toLowerCase()}`}`);
            break;
          case 'MAX':
            newExprs.push(`MAX(${q(colName)})${alias ? ` AS ${alias}` : ` AS ${funcName.toLowerCase()}`}`);
            break;
          case 'AVG': {
            if (hasCountCol && groupKeys.length > 0) {
              // hasCountCol is true iff some column matches this same pattern,
              // so find() is guaranteed to return a column here.
              const cntCol = perShardCols.find(c => /^cnt|^count$/i.test(c) || /^count\s*\(\s*\*?\s*\)$/i.test(c))!;
              newExprs.push(
                `(CASE WHEN SUM(${q(cntCol)}) = 0 THEN NULL ELSE SUM(${q(colName)} * ${q(cntCol)}) / SUM(${q(cntCol)}) END)${alias ? ` AS ${alias}` : ` AS ${funcName.toLowerCase()}`}`
              );
            } else {
              newExprs.push(`AVG(${q(colName)})${alias ? ` AS ${alias}` : ` AS ${funcName.toLowerCase()}`}`);
            }
            break;
          }
        }
      } else {
        newExprs.push(trimmed.replace(new RegExp(`\\b${escapeRegex(tableName)}\\b`, 'gi'), '_ms_scatter'));
      }
      continue;
    }

    // Non-aggregate column (GROUP BY key, constant expression, etc.)
    newExprs.push(trimmed.replace(new RegExp(`\\b${escapeRegex(tableName)}\\b`, 'gi'), '_ms_scatter'));
  }

  const groupByClause = groupByMatch
    ? ` GROUP BY ${groupKeys.map(k => `_ms_scatter.${k}`).join(', ')}`
    : '';
  const havingClause = havingMatch
    ? ` HAVING ${havingMatch[1].replace(new RegExp(`\\b${escapeRegex(tableName)}\\b`, 'gi'), '_ms_scatter')}`
    : '';
  const orderByClause = orderByMatch
    ? ` ORDER BY ${orderByMatch[1].replace(new RegExp(`\\b${escapeRegex(tableName)}\\b`, 'gi'), '_ms_scatter')}`
    : '';
  const limitClause = limitMatch ? ` LIMIT ${limitMatch[1]}` : '';

  return `SELECT ${newExprs.join(', ')} FROM _ms_scatter${groupByClause}${havingClause}${orderByClause}${limitClause}`;
}

function replaceTableName(sql: string, oldName: string, newName: string): string {
  const escaped = escapeRegex(oldName);
  return sql.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), newName);
}

function extractTableName(sql: string): string | null {
  const match = sql.match(/\bFROM\s+([A-Za-z_][\w.]*)/i);
  return match ? match[1] : null;
}

function inferAggAlias(argStr: string, funcName: string): string {
  // SQLite's default result-column name for `FUNC(expr)` is the verbatim
  // expression text (e.g. `SUM(x)` → `SUM(x)`, `COUNT(*)` → `COUNT(*)`).
  // Return that form (lowercased) so it matches a per-shard column named by
  // SQLite when no explicit AS alias was supplied.
  return `${funcName.toLowerCase()}(${argStr.trim()})`;
}

function splitTopLevelCommas(str: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Execute shard queries concurrently with max concurrency limit.
 * Isolates failures per shard (failed shard → empty result, not abort).
 *
 * @param shardExecs - Array of shard execution functions
 * @param maxParallel - Maximum concurrent executions (default: CPU - 1, min 1)
 * @returns Array of result-row arrays (one per shard, in order)
 */
export async function scatterGatherCollect<T>(
  shardExecs: Array<() => Promise<T>>,
  maxParallel: number = Math.max(1,
    typeof os.availableParallelism === 'function'
      ? os.availableParallelism() - 1
      : 3),
): Promise<T[]> {
  const results: T[] = new Array(shardExecs.length);

  // Concurrency-limited execution using a sliding window
  let idx = 0;
  const runNext = async (): Promise<void> => {
    while (idx < shardExecs.length) {
      const i = idx++;
      try {
        results[i] = await shardExecs[i]();
      } catch {
        (results as any[])[i] = [];
      }
    }
  };

  // Start maxParallel concurrent workers
  const workers: Promise<void>[] = [];
  const numWorkers = Math.min(maxParallel, shardExecs.length);
  for (let i = 0; i < numWorkers; i++) {
    workers.push(runNext());
  }
  await Promise.all(workers);

  return results;
}

/**
 * Execute shard queries concurrently and merge results.
 * Combines scatterGatherCollect + ParallelResultMerger.merge().
 *
 * @param shardExecs - Array of shard execution functions
 * @param options - Merge options (SQL, column names, table name)
 * @param maxParallel - Maximum concurrent executions
 * @returns Merged result rows
 */
export async function scatterGatherMerge(
  shardExecs: Array<() => Promise<Record<string, any>[]>>,
  options: MergeOptions,
  maxParallel?: number,
): Promise<Record<string, any>[]> {
  const collected = await scatterGatherCollect(shardExecs, maxParallel);
  const merger = new ParallelResultMerger();
  return merger.merge({
    ...options,
    shardResults: collected.map((rows, i) => ({ rows, shardId: i })),
  });
}
