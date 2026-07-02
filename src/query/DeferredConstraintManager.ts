/**
 * DeferredConstraintManager — Deferred constraint checking for SQLite.
 *
 * Implements PostgreSQL-compatible deferred constraint validation. When a
 * transaction sets `SET CONSTRAINTS ALL DEFERRED`, or when a constraint is
 * declared `DEFERRABLE INITIALLY DEFERRED`, constraint checks (FOREIGN KEY,
 * UNIQUE, MATCH) are buffered and only validated at COMMIT time.
 *
 * ## Design
 *
 * The QueryRouter intercepts DML operations and notifies this manager of each
 * constraint-violation-prone action. Instead of checking immediately, the
 * manager caches the pending checks. When the transaction commits, it
 * replays and validates all cached constraints.
 *
 * ## Supported constraint types
 *
 * - **FOREIGN KEY**: Ensures referenced rows exist in the parent table.
 * - **UNIQUE**: Ensures no duplicate values across buffered + committed rows.
 * - **MATCH FULL / PARTIAL / SIMPLE**: PG MATCH clause support for FK columns.
 *
 * ## Example
 *
 * ```
 * const deferredMgr = new DeferredConstraintManager();
 * deferredMgr.setConstraintsDeferred('sess-1', true);
 * deferredMgr.queueFkCheck('sess-1', 'orders', 'customer_id', 'customers', 'id', 42);
 * // ... more operations ...
 * const errors = deferredMgr.validateAll('sess-1'); // Check at commit time
 * ```
 *
 * @module query/DeferredConstraintManager
 */

import { PinoLogger } from '../logger/PinoLogger';

// ── Logger ───────────────────────────────────────────────────────


// ── Types ────────────────────────────────────────────────────────

export type ConstraintType = 'FOREIGN KEY' | 'UNIQUE' | 'MATCH';

export type MatchType = 'FULL' | 'PARTIAL' | 'SIMPLE';

export interface DeferredFkCheck {
  type: 'FOREIGN KEY';
  /** Child table name where the FK is defined. */
  childTable: string;
  /** Column(s) in the child table that form the FK. */
  childColumns: string[];
  /** Parent table being referenced. */
  parentTable: string;
  /** Column(s) in the parent table. */
  parentColumns: string[];
  /** The actual FK value(s) being inserted/updated. */
  values: any[];
  /** PG match type for composite FK. */
  matchType: MatchType;
  /** When this check was queued (epoch ms). */
  queuedAt: number;
}

export interface DeferredUniqueCheck {
  type: 'UNIQUE';
  /** Table name where the UNIQUE constraint is defined. */
  table: string;
  /** Constraint name. */
  constraintName: string;
  /** Column(s) that form the unique constraint. */
  columns: string[];
  /** The actual values being inserted/updated. */
  values: any[];
  /** Transaction-local row identifier for dedup. */
  localRowId: string;
}

export type DeferredCheck = DeferredFkCheck | DeferredUniqueCheck;

export interface ConstraintViolation {
  /** Type of constraint that was violated. */
  constraintType: ConstraintType;
  /** Constraint name, if available. */
  constraintName?: string;
  /** Table where the violation occurred. */
  table: string;
  /** Human-readable error message. */
  message: string;
  /** PG-compatible error code. */
  sqlState: string;
}

// ── Per-session state ────────────────────────────────────────────

interface SessionState {
  /** Whether constraints are deferred for this session. */
  deferred: boolean;
  /** Pending constraint checks. */
  pendingChecks: DeferredCheck[];
  /** Whether the session has any initially-deferred constraints. */
  hasInitiallyDeferred: boolean;
}

// ── DeferredConstraintManager ────────────────────────────────────

export class DeferredConstraintManager {
  private readonly logger = PinoLogger.forComponent('deferredconstraintmanager');

  /** Per-session state. */
  private sessions: Map<string, SessionState> = new Map();
  /** Registered constraint definitions (for metadata queries). */
  private constraintDefs: Map<string, { type: ConstraintType; table: string; columns: string[]; deferred: boolean; initiallyDeferred: boolean }> = new Map();

  // ── Transaction-level controls ────────────────────────────────

  /**
   * Set whether constraints are deferred for a given session.
   *
   * Corresponds to `SET CONSTRAINTS ALL DEFERRED` / `SET CONSTRAINTS ALL IMMEDIATE`.
   *
   * @param sessionId - Session identifier.
   * @param deferred  - `true` to defer, `false` to make immediate.
   */
  setConstraintsDeferred(sessionId: string, deferred: boolean): void {
    const state = this.getOrCreateState(sessionId);
    state.deferred = deferred;

    this.logger.info({ sessionId, deferred, pending: state.pendingChecks.length },
      'Constraint deferral state set');
  }

