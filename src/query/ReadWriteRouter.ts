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
 * Normalize SQL for analysis: collapse horizontal whitespace (spaces, tabs,
 * carriage returns) while PRESERVING newlines, because the line-comment
 * scanner in maskSqlLiterals relies on `\n` to terminate a `--` comment.
 */
function normalizeSql(sql: string): string {
  return sql.replace(/[ \t\r]+/g, ' ').trim();
}

/**
 * Mask non-SQL lexical extents (string literals, quoted identifiers,
 * dollar-quoted strings, and both line and block comments) by replacing each
 * character with a space while preserving character positions. The returned
 * text contains only genuine SQL keywords and punctuation, so downstream
 * keyword/pattern matching can never be fooled by a keyword that appears
 * inside a string literal, a quoted identifier, or a comment.
 *
 * Recognized extents:
 *   - '...'    single-quoted string, with '' as an escaped quote
 *   - "..."    double-quoted identifier, with "" as an escaped quote
 *   - $$...$$  dollar-quoted string (also $tag$...$tag$)
 *   - -- ...   line comment (to end of line)
 *   - /* ... *\/ block comment (non-nested)
 *
 * E[] escape sequences (backslash escapes) inside single-quoted strings are
 * also handled so a trailing backslash cannot break out of the literal.
 */
function maskSqlLiterals(sql: string): string {
  const out = sql.split('');
  const len = sql.length;

  for (let i = 0; i < len; i++) {
    const c = sql[i];

    // Line comment: mask to end of line (but preserve the newline).
    if (c === '-' && sql[i + 1] === '-') {
      out[i] = ' ';
      out[i + 1] = ' ';
      let j = i + 2;
      while (j < len && sql[j] !== '\n') {
        out[j] = ' ';
        j++;
      }
      i = j - 1;
      continue;
    }

    // Block comment: mask to closing */.
    if (c === '/' && sql[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      let j = i + 2;
      while (j < len && !(sql[j] === '*' && sql[j + 1] === '/')) {
        out[j] = ' ';
        j++;
      }
      if (j < len) {
        out[j] = ' ';
        out[j + 1] = ' ';
        i = j + 1;
      } else {
        i = len;
      }
      continue;
    }

    // Single-quoted string.
    if (c === "'") {
      out[i] = ' ';
      let j = i + 1;
      while (j < len) {
        if (sql[j] === '\\' && j + 1 < len) {
          // E''-style backslash escape consumes the next char too.
          out[j] = ' ';
          out[j + 1] = ' ';
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            // Escaped single quote ('').
            out[j] = ' ';
            out[j + 1] = ' ';
            j += 2;
            continue;
          }
          // Closing quote.
          out[j] = ' ';
          break;
        }
        out[j] = ' ';
        j++;
      }
      i = j;
      continue;
    }

    // Double-quoted identifier.
    if (c === '"') {
      out[i] = ' ';
      let j = i + 1;
      while (j < len) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            out[j] = ' ';
            out[j + 1] = ' ';
            j += 2;
            continue;
          }
          out[j] = ' ';
          break;
        }
        out[j] = ' ';
        j++;
      }
      i = j;
      continue;
    }

    // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty → $$...$$).
    if (c === '$') {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        for (let k = i; k < i + tag.length; k++) out[k] = ' ';
        if (close !== -1) {
          for (let k = i + tag.length; k < close + tag.length; k++) out[k] = ' ';
          i = close + tag.length - 1;
        } else {
          // Unterminated dollar quote: mask to end of input.
          for (let k = i + tag.length; k < len; k++) out[k] = ' ';
          i = len;
        }
        continue;
      }
    }
  }

  return out.join('');
}

/**
 * Get the first non-comment, non-literal meaningful word from SQL.
 */
function firstKeyword(sql: string): string {
  const clean = maskSqlLiterals(sql).trim();
  const match = clean.match(/^(\w+)/i);
  return match ? match[1].toUpperCase() : '';
}

/**
 * Check if a CTE (WITH clause) contains a modifying statement, ignoring any
 * occurrence of INSERT/UPDATE/DELETE/MERGE inside strings or comments.
 */
function cteHasModification(sql: string): boolean {
  const masked = maskSqlLiterals(sql);
  const withBlock = masked.match(/\bWITH\b[\s\S]*?(?:INSERT|UPDATE|DELETE|MERGE)\b/i);
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
        // COPY table [(cols)] TO ... → read, COPY table [(cols)] FROM ... → write.
        // Match against the masked text so FROM/TO inside the target string is
        // ignored, and tolerate an optional parenthesized column list before
        // the direction keyword, e.g. `COPY users (a,b) TO STDOUT`.
        const copyMasked = maskSqlLiterals(normalized);
        const copyMatch = copyMasked.match(/\bCOPY\b[\s\S]*?\b(FROM|TO)\b/i);
        return copyMatch && copyMatch[1].toUpperCase() === 'TO' ? 'read' : 'write';
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
    const masked = maskSqlLiterals(sql);
    const upper = masked.toUpperCase();

    // SELECT ... FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE / FOR KEY SHARE → write
    if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(upper)) {
      return 'write';
    }

    // SELECT ... INTO (creates a table) → write
    if (/\bINTO\s+(TEMP|TEMPORARY|UNLOGGED)?\s*(TABLE\s+)?\w+/i.test(upper)) {
      return 'write';
    }

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
