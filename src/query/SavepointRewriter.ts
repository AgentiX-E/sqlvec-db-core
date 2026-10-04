/**
 * SavepointRewriter — Detects SAVEPOINT / RELEASE / ROLLBACK TO statements
 * and passes them through unchanged to SQLite.
 *
 * SQLite natively supports SAVEPOINT, RELEASE, and ROLLBACK TO syntax,
 * including the optional SAVEPOINT keyword after RELEASE and ROLLBACK TO.
 * No rewriting is needed — all savepoint statements are passed through
 * as-is to the SQLite engine.
 *
 * Detection covers:
 *
 *   | Statement                          | SQLite Support |
 *   |:-----------------------------------|:---------------|
 *   | `SAVEPOINT <name>`                 | ✅ Native      |
 *   | `RELEASE [SAVEPOINT] <name>`       | ✅ Native      |
 *   | `ROLLBACK [WORK] TO [SAVEPOINT] <name>` | ✅ Native |
 *   | `ROLLBACK [WORK]`                  | ✅ Native      |
 *
 * @module query/SavepointRewriter
 */

import { PinoLogger } from '../logger/PinoLogger';

// ── Logger ──────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('SavepointRewriter');

// ── Types ──────────────────────────────────────────────────────

export interface SavepointResult {
  /** Rewritten SQL string (unchanged — pass-through) */
  sql: string;
  /** Whether a savepoint statement was detected */
  rewritten: boolean;
}

/**
 * A pending change entry with savepoint level tracking for nested savepoints.
 */
export interface PendingChange {
  sql: string;
  params?: any[];
  /** The savepoint nesting level at which this change was recorded (0 = transaction level). */
  savepointLevel: number;
}

/**
 * Manages savepoint state including nesting levels and pending changes.
 */
export class SavepointManager {
  private readonly logger = PinoLogger.forComponent('SavepointManager');

  /** Stack of savepoint names representing current nesting. */
  private savepointStack: string[] = [];

  /** All pending changes with their savepoint nesting level. */
  private pendingChanges: PendingChange[] = [];

  /**
   * Record the position in pendingChanges at each savepoint boundary.
   * Keyed by savepoint name, maps to the index in pendingChanges where that savepoint was created.
   */
  private savepointIndexMap = new Map<string, number>();

  /**
   * Execute a SAVEPOINT statement — caches current pendingChanges index position.
   */
  savepoint(name: string): void {
    this.savepointStack.push(name);
    this.savepointIndexMap.set(name, this.pendingChanges.length);
    this.logger.debug({ name, level: this.savepointStack.length }, 'SAVEPOINT established');
  }

  /**
   * Execute a RELEASE statement — removes the savepoint boundary from tracking
   * without discarding changes.
   */
  release(name: string): void {
    // Remove from stack (all savepoints up to and including name). Releasing a
    // savepoint also releases every nested savepoint established inside it, so
    // drop their index entries too — mirroring the rollbackTo cleanup — to
    // avoid leaking stale entries that later rollbacks would mis-dispatch on.
    const idx = this.savepointStack.lastIndexOf(name);
    if (idx >= 0) {
      for (let i = this.savepointStack.length - 1; i >= idx; i--) {
        this.savepointIndexMap.delete(this.savepointStack[i]);
      }
      this.savepointStack.splice(idx);
    } else {
      this.savepointIndexMap.delete(name);
    }
    this.logger.debug({ name, remainingLevel: this.savepointStack.length }, 'SAVEPOINT released');
  }

  /**
   * Execute a ROLLBACK TO SAVEPOINT — discards only pending changes
   * that were recorded after the named savepoint was created.
   */
  rollbackTo(name: string): void {
    const savedIndex = this.savepointIndexMap.get(name);
    if (savedIndex === undefined) {
      this.logger.warn({ name }, 'ROLLBACK TO SAVEPOINT: savepoint not found');
      return;
    }

    // Discard pending changes from the savepoint index onward. When the
    // savepoint was created and then rolled back with no intervening change,
    // savedIndex equals the current length and there is nothing to discard.
    if (savedIndex < this.pendingChanges.length) {
      this.pendingChanges.splice(savedIndex);
    } else {
      // Nothing recorded after this savepoint — leave pendingChanges intact.
      this.logger.debug({ name }, 'ROLLBACK TO SAVEPOINT: no pending changes to discard');
    }

    // Remove savepoints from stack (all created after and including `name`).
    // Invariant: `savedIndex` was defined above, so `name` exists in the index
    // map. savepoint()/release()/rollbackTo() keep the stack and index map in
    // lockstep, therefore `name` is also present in the stack and stackIdx is
    // guaranteed to be >= 0 here.
    const stackIdx = this.savepointStack.lastIndexOf(name);
    for (let i = this.savepointStack.length - 1; i >= stackIdx; i--) {
      this.savepointIndexMap.delete(this.savepointStack[i]);
    }
    this.savepointStack.splice(stackIdx);

    this.logger.debug({ name }, 'ROLLBACK TO SAVEPOINT executed');
  }

  /**
   * Record a pending change at the current savepoint level.
   */
  recordChange(sql: string, params?: any[]): void {
    this.pendingChanges.push({
      sql,
      params,
      savepointLevel: this.savepointStack.length,
    });
  }