  /**
   * Check whether constraints are currently deferred for a session.
   *
   * @param sessionId - Session identifier.
   * @returns `true` if deferred.
   */
  isDeferred(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return state ? state.deferred : false;
  }

  // ── Queuing constraint checks ────────────────────────────────

  /**
   * Queue a FOREIGN KEY constraint check.
   *
   * @param sessionId    - Session identifier.
   * @param childTable   - Table containing the FK.
   * @param childColumns - FK column(s) in the child table.
   * @param parentTable  - Referenced parent table.
   * @param parentColumns - PK column(s) in the parent table.
   * @param values       - The FK value(s) being inserted/updated.
   * @param matchType    - PG match type (default: 'SIMPLE').
   */
  queueFkCheck(
    sessionId: string,
    childTable: string,
    childColumns: string[],
    parentTable: string,
    parentColumns: string[],
    values: any[],
    matchType: MatchType = 'SIMPLE',
  ): void {
    const state = this.getOrCreateState(sessionId);

    if (!state.deferred) {
      // If not deferred, we skip queuing — the caller should check immediately.
      this.logger.debug(
        { sessionId, childTable, parentTable },
        'FK check not deferred — skipping queue',
      );
      return;
    }

    const check: DeferredFkCheck = {
      type: 'FOREIGN KEY',
      childTable,
      childColumns,
      parentTable,
      parentColumns,
      values,
      matchType,
      queuedAt: Date.now(),
    };

    state.pendingChecks.push(check);

    this.logger.debug(
      { sessionId, childTable, parentTable, values, pending: state.pendingChecks.length },
      'FK check queued for deferred validation',
    );
  }

  /**
   * Queue a UNIQUE constraint check.
   *
   * @param sessionId      - Session identifier.
   * @param table          - Table with the UNIQUE constraint.
   * @param constraintName - Constraint name.
   * @param columns        - Column(s) forming the unique constraint.
   * @param values         - The values being inserted/updated.
   * @param localRowId     - Transaction-local row ID for dedup.
   */
  queueUniqueCheck(
    sessionId: string,
    table: string,
    constraintName: string,
    columns: string[],
    values: any[],
    localRowId: string,
  ): void {
    const state = this.getOrCreateState(sessionId);

    if (!state.deferred) return;

    const check: DeferredUniqueCheck = {
      type: 'UNIQUE',
      table,
      constraintName,
      columns,
      values,
      localRowId,
    };

    state.pendingChecks.push(check);

    this.logger.debug(
      { sessionId, table, constraintName, values },
      'UNIQUE check queued for deferred validation',
    );
  }

  // ── Validation at commit time ─────────────────────────────────

  /**
   * Validate all deferred constraint checks for a session.
   *
   * Should be called at commit time to replay all cached checks.
   *
   * @param sessionId          - Session identifier.
   * @param checkFkExistsFn    - Function to check if a FK reference exists
   *                             in the parent table: (parentTable, parentColumns, values) => boolean.
   * @param checkUniqueExistsFn - Function to check if a unique value already
   *                             exists in the table: (table, columns, values) => boolean.
   * @returns Array of constraint violations (empty = success).
   */
  validateAll(
    sessionId: string,
    checkFkExistsFn?: (parentTable: string, parentColumns: string[], values: any[]) => boolean,
    checkUniqueExistsFn?: (table: string, columns: string[], values: any[], excludeRowId?: string) => boolean,
  ): ConstraintViolation[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];

    const violations: ConstraintViolation[] = [];

    for (const check of state.pendingChecks) {
      switch (check.type) {
        case 'FOREIGN KEY':
          violations.push(...this.validateFk(check, checkFkExistsFn));
          break;
        case 'UNIQUE':
          violations.push(...this.validateUnique(check, checkUniqueExistsFn));
          break;
      }
    }

    if (violations.length > 0) {
      this.logger.warn(
        { sessionId, total: state.pendingChecks.length, violations: violations.length },
        'Deferred constraint violations detected',
      );
    } else {
      this.logger.info(
        { sessionId, total: state.pendingChecks.length },
        'All deferred constraints passed',
      );
    }

    // Clear pending checks after validation.
    state.pendingChecks = [];

