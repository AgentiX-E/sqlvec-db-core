/**
 * ReadWriteRouter — Read-write split routing for SQL queries
 *
 * Phase B #3b: Routes read-only queries to a replica database (when available)
 * and write queries to the primary database. Supports:
 *   - SQL statement classification (read / write / unknown)
 *   - Smart routing with transaction consistency
 *   - Replica health checking
 *   - Auto-detection of read-only mode databases
 *   - Fallback to primary when replica is unhealthy
 *
 * Routing rules:
 *   - SELECT (without FOR UPDATE / INTO) → read (→ replica)
 *   - INSERT / UPDATE / DELETE → write (→ primary)
 *   - DDL (CREATE / ALTER / DROP / TRUNCATE) → write
 *   - SELECT ... FOR UPDATE / FOR SHARE → write (needs primary for row locking)
 *   - SELECT ... INTO (creates table) → write
 *   - WITH (CTE) with modifying CTE (INSERT/UPDATE/DELETE inside WITH) → write
 *   - CALL (procedure) → write
 *   - DO block → write
 *   - SET / SHOW → unknown (→ primary)
 *   - In transaction blocks → always primary
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('ReadWriteRouter');

// ── Types ────────────────────────────────────────────────────────

export type QueryRole = 'read' | 'write' | 'unknown';

// ── SQL Tokenizer Helpers ────────────────────────────────────────

/**
 * Normalize SQL for analysis: collapse whitespace, lowercase.
 */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Get the first non-comment, meaningful word from SQL.
 */
function firstKeyword(sql: string): string {
  const clean = sql.replace(/\/\*[\s\S]*?\*\/|--.*$/gm, '').trim();
  const match = clean.match(/^(\w+)/i);
  return match ? match[1].toUpperCase() : '';
}

/**
 * Check if a CTE (WITH clause) contains a modifying statement.
 */
function cteHasModification(sql: string): boolean {
  // Match WITH ... AS ( ... INSERT|UPDATE|DELETE ... )
  const withBlock = sql.match(/\bWITH\b[\s\S]*?(?:INSERT|UPDATE|DELETE|MERGE)\b/i);
  return withBlock !== null;
}

// ── ReadWriteRouter ──────────────────────────────────────────────

export class ReadWriteRouter {
  private primaryDb: any;   // better-sqlite3 for writes
  private replicaDb?: any;  // optional read-only replica
  private replicaHealth: boolean = true;
  private lastHealthCheck: number = 0;
  private readonly healthCheckIntervalMs: number = 5000;

  constructor(primaryDb: any, replicaDb?: any) {
    this.primaryDb = primaryDb;
    this.replicaDb = replicaDb;

    logger.info(
      { hasReplica: !!replicaDb },
      'ReadWriteRouter initialized',
    );
  }

  // ── SQL Classification ───────────────────────────────────────

  /**
   * Determine if a SQL statement is read-only, write, or unknown.
   *
   * Returns:
   *   - 'read' for SELECT (without FOR UPDATE/INTO or modifying CTE)
   *   - 'write' for INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE/CALL/DO,
   *     SELECT ... FOR UPDATE/INTO, or WITH with modifying CTE
   *   - 'unknown' for SET, SHOW, BEGIN, COMMIT, ROLLBACK, etc.
   */
  classifyQuery(sql: string): QueryRole {
    if (!sql || typeof sql !== 'string') return 'unknown';

    const normalized = normalizeSql(sql);
    const keyword = firstKeyword(normalized);

    switch (keyword) {
      // ── Read-only
      case 'SELECT':
        return this.classifySelect(normalized);

      // ── Write
      case 'INSERT':
      case 'UPDATE':
      case 'DELETE':
      case 'MERGE':
        return 'write';

      // ── DDL (write)
      case 'CREATE':
      case 'ALTER':
      case 'DROP':
      case 'TRUNCATE':
      case 'COMMENT':
      case 'RENAME':
      case 'GRANT':
      case 'REVOKE':
      case 'ANALYZE':
      case 'VACUUM':
      case 'REINDEX':
      case 'CLUSTER':
        return 'write';

      // ── Procedure / blocks (write)
      case 'CALL':
      case 'DO':
      case 'DECLARE':
        return 'write';

      // ── CTE (WITH ...)
      case 'WITH':
        if (cteHasModification(normalized)) return 'write';
        // WITH that only has SELECT CTEs → read
        return 'read';

      // ── Unknown / control
      case 'SET':
      case 'SHOW':
      case 'BEGIN':
      case 'COMMIT':
      case 'ROLLBACK':
      case 'SAVEPOINT':
      case 'RELEASE':
      case 'PREPARE':
      case 'EXECUTE':
      case 'DEALLOCATE':
      case 'LISTEN':
      case 'NOTIFY':
      case 'UNLISTEN':
      case 'DISCARD':
      case 'LOAD':
      case 'CHECKPOINT':
        return 'unknown';

      // ── EXPLAIN / DESCRIBE
      case 'EXPLAIN':
      case 'DESCRIBE':
        return 'read';

      // ── COPY
      case 'COPY': {
        // COPY table TO → read, COPY table FROM → write
        const copyMatch = normalized.match(/\bCOPY\s+\w+\s+TO\b/i);
        return copyMatch ? 'read' : 'write';
      }

      // ── LOCK / SELECT ... INTO
      default: {
        // LOCK TABLE
        if (keyword === 'LOCK') return 'write';
        // UNKNOWN
        return 'unknown';
      }
    }
  }

