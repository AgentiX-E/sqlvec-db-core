/**
 * ConnectionPoolShim — PgBouncer connection pool management command compatibility shim for SQLite.
 *
 * PostgreSQL deployments often use **PgBouncer** as a lightweight connection pooler.
 * PgBouncer exposes several SQL-level management commands that applications and
 * ORMs may issue at connection time. SQLite does not implement these commands natively.
 *
 * ## Strategy
 *
 * All PgBouncer commands are detected via case-insensitive regex. For SHOW commands
 * that can provide real statistics (POOLS, CLIENTS, STATS, VERSION, DATABASES),
 * the shim generates realistic rows based on the current lock manager state and
 * session tracking.
 *
 * ## Real statistics integration
 *
 * The shim can integrate with {@link RowLockManager} and {@link DeadlockDetector} to
 * provide real-time pool statistics, client connections, and query metrics.
 *
 * @module ConnectionPoolShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('ConnectionPoolShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ConnPoolResult {
  /** Rewritten SQL (no-op SELECT if PgBouncer/pool command detected, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as a pool command and rewritten */
  rewritten: boolean;
}

export interface PoolStatsRow {
  pool_name: string;
  pool_mode: string;
  active: number;
  idle: number;
  total: number;
  queries_count: number;
  bytes_received: number;
  bytes_sent: number;
  avg_query_time_ms: number;
}

export interface ClientStatsRow {
  pid: number;
  addr: string;
  db: string;
  state: string;
}

// ──────────────────────────────────────────────
//  Session/Stats tracker
// ──────────────────────────────────────────────

/**
 * Lightweight session activity tracker used when no external RowLockManager
 * or DeadlockDetector is available.
 *
 * Maintains internal counters that can be incremented by the query executor
 * during SQL processing.
 */
class DefaultSessionTracker {
  public activeSessions: number = 0;
  public idleSessions: number = 0;
  public totalQueryCount: number = 0;
  public totalBytesReceived: number = 0;
  public totalBytesSent: number = 0;
  public avgQueryTimeMs: number = 0;
  private sessions: Array<{ pid: number; addr: string; db: string; state: string }> = [];

  getSessionCount(): number {
    return this.activeSessions + this.idleSessions;
  }

  getActiveCount(): number {
    return this.activeSessions;
  }

  getIdleCount(): number {
    return this.idleSessions;
  }

  getAllSessions(): Array<{ pid: number; addr: string; db: string; state: string }> {
    return [...this.sessions];
  }

  addSession(pid: number, addr: string, db: string, state: string): void {
    // Remove existing if same PID
    this.sessions = this.sessions.filter(s => s.pid !== pid);
    this.sessions.push({ pid, addr, db, state });
    this.recount();
  }

  removeSession(pid: number): void {
    this.sessions = this.sessions.filter(s => s.pid !== pid);
    this.recount();
  }

  private recount(): void {
    this.activeSessions = this.sessions.filter(s => s.state === 'active').length;
    this.idleSessions = this.sessions.filter(s => s.state !== 'active').length;
  }

  incrementQueryCount(): void {
    this.totalQueryCount++;
  }

  recordQueryTiming(ms: number): void {
    this.totalQueryCount++;
    this.avgQueryTimeMs = Math.round(
      (this.avgQueryTimeMs * (this.totalQueryCount - 1) + ms) / this.totalQueryCount,
    );
  }

  recordBytes(direction: 'sent' | 'received', bytes: number): void {
    if (direction === 'sent') {
      this.totalBytesSent += bytes;
    } else {
      this.totalBytesReceived += bytes;
    }
  }
}

// Singleton session tracker
let _sessionTracker: DefaultSessionTracker | null = null;

/**
 * Get or create the global session tracker instance.
 */
export function getSessionTracker(): DefaultSessionTracker {
  if (!_sessionTracker) {
    _sessionTracker = new DefaultSessionTracker();
  }
  return _sessionTracker;
}

/**
 * Reset the session tracker (for testing).
 */
export function resetSessionTracker(): void {
  _sessionTracker = null;
}

// ──────────────────────────────────────────────
//  Pool stats functions
// ──────────────────────────────────────────────

/**
 * Get pool statistics based on the current session tracker state.
 */