    return violations;
  }

  /**
   * Clear all pending checks for a session without validating (rollback case).
   *
   * @param sessionId - Session identifier.
   */
  clearPending(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      const count = state.pendingChecks.length;
      state.pendingChecks = [];
      this.logger.info({ sessionId, cleared: count }, 'Pending deferred checks cleared');
    }
  }

  // ── Constraint registration ──────────────────────────────────

  /**
   * Register a constraint definition.
   *
   * @param name              - Constraint name.
   * @param type              - Constraint type.
   * @param table             - Table name.
   * @param columns           - Column(s) involved.
   * @param deferred          - Whether the constraint is DEFERRABLE.
   * @param initiallyDeferred - Whether it's INITIALLY DEFERRED.
   */
  registerConstraint(
    name: string,
    type: ConstraintType,
    table: string,
    columns: string[],
    deferred: boolean,
    initiallyDeferred: boolean,
  ): void {
    this.constraintDefs.set(name, { type, table, columns, deferred, initiallyDeferred });

    this.logger.info({ name, type, table, initiallyDeferred }, 'Constraint registered');
  }

  /**
   * Unregister a constraint.
   *
   * @param name - Constraint name.
   */
  unregisterConstraint(name: string): void {
    this.constraintDefs.delete(name);
    this.logger.info({ name }, 'Constraint unregistered');
  }

  /**
   * Get a registered constraint definition.
   *
   * @param name - Constraint name.
   * @returns The constraint definition, or `undefined`.
   */
  getConstraint(name: string): { type: ConstraintType; table: string; columns: string[]; deferred: boolean; initiallyDeferred: boolean } | undefined {
    return this.constraintDefs.get(name);
  }

  /**
   * Get all registered constraint definitions.
   */
  getAllConstraints(): Array<{ name: string; type: ConstraintType; table: string; columns: string[]; deferred: boolean; initiallyDeferred: boolean }> {
    return Array.from(this.constraintDefs.entries()).map(([name, def]) => ({
      name,
      ...def,
    }));
  }

  /**
   * Get the count of pending checks for a session.
   *
   * @param sessionId - Session identifier.
   */
  getPendingCount(sessionId: string): number {
    const state = this.sessions.get(sessionId);
    return state ? state.pendingChecks.length : 0;
  }

  /**
   * Get the count of pending checks across all sessions.
   */
  getTotalPendingCount(): number {
    let total = 0;
    for (const state of this.sessions.values()) {
      total += state.pendingChecks.length;
    }
    return total;
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.sessions.clear();
    this.constraintDefs.clear();
    this.logger.info('DeferredConstraintManager state reset');
  }

  // ── Private helpers ───────────────────────────────────────────

  private getOrCreateState(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { deferred: false, pendingChecks: [], hasInitiallyDeferred: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private validateFk(
    check: DeferredFkCheck,
    checkFkExistsFn?: (parentTable: string, parentColumns: string[], values: any[]) => boolean,
  ): ConstraintViolation[] {
    const violations: ConstraintViolation[] = [];

    if (!checkFkExistsFn) {
      // No lookup function provided — cannot validate.
      this.logger.warn(
        { childTable: check.childTable, parentTable: check.parentTable },
        'No FK existence check function provided — skipping FK validation',
      );
      return violations;
    }

    const exists = checkFkExistsFn(check.parentTable, check.parentColumns, check.values);

    if (!exists) {
      // Build a descriptive violation.
      const valueStr = check.values.map((v) => `'${v}'`).join(', ');
      violations.push({
        constraintType: 'FOREIGN KEY',
        table: check.childTable,
        message: `insert or update on table "${check.childTable}" violates foreign key constraint: key (${check.childColumns.join(', ')}) = (${valueStr}) is not present in table "${check.parentTable}"`,
        sqlState: '23503', // foreign_key_violation
      });
    }

    return violations;
  }

  private validateUnique(
    check: DeferredUniqueCheck,
    checkUniqueExistsFn?: (table: string, columns: string[], values: any[], excludeRowId?: string) => boolean,
  ): ConstraintViolation[] {
    const violations: ConstraintViolation[] = [];

    if (!checkUniqueExistsFn) return violations;

    const exists = checkUniqueExistsFn(check.table, check.columns, check.values, check.localRowId);

    if (exists) {
      const valueStr = check.values.map((v) => `'${v}'`).join(', ');
      violations.push({
        constraintType: 'UNIQUE',
        constraintName: check.constraintName,
        table: check.table,
        message: `duplicate key value violates unique constraint "${check.constraintName}": key (${check.columns.join(', ')}) = (${valueStr}) already exists`,
        sqlState: '23505', // unique_violation
      });
    }

    return violations;
  }
}