  /**
   * Classify a SELECT statement (may actually be write if FOR UPDATE/INTO or data-modifying CTE).
   */
  private classifySelect(sql: string): QueryRole {
    const upper = sql.toUpperCase();

    // SELECT ... FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE / FOR KEY SHARE → write
    if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(upper)) {
      return 'write';
    }

    // SELECT ... INTO (creates a table) → write
    if (/\bINTO\s+(TEMP|TEMPORARY|UNLOGGED)?\s*(TABLE\s+)?\w+/i.test(upper)) {
      // Make sure it's not just a regular SELECT INTO variable
      const selectIntoTable = sql.match(
        /\bSELECT\b[\s\S]*?\bINTO\s+(TEMP|TEMPORARY|UNLOGGED)?\s*(TABLE\s+)?[a-zA-Z_]\w*/i,
      );
      if (selectIntoTable) return 'write';
    }

    // WITH (CTE) with modifying CTE → checked earlier via WITH keyword
    // At this point we already know it's SELECT or WITH

    return 'read';
  }

  // ── Routing ───────────────────────────────────────────────────

  /**
   * Route a SQL query to the appropriate database.
   *
   * @param sql - The SQL statement to route
   * @param inTransaction - Whether we're inside a transaction block (forces primary)
   * @returns Object with the target db and whether it's read-only
   */
  route(
    sql: string,
    inTransaction: boolean = false,
  ): { db: any; isReadOnly: boolean } {
    const role = this.classifyQuery(sql);

    // In transaction → always use primary
    if (inTransaction) {
      logger.debug(
        { role, inTransaction: true },
        'In transaction block, routing to primary',
      );
      return { db: this.primaryDb, isReadOnly: false };
    }

    // Read queries → try replica
    if (role === 'read' && this.replicaDb && this.isReplicaHealthy()) {
      logger.debug('Routing read query to replica');
      return { db: this.replicaDb, isReadOnly: true };
    }

    // Write/unknown → primary
    // Also fallback to primary when replica is unhealthy
    if (role === 'read' && !this.isReplicaHealthy()) {
      logger.warn('Replica unhealthy, falling back to primary for read query');
    }

    return { db: this.primaryDb, isReadOnly: false };
  }

  // ── Replica Health ───────────────────────────────────────────

  /**
   * Check whether the replica database is healthy.
   * Caches the result for `healthCheckIntervalMs` to avoid hammering the replica.
   */
  isReplicaHealthy(): boolean {
    if (!this.replicaDb) return false;

    const now = Date.now();
    if (now - this.lastHealthCheck < this.healthCheckIntervalMs) {
      return this.replicaHealth;
    }

    this.lastHealthCheck = now;

    try {
      // Try a simple query against the replica
      const row = this.replicaDb.prepare('SELECT 1 AS ok').get() as any;
      const healthy = row && Number(row.ok) === 1;
      this.replicaHealth = healthy;
      if (!healthy) {
        logger.error('Replica health check failed: unexpected result');
      }
      return healthy;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Replica health check failed');
      this.replicaHealth = false;
      return false;
    }
  }

  /**
   * Force-set replica health (useful for testing).
   */
  setReplicaHealth(healthy: boolean): void {
    this.replicaHealth = healthy;
    this.lastHealthCheck = Date.now();
  }

  // ── Auto-detection ──────────────────────────────────────────

  /**
   * Check if a database connection is in read-only mode.
   * Attempts to execute a write statement and checks for errors.
   */
  static checkIsReplica(db: any): boolean {
    if (!db || typeof db !== 'object') return false;

    try {
      // If PRAGMA query_only is set, this is a read-only connection
      const pragma = db.prepare ? db.prepare('PRAGMA query_only').get() as any : null;
      if (pragma && Number(pragma.query_only) === 1) {
        return true;
      }
    } catch {
      // Non-fatal
    }

    // Try writing to a temporary table to detect read-only mode
    try {
      db.exec('CREATE TEMP TABLE IF NOT EXISTS __readonly_test (id INTEGER)');
      try {
        db.exec('DROP TABLE IF EXISTS __readonly_test');
      } catch {
        // Non-fatal cleanup
      }
      return false; // Writes succeeded → not a replica
    } catch {
      // Write failed → likely read-only mode
      logger.debug('Database appears to be read-only (replica mode detected)');
      return true;
    }
  }
}
