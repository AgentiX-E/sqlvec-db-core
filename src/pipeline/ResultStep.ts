/**
 * ResultStep — 合并层
 *
 * Pipeline v3 Step 4: 多分片结果合并、命令标签推导、事务状态处理。
 *
 * 当前实现:
 * - 单分片: 直接透传 (无额外开销)
 * - 多分片 (scatter): 合并行数据 (按分片顺序)
 * - 命令标签推导
 *
 * @see docs/ARCHITECTURE-OPTIMIZATION-PLAN.md §2
 */

import { PinoLogger } from '../logger/PinoLogger';
import type { ExecutionResult, PipelineOutput, StatementCategory } from './types';

const logger = PinoLogger.forComponent('ResultStep');

/** 命令标签映射表 (PG wire protocol CommandComplete 标签) */
const COMMAND_TAGS: Record<string, string> = {
  SELECT: 'SELECT',
  INSERT: 'INSERT',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  DDL: 'CREATE',
  TCL: 'COMMIT',
  SET: 'SET',
  SHOW: 'SHOW',
};

/**
 * ResultStep — 结果合并与格式化
 *
 * 输入: ExecutionResult[] (每个 shard 一个)
 * 输出: PipelineOutput (合并后的最终结果)
 */
export class ResultStep {
  /**
   * 合并执行结果
   */
  process(
    results: ExecutionResult[],
    category?: StatementCategory,
  ): PipelineOutput {
    if (results.length === 1) {
      return this.formatSingleResult(results[0], category);
    }
    return this.mergeResults(results, category);
  }

  /** 单分片格式化 — 直接透传 */
  private formatSingleResult(
    result: ExecutionResult,
    category?: StatementCategory,
  ): PipelineOutput {
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      queryTimeMs: result.queryTimeMs,
      commandTag: this.deriveCommandTag(category, result.rowCount),
      engine: 'sqlite',  // default engine, PgPipeline.execute() may override
    };
  }

  /** 多分片合并 — 行合并 + 行数求和 */
  private mergeResults(
    results: ExecutionResult[],
    category?: StatementCategory,
  ): PipelineOutput {
    const allRows: any[] = [];
    let totalRowCount = 0;
    let totalQueryTime = 0;

    for (const r of results) {
      if (r.rows) {
        allRows.push(...r.rows);
      }
      totalRowCount += r.rowCount || 0;
      totalQueryTime += r.queryTimeMs || 0;
    }

    return {
      rows: allRows,
      rowCount: totalRowCount,
      queryTimeMs: totalQueryTime,
      commandTag: this.deriveCommandTag(category, totalRowCount),
      engine: 'sqlite',  // default engine, PgPipeline.execute() may override
      shardResults: results,
    };
  }

  /** 推导 CommandComplete 标签 (PG wire 协议需要) */
  private deriveCommandTag(
    category?: StatementCategory,
    rowCount?: number,
  ): string {
    if (!category) return 'OK';
    const tag = COMMAND_TAGS[category] || 'OK';
    if (category === 'SELECT' || category === 'INSERT') {
      return `${tag} ${rowCount ?? 0}`;
    }
    if (category === 'UPDATE' || category === 'DELETE') {
      return `${tag} ${rowCount ?? 0}`;
    }
    return tag;
  }
}