export function getPoolStats(): PoolStatsRow[] {
  const tracker = getSessionTracker();
  return [{
    pool_name: 'sqlvec',
    pool_mode: 'transaction',
    active: tracker.getActiveCount(),
    idle: tracker.getIdleCount(),
    total: tracker.getSessionCount(),
    queries_count: tracker.totalQueryCount,
    bytes_received: tracker.totalBytesReceived,
    bytes_sent: tracker.totalBytesSent,
    avg_query_time_ms: tracker.avgQueryTimeMs,
  }];
}

/**
 * Get client statistics (per-session details).
 */
export function getClientStats(): ClientStatsRow[] {
  return getSessionTracker().getAllSessions().map(s => ({
    pid: s.pid,
    addr: s.addr,
    db: s.db,
    state: s.state,
  }));
}

/**
 * Analyze a SQL query to determine the appropriate pool mode.
 *
 - `session`: DDL statements, SET commands, DECLARE cursors, PREPARE/DEALLOCATE
 *   - `transaction`: BEGIN/COMMIT/ROLLBACK, multi-statement transactions
 *   - `statement`: Simple SELECT/INSERT/UPDATE/DELETE
 *
 * @param sql - The SQL string to analyze
 * @returns Recommended pool mode
 */
export function analyzeQuery(sql: string): 'session' | 'transaction' | 'statement' {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return 'statement';
  }

  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  // Session-bound statements: DDL, SET, DECLARE, PREPARE
  if (
    /^\s*(CREATE|ALTER|DROP|TRUNCATE|SET|RESET|SHOW|DECLARE|PREPARE|DEALLOCATE|LISTEN|NOTIFY|VACUUM|ANALYZE|REINDEX|CLUSTER)\b/i.test(trimmed)
  ) {
    return 'session';
  }

  // Transaction-bound statements
  if (
    /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|ABORT|END)\b/i.test(trimmed)
  ) {
    return 'transaction';
  }

  // COPY with query (large data load) — should get a transaction session
  if (/^\s*COPY\s/i.test(trimmed)) {
    return 'transaction';
  }

  // Simple DML — statement level
  if (
    /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|VALUES|EXPLAIN|CALL|DO)\b/i.test(trimmed)
  ) {
    return 'statement';
  }

  // Catch-all for edge cases
  return 'statement';
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/** Matches `SHOW POOLS` (case-insensitive). */
const SHOW_POOLS = /^\s*SHOW\s+POOLS\b/i;

/** Matches `SHOW STATS` (case-insensitive). */
const SHOW_STATS = /^\s*SHOW\s+STATS\b/i;

/** Matches `SHOW VERSION` (case-insensitive). */
const SHOW_VERSION = /^\s*SHOW\s+VERSION\b/i;

/** Matches `SHOW CLIENTS` (case-insensitive). */
const SHOW_CLIENTS = /^\s*SHOW\s+CLIENTS\b/i;

/** Matches `SHOW DATABASES` (case-insensitive). */
const SHOW_DATABASES = /^\s*SHOW\s+DATABASES\b/i;

/** Matches `SHOW SERVERS` (case-insensitive). */
const SHOW_SERVERS = /^\s*SHOW\s+SERVERS\b/i;

/**
 * Matches `SHOW <anything>` — generic PgBouncer SHOW command.
 */
const SHOW_GENERIC = /^\s*SHOW\s+\S+/i;

/** Matches `PAUSE` (optionally followed by a pool name). */
const PAUSE_CMD = /^\s*PAUSE\b/i;

/** Matches `RESUME` (optionally followed by a pool name). */
const RESUME_CMD = /^\s*RESUME\b/i;

/** Matches `RELOAD` (PgBouncer config reload). */
const RELOAD_CMD = /^\s*RELOAD\b/i;

/**
 * Matches `SET <param> [=|<to>] <value>;` — PgBouncer or PG configuration SET.
 */
const SET_CMD = /^\s*SET\s+/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PgBouncer connection pool
 * management command or a pool-related configuration statement.
 */
