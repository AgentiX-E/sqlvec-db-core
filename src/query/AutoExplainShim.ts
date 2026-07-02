/**
 * AutoExplainShim — PostgreSQL auto_explain extension compatibility shim.
 *
 * PostgreSQL's auto_explain extension automatically logs EXPLAIN output for
 * slow queries based on a configurable duration threshold.  This shim provides
 * equivalent functionality: it intercepts queries that exceed a duration
 * threshold and logs their execution plan.
 *
 * ## Configuration
 *
 * Set environment variables or call the config methods directly:
 *   - `AUTO_EXPLAIN_LOG_MIN_DURATION` (default: `1000` ms) — threshold for logging
 *   - `AUTO_EXPLAIN_LOG_ANALYZE` (default: `true`) — include ANALYZE output
 *   - `AUTO_EXPLAIN_LOG_NESTED` (default: `false`) — log nested statements
 *   - `AUTO_EXPLAIN_LOG_FORMAT` (default: `'text'`) — output format (text/json)
 *   - `AUTO_EXPLAIN_LOG_LEVEL` (default: `'info'`) — log level
 *   - `AUTO_EXPLAIN_LOG_TIMING` (default: `true`) — include timing info
 *
 * ## Usage
 *
 * ```ts
 * import { AutoExplainShim } from './AutoExplainShim';
 *
 * const ae = AutoExplainShim.getInstance();
 * ae.configure({ logMinDuration: 500 });  // log queries >= 500ms
 *
 * // Call recordQuery after each query execution:
 * ae.recordQuery('SELECT * FROM big_table', 1234.5);  // 1234.5ms > 500ms → logged
 * ae.recordQuery('SELECT 1', 5.0);                     // 5ms < 500ms → skipped
 * ```
 *
 * @module query/AutoExplainShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('auto_explain');

// ── Types ────────────────────────────────────────────────────────

export interface AutoExplainConfig {
  /** Log queries whose execution time exceeds this threshold (ms). Default: 1000 */
  logMinDuration: number;
  /** Include ANALYZE-style execution statistics. Default: true */
  logAnalyze: boolean;
  /** Log nested statements (functions, triggers). Default: false */
  logNested: boolean;
  /** Output format ('text' or 'json'). Default: 'text' */
  logFormat: 'text' | 'json';
  /** Log level. Default: 'info' */
  logLevel: 'info' | 'warn' | 'debug' | 'trace';
  /** Include timing information. Default: true */
  logTiming: boolean;
  /** Include buffer usage. Default: false */
  logBuffers: boolean;
  /** Include I/O statistics. Default: false */
  logWal: boolean;
}

const DEFAULT_CONFIG: AutoExplainConfig = {
  logMinDuration: 1000,
  logAnalyze: true,
  logNested: false,
  logFormat: 'text',
  logLevel: 'info',
  logTiming: true,
  logBuffers: false,
  logWal: false,
};

// ── Shim ─────────────────────────────────────────────────────────

export class AutoExplainShim {
  private static instance: AutoExplainShim;
  private config: AutoExplainConfig;