  /**
   * Get all pending changes (e.g., for COMMIT).
   */
  getPendingChanges(): PendingChange[] {
    return [...this.pendingChanges];
  }

  /**
   * Get pending changes at or below a specific savepoint level (for partial commit).
   */
  getChangesUpToLevel(level: number): PendingChange[] {
    return this.pendingChanges.filter(c => c.savepointLevel <= level);
  }

  /**
   * Get all pending changes excluding those in a specific savepoint level range.
   */
  getChangesOutsideLevel(level: number): PendingChange[] {
    return this.pendingChanges.filter(c => c.savepointLevel !== level);
  }

  /**
   * Clear all pending changes (e.g., after COMMIT or full ROLLBACK).
   */
  clearChanges(): void {
    this.pendingChanges = [];
  }

  /**
   * Get the current savepoint depth.
   */
  get depth(): number {
    return this.savepointStack.length;
  }

  /**
   * Get the current savepoint stack (copy).
   */
  get stack(): string[] {
    return [...this.savepointStack];
  }

  /**
   * Get the number of pending changes.
   */
  get pendingCount(): number {
    return this.pendingChanges.length;
  }

  /**
   * Reset all state (for testing or re-initialization).
   */
  reset(): void {
    this.savepointStack = [];
    this.pendingChanges = [];
    this.savepointIndexMap.clear();
    this.logger.debug('SavepointManager reset');
  }
}

// ── Regex patterns ──────────────────────────────────────────

/**
 * Detect any SAVEPOINT / RELEASE / ROLLBACK savepoint statement.
 *
 * Matches the following patterns (case-insensitive, leading whitespace tolerant):
 *   - SAVEPOINT <name>
 *   - RELEASE [SAVEPOINT] <name>
 *   - ROLLBACK [WORK] [TO [SAVEPOINT] <name>]
 *   - ROLLBACK WORK
 *
 * The trailing semicolon (;) is optional.
 */
const SAVEPOINT_DETECT_RE =
  /^\s*(?:SAVEPOINT\s+\S+|RELEASE\s+(?:SAVEPOINT\s+)?\S+|ROLLBACK\s+(?:WORK(?:\s+TO\s+(?:SAVEPOINT\s+)?\S+)?|TO\s+(?:SAVEPOINT\s+)?\S+))\s*;?\s*$/i;

// ── Public API ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement is a SAVEPOINT / RELEASE / ROLLBACK TO
 * savepoint-related statement.
 *
 * @param sql - A single SQL statement string
 * @returns `true` if the statement is a savepoint-related statement
 *
 * @example
 * ```ts
 * detectSavepointStmt('SAVEPOINT sp1');               // true
 * detectSavepointStmt('RELEASE SAVEPOINT sp1');       // true
 * detectSavepointStmt('ROLLBACK WORK TO sp1');        // true
 * detectSavepointStmt('SELECT * FROM t');             // false
 * detectSavepointStmt('COMMIT');                      // false
 * ```
 */
export function detectSavepointStmt(sql: string): boolean {
  // Fast path: keyword-based prefix check before full regex
  const trimmed = sql.trimStart();
  const firstWord = trimmed.match(/^\s*(\w+)/i)?.[1]?.toUpperCase() ?? '';

  if (firstWord !== 'SAVEPOINT' && firstWord !== 'RELEASE' && firstWord !== 'ROLLBACK') {
    return false;
  }

  const result = SAVEPOINT_DETECT_RE.test(sql);
  logger.debug({ sql: sql.substring(0, 80), detected: result }, 'detectSavepointStmt');
  return result;
}

/**
 * Handle a SAVEPOINT / RELEASE / ROLLBACK TO statement — pass-through to SQLite
 * without any rewriting.
 *
 * SQLite natively supports all common savepoint syntax:
 *   - SAVEPOINT <name>
 *   - RELEASE [SAVEPOINT] <name>
 *   - ROLLBACK [WORK] TO [SAVEPOINT] <name>
 *   - ROLLBACK [WORK]
 *
 * No rewriting is needed, so the original SQL is returned unchanged.
 * The `rewritten` flag is set to `true` when a savepoint statement is detected
 * (signalling to the caller that the statement was recognized and handled).
 *
 * @param sql - A savepoint-related SQL statement
 * @returns An object with the unchanged SQL and a flag indicating detection
 *
 * @example
 * ```ts
 * rewriteSavepointStmt('SAVEPOINT sp1');
 * // → { sql: 'SAVEPOINT sp1', rewritten: true }
 *
 * rewriteSavepointStmt('RELEASE SAVEPOINT sp1');
 * // → { sql: 'RELEASE SAVEPOINT sp1', rewritten: true }
 *
 * rewriteSavepointStmt('ROLLBACK TO SAVEPOINT sp1');
 * // → { sql: 'ROLLBACK TO SAVEPOINT sp1', rewritten: true }
 *
 * rewriteSavepointStmt('SELECT * FROM t');
 * // → { sql: 'SELECT * FROM t', rewritten: false }
 * ```
 */
export function rewriteSavepointStmt(sql: string): SavepointResult {
  if (!detectSavepointStmt(sql)) {
    return { sql, rewritten: false };
  }

  logger.debug({ sql: sql.substring(0, 80) }, 'Savepoint statement detected — pass-through to SQLite');

  return {
    sql,          // ← pass-through unchanged
    rewritten: true,  // ← signals to the caller that the statement was handled
  };
}
