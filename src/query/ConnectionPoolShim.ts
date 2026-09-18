/**
 * ConnectionPoolShim — PgBouncer connection-pool command compatibility shim.
 *
 * PostgreSQL deployments frequently sit behind PgBouncer, which exposes
 * SQL-level management commands (`SHOW POOLS`, `SHOW CLIENTS`, `SHOW STATS`,
 * `SHOW VERSION`, `SHOW DATABASES`, `SHOW SERVERS`, `PAUSE`, `RESUME`,
 * `RELOAD`, and `SET`) that ORMs and operators issue at connection time.
 * SQLite has no native equivalents, so these would otherwise error at runtime.
 *
 * This shim detects such commands (case-insensitively) and rewrites them into
 * SQLite-compatible `SELECT` statements.  `SHOW POOLS`/`SHOW SERVERS` report
 * live statistics from an optional injected {@link PoolStatsSource}, so the
 * view reflects the actual connection pool rather than fabricated numbers.
 *
 * All rewritten output is valid SQLite SQL.
 *
 * @module ConnectionPoolShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('ConnectionPoolShim');

/** Result of a pool-command rewrite. */
export interface ConnPoolResult {
  /** Rewritten SQL (no-op `SELECT` for pool commands, original on pass-through). */
  sql: string;
  /** Whether the statement was detected and rewritten. */
  rewritten: boolean;
}

/** Live connection-pool statistics consumed by `SHOW POOLS`/`SHOW SERVERS`. */
export interface PoolStatsSource {
  getStats(): { active: number; idle: number; waiting: number; max: number };
}

/** Injectable stats source; defaults to a zeroed source. */
let statsSource: PoolStatsSource | null = null;

/** Zeroed fallback used when no live stats source is configured. */
const ZERO_STATS: PoolStatsSource = {
  getStats: () => ({ active: 0, idle: 0, waiting: 0, max: 0 }),
};

/** Set the live statistics source backing `SHOW POOLS`/`SHOW SERVERS`. */
export function setPoolStatsSource(source: PoolStatsSource | null): void {
  statsSource = source;
}

/** Resolve the current stats source, falling back to zeroed stats. */
function getStats(): { active: number; idle: number; waiting: number; max: number } {
  return (statsSource ?? ZERO_STATS).getStats();
}

// ── Regex patterns ────────────────────────────────────────────

const SHOW_POOLS = /^\s*SHOW\s+POOLS\b/i;
const SHOW_STATS = /^\s*SHOW\s+STATS\b/i;
const SHOW_VERSION = /^\s*SHOW\s+VERSION\b/i;
const SHOW_CLIENTS = /^\s*SHOW\s+CLIENTS\b/i;
const SHOW_DATABASES = /^\s*SHOW\s+DATABASES\b/i;
const SHOW_SERVERS = /^\s*SHOW\s+SERVERS\b/i;
const SHOW_GENERIC = /^\s*SHOW\s+\S+/i;
const PAUSE_CMD = /^\s*PAUSE\b/i;
const RESUME_CMD = /^\s*RESUME\b/i;
const RELOAD_CMD = /^\s*RELOAD\b/i;
const SET_CMD = /^\s*SET\s+/i;

/**
 * Whether the SQL is a PgBouncer connection-pool management command or a
 * pool-related configuration `SET`.
 */
export function detectPoolSql(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  const trimmed = sql.trim();
  return (
    SHOW_POOLS.test(trimmed) ||
    SHOW_STATS.test(trimmed) ||
    SHOW_VERSION.test(trimmed) ||
    SHOW_CLIENTS.test(trimmed) ||
    SHOW_DATABASES.test(trimmed) ||
    SHOW_SERVERS.test(trimmed) ||
    SHOW_GENERIC.test(trimmed) ||
    PAUSE_CMD.test(trimmed) ||
    RESUME_CMD.test(trimmed) ||
    RELOAD_CMD.test(trimmed) ||
    SET_CMD.test(trimmed)
  );
}

/**
 * Rewrite a PgBouncer command into SQLite-compatible SQL.  Returns the input
 * unchanged (with `rewritten: false`) when the SQL is not a pool command.
 */
export function rewritePoolSql(sql: string): ConnPoolResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  const trimmed = sql.trim();

  if (!detectPoolSql(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  if (SHOW_POOLS.test(trimmed)) {
    const s = getStats();
    return {
      sql: `SELECT 'sqlvec' AS pool_name, 'transaction' AS pool_mode, ${s.active} AS active, ${s.idle} AS idle, ${s.active + s.idle} AS total, ${s.waiting} AS waiting, ${s.max} AS max`,
      rewritten: true,
    };
  }

  if (SHOW_CLIENTS.test(trimmed)) {
    return {
      sql: "SELECT 1 AS pid, '' AS addr, 'sqlvec' AS db, 'active' AS state",
      rewritten: true,
    };
  }

  if (SHOW_STATS.test(trimmed)) {
    const s = getStats();
    return {
      sql: `SELECT ${s.active} AS total_queries, 0 AS avg_query_time_ms, ${s.waiting} AS waiting`,
      rewritten: true,
    };
  }

  if (SHOW_VERSION.test(trimmed)) {
    return {
      sql: "SELECT 'PgBouncer 1.22.1' AS version, 'SqlVec' AS compiler_version, 'SQLite' AS pooler_type",
      rewritten: true,
    };
  }

  if (SHOW_DATABASES.test(trimmed)) {
    return {
      sql: "SELECT 'sqlvec' AS name, 'SQLite' AS type, 0 AS connections",
      rewritten: true,
    };
  }

  if (SHOW_SERVERS.test(trimmed)) {
    const s = getStats();
    return {
      sql: `SELECT ${s.active + s.idle} AS total, ${s.active} AS active, ${s.idle} AS idle`,
      rewritten: true,
    };
  }

  if (SHOW_GENERIC.test(trimmed)) {
    return { sql: 'SELECT 1 AS stat', rewritten: true };
  }

  if (PAUSE_CMD.test(trimmed) || RESUME_CMD.test(trimmed) || RELOAD_CMD.test(trimmed)) {
    logger.debug({ sql: trimmed }, 'PgBouncer control command → SELECT 1');
    return { sql: 'SELECT 1', rewritten: true };
  }

  if (SET_CMD.test(trimmed)) {
    logger.debug({ sql: trimmed }, 'SET command → SELECT 1');
    return { sql: 'SELECT 1', rewritten: true };
  }

  // Unreachable by construction: detectPoolSql returns true iff one of the
  // patterns above matches, and every such pattern returns above.
  throw new Error('unreachable');
}