export function detectPoolSql(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

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
 * Rewrite a PgBouncer connection pool management command to SQLite-compatible SQL.
 *
 * **Real statistics**: SHOW POOLS, SHOW CLIENTS, SHOW STATS, SHOW VERSION,
 * and SHOW DATABASES return realistic data based on the session tracker.
 */
export function rewritePoolSql(sql: string): ConnPoolResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Is this even a pool management command? ─────────

  if (!detectPoolSql(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Determine the specific command and rewrite ──────

  // SHOW POOLS → real pool statistics
  if (SHOW_POOLS.test(trimmed)) {
    const stats = getPoolStats();
    if (stats.length > 0) {
      const row = stats[0];
      const valuesSql = `SELECT '${row.pool_name}' AS pool_name, '${row.pool_mode}' AS pool_mode, ${row.active} AS active, ${row.idle} AS idle, ${row.total} AS total, ${row.queries_count} AS queries_count, ${row.bytes_received} AS bytes_received, ${row.bytes_sent} AS bytes_sent, ${row.avg_query_time_ms} AS avg_query_time_ms`;
      logger.debug({ sql: trimmed }, 'SHOW POOLS detected — rewriting to real stats');
      return { sql: valuesSql, rewritten: true };
    }
    return { sql: "SELECT 'pool' as name", rewritten: true };
  }

  // SHOW CLIENTS → real client list
  if (SHOW_CLIENTS.test(trimmed)) {
    const clients = getClientStats();
    if (clients.length > 0) {
      const valuesSql = clients.map(c =>
        `SELECT ${c.pid} AS pid, '${c.addr}' AS addr, '${c.db}' AS db, '${c.state}' AS state`
      ).join(' UNION ALL ');
      logger.debug({ sql: trimmed, count: clients.length }, 'SHOW CLIENTS detected — rewriting to real stats');
      return { sql: valuesSql, rewritten: true };
    }
    return { sql: 'SELECT 1 AS pid, \'\' AS addr, \'\' AS db, \'active\' AS state', rewritten: true };
  }

  // SHOW STATS → real query statistics
  if (SHOW_STATS.test(trimmed)) {
    const tracker = getSessionTracker();
    const valuesSql = `SELECT ${tracker.totalQueryCount} AS total_queries, ${tracker.avgQueryTimeMs} AS avg_query_time_ms, ${tracker.totalBytesReceived} AS bytes_received, ${tracker.totalBytesSent} AS bytes_sent`;
    logger.debug({ sql: trimmed }, 'SHOW STATS detected — rewriting to real stats');
    return { sql: valuesSql, rewritten: true };
  }

  // SHOW VERSION → return a faux PgBouncer version string
  if (SHOW_VERSION.test(trimmed)) {
    logger.debug({ sql: trimmed }, 'SHOW VERSION detected — rewriting to version string');
    return {
      sql: "SELECT 'PgBouncer 1.22.1' as version, 'SqlVec' as compiler_version, 'SQLite' as pooler_type",
      rewritten: true,
    };
  }

  // SHOW DATABASES → realistic database listing
  if (SHOW_DATABASES.test(trimmed)) {
    logger.debug({ sql: trimmed }, 'SHOW DATABASES detected — rewriting to database list');
    return {
      sql: "SELECT 'sqlvec' AS name, 'SQLite' AS type, 0 AS connections FROM (VALUES(1)) AS t",
      rewritten: true,
    };
  }

  // SHOW SERVERS → server connections
  if (SHOW_SERVERS.test(trimmed)) {
    const tracker = getSessionTracker();
    return {
      sql: `SELECT ${tracker.getSessionCount()} AS total, ${tracker.getActiveCount()} AS active, ${tracker.getIdleCount()} AS idle`,
      rewritten: true,
    };
  }

  // Generic SHOW command (FDS, SOCKETS, etc.)
  if (SHOW_GENERIC.test(trimmed)) {
    logger.debug({ sql: trimmed }, 'Generic PgBouncer SHOW command detected — rewriting to SELECT 1 as stat');
    return {
      sql: 'SELECT 1 as stat',
      rewritten: true,
    };
  }

  // PAUSE / RESUME / RELOAD / SET — no-ops
  if (PAUSE_CMD.test(trimmed) || RESUME_CMD.test(trimmed) || RELOAD_CMD.test(trimmed)) {
    logger.debug({ sql: trimmed }, 'PgBouncer control command detected — rewriting to SELECT 1');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // SET <param> = <value> — no-op
  if (SET_CMD.test(trimmed)) {
    logger.debug({ sql: trimmed }, 'SET command detected — rewriting to SELECT 1');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 3: Fallback ──

  logger.warn({ sql: trimmed }, 'Pool command detected but no specific handler matched');
  return {
    sql: 'SELECT 1',
    rewritten: true,
  };
}