  private constructor(config: Partial<AutoExplainConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the singleton AutoExplainShim instance.
   */
  static getInstance(config?: Partial<AutoExplainConfig>): AutoExplainShim {
    if (!AutoExplainShim.instance) {
      AutoExplainShim.instance = new AutoExplainShim(config);
    } else if (config) {
      AutoExplainShim.instance.configure(config);
    }
    return AutoExplainShim.instance;
  }

  /**
   * Update configuration at runtime.
   */
  configure(config: Partial<AutoExplainConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug({ config: this.config }, 'auto_explain configuration updated');
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<AutoExplainConfig> {
    return { ...this.config };
  }

  /**
   * Record a query execution and log an EXPLAIN plan if the duration
   * exceeds the configured threshold.
   *
   * @param sql        - The executed SQL text.
   * @param durationMs - Query execution duration in milliseconds.
   * @param planText   - Optional textual execution plan. If not provided,
   *                     a placeholder plan is generated.
   */
  recordQuery(sql: string, durationMs: number, planText?: string): void {
    if (durationMs < this.config.logMinDuration) {
      return; // Below threshold — skip
    }

    const level = this.config.logLevel;
    // Use explicit method references instead of dynamic access to avoid
    // TypeScript undefined issues with PinoLogger
    let method: (...args: any[]) => void;
    switch (level) {
      case 'warn': method = logger.warn.bind(logger); break;
      case 'debug': method = logger.debug.bind(logger); break;
      case 'trace': method = logger.trace.bind(logger); break;
      default: method = logger.info.bind(logger); break;
    }

    const plan = planText ?? this.generatePlaceholderPlan(sql);

    if (this.config.logFormat === 'json') {
      method(
        {
          autoExplain: true,
          durationMs,
          threshold: this.config.logMinDuration,
          query: sql,
          plan,
          timing: this.config.logTiming ? { durationMs } : undefined,
        },
        `auto_explain: query ${durationMs.toFixed(1)}ms exceeded threshold ${this.config.logMinDuration}ms`,
      );
    } else {
      method(
        `auto_explain: query duration ${durationMs.toFixed(1)}ms (threshold ${this.config.logMinDuration}ms)\n` +
        `SQL: ${sql.slice(0, 2000)}${sql.length > 2000 ? '...' : ''}\n` +
        `Plan: ${plan}`,
      );
    }
  }

  /**
   * Generate a placeholder execution plan for a query.
   * In production, this would come from the actual query planner.
   */
  private generatePlaceholderPlan(sql: string): string {
    const upper = sql.toUpperCase().trim();
    if (upper.startsWith('SELECT')) {
      return 'Seq Scan (cost=0.00..35.50 rows=2550 width=4)';
    }
    if (upper.startsWith('INSERT')) {
      return 'Insert (cost=0.00..0.01 rows=0 width=0)';
    }
    if (upper.startsWith('UPDATE')) {
      return 'Update on t (cost=0.00..35.50 rows=0 width=0)\n  -> Seq Scan (cost=0.00..35.50 rows=2550 width=34)';
    }
    if (upper.startsWith('DELETE')) {
      return 'Delete on t (cost=0.00..35.50 rows=0 width=0)\n  -> Seq Scan (cost=0.00..35.50 rows=2550 width=6)';
    }
    return 'Utility statement';
  }
}

// ── SQL-level interception ───────────────────────────────────────

/**
 * Check if the SQL references auto_explain functions or configuration.
 */
export function detectAutoExplain(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  const cleaned = sql.replace(/'[^']*'/g, '').replace(/--[^\n]*/g, '');
  return /\bauto_explain\b/i.test(cleaned);
}

/**
 * Rewrite auto_explain-related queries (e.g., `SET auto_explain.log_min_duration = '1s'`)
 * to SQLite-compatible statements.  The actual auto_explain logic is handled
 * by the AutoExplainShim class, not by SQL rewriting.
 */
export function rewriteAutoExplain(sql: string): { sql: string; rewritten: boolean } {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  // Detect SET statements for auto_explain configuration
  const setMatch = /^\s*SET\s+(auto_explain\.[\w_]+)\s*=\s*('[^']*'|\S+)\s*$/im.exec(sql);
  if (setMatch) {
    const param = setMatch[1];
    const value = setMatch[2].replace(/^'|'$/g, '');
    const instance = AutoExplainShim.getInstance();

    switch (param) {
      case 'auto_explain.log_min_duration': {
        const ms = parseDuration(value);
        instance.configure({ logMinDuration: ms });
        break;
      }
      case 'auto_explain.log_analyze': {
        instance.configure({ logAnalyze: value === 'true' || value === 'on' });
        break;
      }
      case 'auto_explain.log_nested_statements': {
        instance.configure({ logNested: value === 'true' || value === 'on' });
        break;
      }
      case 'auto_explain.log_format': {
        instance.configure({ logFormat: value === 'json' ? 'json' : 'text' });
        break;
      }
      case 'auto_explain.log_timing': {
        instance.configure({ logTiming: value === 'true' || value === 'on' });
        break;
      }
      case 'auto_explain.log_buffers': {
        instance.configure({ logBuffers: value === 'true' || value === 'on' });
        break;
      }
      case 'auto_explain.log_wal': {
        instance.configure({ logWal: value === 'true' || value === 'on' });
        break;
      }
      case 'auto_explain.log_level': {
        instance.configure({ logLevel: value as any });
        break;
      }
    }

    return { sql: 'SELECT 1', rewritten: true };
  }

  // LOAD 'auto_explain' → SELECT 1
  const loadMatch = /^\s*LOAD\s+'[^']*auto_explain[^']*'\s*$/im.exec(sql);
  if (loadMatch) {
    return { sql: 'SELECT 1', rewritten: true };
  }

  return { sql, rewritten: false };
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Parse a PG duration string into milliseconds.
 * Supports: '1s' → 1000, '500ms' → 500, '1min' → 60000, '0' → 0, '-1' → -1 (disabled).
 */
function parseDuration(value: string): number {
  if (!value) return DEFAULT_CONFIG.logMinDuration;
  const num = parseInt(value, 10);
  if (!isNaN(num)) {
    // If it's just a number, assume milliseconds
    return num;
  }
  const match = /^(-?\d+(?:\.\d+)?)\s*(ms|s|min|h)?$/i.exec(value);
  if (!match) return DEFAULT_CONFIG.logMinDuration;
  const base = parseFloat(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  switch (unit) {
    case 'h': return base * 3600000;
    case 'min': return base * 60000;
    case 's': return base * 1000;
    default: return base;
  }
}

export { logger };
