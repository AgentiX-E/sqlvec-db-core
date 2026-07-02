/**
 * TopNHeuristicShim — Top-N 堆排序兼容 Shim for SQLite compatibility.
 *
 * PostgreSQL 支持 `enable_top_n_heuristic` 参数，控制优化器在 Top-N
 * 查询（如 ORDER BY + LIMIT）中是否启用堆排序（heap sort）优化。
 * SQLite 无等价概念，因此将相关 SQL 重写为 no-op 或等效查询。
 *
 * ## Strategy
 *
 * 1. **SET enable_top_n_heuristic = on|off** —— 重写为 `SELECT 1`（no-op）
 * 2. **SHOW enable_top_n_heuristic** —— 重写为 `SELECT 'off' as enable_top_n_heuristic`
 *     （返回 off 以禁用该优化，与 SQLite 无此能力的行为一致）
 * 3. **其他 SQL** —— 透传，不做任何修改
 *
 * ## 关键保证
 * - 所有 SET/SHOW 语句处理后仍为合法 SQL
 * - 检测严格匹配 `enable_top_n_heuristic`，不会误判普通 SQL
 * - PinoLogger 集成，用于调试和审计
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('TopNHeuristicShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface TopNResult {
  /** 重写后的 SQL（非 Top-N 时保持原值） */
  sql: string;
  /** 是否被检测为 Top-N 相关 SQL 并进行了重写 */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants – Regex patterns
// ──────────────────────────────────────────────

/**
 * 匹配 SET enable_top_n_heuristic 语句。
 * 支持:
 *   SET enable_top_n_heuristic = on;
 *   SET enable_top_n_heuristic = off;
 *   SET enable_top_n_heuristic TO on;
 *   SET enable_top_n_heuristic TO off;
 *   SET SESSION enable_top_n_heuristic = on;
 *   SET LOCAL enable_top_n_heuristic = off;
 */
const SET_TOP_N_PATTERN =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?enable_top_n_heuristic\s*(?:[=:]\s*|\s+TO\s+)(on|off|true|false|0|1)\s*;?\s*$/i;

/**
 * 匹配 SHOW enable_top_n_heuristic 语句。
 */
const SHOW_TOP_N_PATTERN =
  /^\s*SHOW\s+enable_top_n_heuristic\s*;?\s*$/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * 检测 SQL 是否为 Top-N 堆排序相关语句。
 *
 * 执行不区分大小写的正则匹配，检查是否为：
 *   - `SET enable_top_n_heuristic = ...`
 *   - `SHOW enable_top_n_heuristic`
 *
 * @param sql - 待检测的原始 SQL 字符串
 * @returns 如果 SQL 与 Top-N 堆排序相关则返回 `true`，否则返回 `false`
 *
 * @example
 * ```ts
 * detectTopN('SET enable_top_n_heuristic = on');   // true
 * detectTopN('SHOW enable_top_n_heuristic');        // true
 * detectTopN('SELECT * FROM users');                // false
 * ```
 */
export function detectTopN(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check
  const upper = trimmed.toUpperCase();
  if (
    !upper.startsWith('SET ') &&
    !upper.startsWith('SHOW ')
  ) {
    return false;
  }

  // Confirm with regex
  return SET_TOP_N_PATTERN.test(trimmed) || SHOW_TOP_N_PATTERN.test(trimmed);
}

/**
 * 重写 Top-N 堆排序相关 SQL 语句。
 *
 * **处理规则：**
 * | 输入                                      | 输出                                 | rewritten |
 * |-------------------------------------------|--------------------------------------|-----------|
 * | `SET enable_top_n_heuristic = on`         | `SELECT 1`                           | true      |
 * | `SET enable_top_n_heuristic = off`        | `SELECT 1`                           | true      |
 * | `SET SESSION enable_top_n_heuristic = on` | `SELECT 1`                           | true      |
 * | `SET LOCAL enable_top_n_heuristic = off`  | `SELECT 1`                           | true      |
 * | `SHOW enable_top_n_heuristic`             | `SELECT 'off' as enable_top_n_heuristic` | true  |
 * | 非 Top-N SQL                              | 保持原值                             | false     |
 *
 * @param sql - 待处理的原始 SQL 字符串
 * @returns TopNResult 对象，包含重写后的 SQL 和是否重写的标记
 *
 * @example
 * ```ts
 * rewriteTopN('SET enable_top_n_heuristic = on');
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteTopN('SHOW enable_top_n_heuristic');
 * // → { sql: "SELECT 'off' as enable_top_n_heuristic", rewritten: true }
 *
 * rewriteTopN('SELECT * FROM users');
 * // → { sql: 'SELECT * FROM users', rewritten: false }
 * ```
 */
export function rewriteTopN(sql: string): TopNResult {
  // ── Guard: empty / non-string input ──────────────────────
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── SHOW enable_top_n_heuristic → SELECT 'off' ──────────
  const showMatch = trimmed.match(SHOW_TOP_N_PATTERN);
  if (showMatch) {
    const rewritten = "SELECT 'off' as enable_top_n_heuristic";
    logger.debug(
      { original: trimmed, rewritten },
      'SHOW enable_top_n_heuristic detected — rewriting to SELECT literal',
    );
    return {
      sql: rewritten,
      rewritten: true,
    };
  }

  // ── SET enable_top_n_heuristic ... → SELECT 1 ───────────
  const setMatch = trimmed.match(SET_TOP_N_PATTERN);
  if (setMatch) {
    const value = setMatch[1].toLowerCase();
    logger.debug(
      { original: trimmed, value },
      'SET enable_top_n_heuristic detected — rewriting to no-op SELECT 1',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Not a Top-N statement — passthrough ─────────────────
  return {
    sql: trimmed,
    rewritten: false,
  };
}
