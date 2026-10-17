/**
 * DMLTriggerManager — DML row-level trigger management.
 *
 * Implements PostgreSQL-compatible DML (INSERT/UPDATE/DELETE/TRUNCATE)
 * trigger semantics:
 *
 * - Timing: BEFORE / AFTER / INSTEAD OF
 * - Event: INSERT / UPDATE / DELETE / TRUNCATE
 * - Granularity: FOR EACH ROW / FOR EACH STATEMENT
 * - WHEN condition filtering (SQL expression evaluated via PGliteEngine)
 * - OLD / NEW row data passing
 * - BEFORE triggers can modify NEW rows or RAISE EXCEPTION to cancel
 * - Alphabetical ordering for multiple same-event triggers
 * - Stack depth limit (MAX_TRIGGER_DEPTH = 64) to prevent infinite recursion
 *
 * ## Integration with QueryRouter
 *
 * The QueryRouter calls:
 * 1. `fireBeforeInsert(table, newRow)` — before INSERT execution
 * 2. `fireAfterInsert(table, newRow)` — after INSERT execution
 * 3. `fireBeforeUpdate(table, oldRow, newRow)` — before UPDATE execution
 * 4. `fireAfterUpdate(table, oldRow, newRow)` — after UPDATE execution
 * 5. `fireBeforeDelete(table, oldRow)` — before DELETE execution
 * 6. `fireAfterDelete(table, oldRow)` — after DELETE execution
 * 7. `fireTruncate(table)` — on TRUNCATE
 *
 * BEFORE triggers may return a modified row or raise an error to abort the operation.
 *
 * @module query/DMLTriggerManager
 */

import { PinoLogger } from '../logger/PinoLogger';
import type { PGliteEngine } from './PGliteEngine';

// ── Constants ────────────────────────────────────────────────────

/** Maximum trigger nesting depth to prevent infinite recursion (PG default: 64). */
export const MAX_TRIGGER_DEPTH = 64;

// ── Types ────────────────────────────────────────────────────────

/** Trigger timing relative to the triggering event. */
export type DMLTriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF';

/** DML event that fires the trigger. */
export type DMLTriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';

/** Trigger granularity. */
export type DMLTriggerLevel = 'ROW' | 'STATEMENT';

/**
 * DML trigger definition matching PostgreSQL CREATE TRIGGER semantics.
 *
 * ```sql
 * CREATE TRIGGER name { BEFORE | AFTER | INSTEAD OF }
 *   { INSERT | UPDATE | DELETE | TRUNCATE }
 *   ON table_name
 *   [ FOR EACH { ROW | STATEMENT } ]
 *   [ WHEN (condition) ]
 *   EXECUTE FUNCTION function_name();
 * ```
 */
export interface DMLTriggerDef {
  /** Unique trigger name (case-sensitive). */
  name: string;
  /** When to fire: BEFORE the operation, AFTER the operation, or INSTEAD OF. */
  timing: DMLTriggerTiming;
  /** DML event that triggers this trigger. */
  event: DMLTriggerEvent;
  /** Row-level or statement-level granularity. */
  level: DMLTriggerLevel;
  /** Table name this trigger is defined on (lowercase for matching). */
  tableName: string;
  /**
   * Optional WHEN condition: a SQL boolean expression referencing
   * OLD and/or NEW column values. Evaluated via PGliteEngine.
   *
   * Example: `(OLD.balance IS DISTINCT FROM NEW.balance)`
   */
  whenCondition?: string;
  /**
   * Trigger function callback.
   *
   * For BEFORE ROW triggers: return a DMLTriggerResult to modify the row,
   * skip the operation, or raise an error.
   *
   * For AFTER triggers: return value is informational.
   *
   * For INSTEAD OF triggers: the callback performs the actual operation.
   */
  callback: (ctx: DMLTriggerContext) => Promise<DMLTriggerResult>;
  /** Whether this trigger is enabled. */
  enabled: boolean;
}

/**
 * Context passed to the trigger callback function.
 */
export interface DMLTriggerContext {
  /** The existing row data (null for INSERT operations). */
  oldRow?: Record<string, any>;
  /** The new row data (null for DELETE operations). */
  newRow?: Record<string, any>;
  /** Table name (lowercase). */
  tableName: string;
  /** Operation name: 'INSERT', 'UPDATE', 'DELETE', or 'TRUNCATE'. */
  operation: string;
  /** Trigger name that fired. */
  triggerName: string;
}

/**
 * Result returned by a trigger callback.
 *
 * - `row`: Modified row (for BEFORE INSERT/UPDATE, the callback may alter values).
 * - `skip`: Set to true to cancel the operation (BEFORE triggers only).
 * - `error`: Error message to raise, aborting the transaction.
 */
export interface DMLTriggerResult {
  /** Modified row for BEFORE INSERT/UPDATE triggers. */
  row?: Record<string, any>;
  /** Set to true to skip/cancel the operation (BEFORE triggers only). */
  skip?: boolean;
  /** Error message to raise, aborting the transaction. */
  error?: string;
}

// ── DMLTriggerManager ────────────────────────────────────────────

export class DMLTriggerManager {
  private readonly logger = PinoLogger.forComponent('dmltriggermanager');

  /** Registered triggers, keyed by trigger name. */
  private triggers: Map<string, DMLTriggerDef> = new Map();

  /**
   * Optional PGliteEngine instance for evaluating WHEN conditions.
   * If not set, WHEN conditions are assumed true (all triggers fire).
   */
  private pgliteEngine?: PGliteEngine;

  /**
   * Current trigger call stack depth (for recursion prevention).
   * Reset before each top-level DML operation.
   */
  private callDepth: number = 0;

  /**
   * Create a new DML trigger.
   *
   * @param def - The trigger definition.
   * @throws Error if a trigger with the same name already exists.
   */
  createTrigger(def: DMLTriggerDef): void {
    const normalizedName = def.name.toLowerCase();

    if (this.triggers.has(normalizedName)) {
      throw new Error(
        `DML trigger "${def.name}" already exists on table "${def.tableName}"`,
      );
    }

    this.triggers.set(normalizedName, {
      ...def,
      name: def.name,
      tableName: def.tableName.toLowerCase(),
      enabled: def.enabled !== false,
    });

    this.logger.info(
      { name: def.name, event: def.event, timing: def.timing, table: def.tableName, level: def.level },
      'DML trigger created',
    );
  }

  /**
   * Drop a DML trigger by name.
   *
   * @param name - The trigger name to drop.
   * @returns true if the trigger was found and removed.
   */
  dropTrigger(name: string): boolean {
    const normalizedName = name.toLowerCase();
    const removed = this.triggers.delete(normalizedName);
    if (removed) {
      this.logger.info({ name }, 'DML trigger dropped');
    }
    return removed;
  }

  /**
   * Set the PGliteEngine instance for WHEN condition evaluation.
   * When set, WHEN conditions are evaluated as SQL expressions
   * with OLD/NEW columns substituted via a SELECT statement.
   *
   * @param engine - The PGliteEngine instance.
   */
  setPGliteEngine(engine: PGliteEngine): void {
    this.pgliteEngine = engine;
  }

  /**
   * Get all registered DML triggers.
   */
  getAllTriggers(): DMLTriggerDef[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Get triggers for a specific table, event, and timing, sorted alphabetically
   * by name (PostgreSQL behavior: same-event triggers fire in alphabetical order).
   */
  private getTriggersFor(
    tableName: string,
    event: DMLTriggerEvent,
    timing: DMLTriggerTiming,
    level: DMLTriggerLevel,
  ): DMLTriggerDef[] {
    const normalizedTable = tableName.toLowerCase();
    const triggers = Array.from(this.triggers.values()).filter(
      (t) =>
        t.enabled &&
        t.tableName === normalizedTable &&
        t.event === event &&
        t.timing === timing &&
        t.level === level,
    );
    // Sort alphabetically by name (PG behavior)
    triggers.sort((a, b) => a.name.localeCompare(b.name));
    return triggers;
  }

  /**
   * Evaluate a WHEN condition for a given OLD/NEW row context.
   *
   * This creates an ephemeral SQL expression that references OLD/NEW columns
   * and evaluates it using the PGliteEngine.
   *
   * Example: `(OLD.balance IS DISTINCT FROM NEW.balance)`
   *
   * Strategy: substitute OLD/NEW column values into a SELECT with
   * the WHEN condition expression, then execute it.
   *
   * If PGliteEngine is unavailable, returns true (fire always).
   *
   * @param condition - The SQL WHEN condition expression.
   * @param oldRow - The OLD row data (or null if INSERT).
   * @param newRow - The NEW row data (or null if DELETE).
   * @returns true if the condition evaluates to true, false otherwise.
   */
  private async evaluateWhenCondition(
    condition: string,
    oldRow?: Record<string, any>,
    newRow?: Record<string, any>,
  ): Promise<boolean> {
    if (!this.pgliteEngine) {
      // Without PGlite, we do a simple heuristic: substitute OLD/NEW values
      return this.evaluateWhenConditionHeuristic(condition, oldRow, newRow);
    }

    try {
      // Build a SELECT that evaluates the condition with OLD/NEW as inline values
      // We create a single-row CTE for OLD and NEW, then evaluate the condition
      const allCols = new Set<string>();
      if (oldRow) Object.keys(oldRow).forEach((k) => allCols.add(k));
      if (newRow) Object.keys(newRow).forEach((k) => allCols.add(k));

      if (allCols.size === 0) return true;

      // Build OLD and NEW inline values
      const oldColDefs: string[] = [];
      const newColDefs: string[] = [];
      const oldVals: any[] = [];
      const newVals: any[] = [];

      for (const col of allCols) {
        oldColDefs.push(`"${col}"`);
        newColDefs.push(`"${col}"`);
        if (oldRow && col in oldRow) {
          oldVals.push(oldRow[col]);
        } else {
          oldVals.push(null);
        }
        if (newRow && col in newRow) {
          newVals.push(newRow[col]);
        } else {
          newVals.push(null);
        }
      }

      // Build a SELECT that projects OLD and NEW as rows, then evaluate condition
      // Using: SELECT * FROM (VALUES(...)) AS OLD(cols), (VALUES(...)) AS NEW(cols)
      const oldValStr = oldVals
        .map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`))
        .join(', ');
      const newValStr = newVals
        .map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`))
        .join(', ');

      const sql = `SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END AS result FROM (VALUES (${oldValStr})) AS OLD(${oldColDefs.join(', ')}), (VALUES (${newValStr})) AS NEW(${newColDefs.join(', ')})`;
      const result = await this.pgliteEngine.evaluate(sql);
      if (result && result.rows && result.rows.length > 0) {
        const val = result.rows[0]?.result ?? result.rows[0]?.result ?? 1;
        return val === 1 || val === true || val === '1';
      }
      return true;
    } catch (err: any) {
      this.logger.warn(
        { condition, err: err.message },
        'WHEN condition evaluation failed — assuming false',
      );
      return false;
    }
  }

  /**
   * Fallback WHEN condition evaluation without PGliteEngine.
   * Performs simple OLD/NEW value comparisons and NEW.x op literal expressions.
   */
  private evaluateWhenConditionHeuristic(
    condition: string,
    oldRow?: Record<string, any>,
    newRow?: Record<string, any>,
  ): boolean {
    try {
      // Helper to get a value by column name from either row
      const resolve = (colExpr: string): any | undefined => {
        const oldMatch = colExpr.match(/^OLD\.(\w+)$/i);
        if (oldMatch) return oldRow?.[oldMatch[1].toLowerCase()];
        const newMatch = colExpr.match(/^NEW\.(\w+)$/i);
        if (newMatch) return newRow?.[newMatch[1].toLowerCase()];
        // Try direct column name (no prefix)
        if (oldRow && colExpr.toLowerCase() in oldRow) return oldRow[colExpr.toLowerCase()];
        if (newRow && colExpr.toLowerCase() in newRow) return newRow[colExpr.toLowerCase()];
        return undefined;
      };

      // Parse literal value
      const parseLiteral = (lit: string): any => {
        const n = Number(lit);
        if (!isNaN(n) && lit.trim() !== '') return n;
        if (/^'.*'$/.test(lit.trim())) return lit.trim().slice(1, -1);
        if (/^null$/i.test(lit.trim())) return null;
        return lit.trim();
      };

      // Handle IS DISTINCT FROM
      const distinctMatch = condition.match(/\(?\s*(OLD\.\w+|NEW\.\w+|\w+)\s+IS\s+DISTINCT\s+FROM\s+(OLD\.\w+|NEW\.\w+|\w+)\s*\)?/i);
      if (distinctMatch) {
        return resolve(distinctMatch[1]) !== resolve(distinctMatch[2]);
      }

      // Handle IS NOT DISTINCT FROM
      const notDistinctMatch = condition.match(/\(?\s*(OLD\.\w+|NEW\.\w+|\w+)\s+IS\s+NOT\s+DISTINCT\s+FROM\s+(OLD\.\w+|NEW\.\w+|\w+)\s*\)?/i);
      if (notDistinctMatch) {
        return resolve(notDistinctMatch[1]) === resolve(notDistinctMatch[2]);
      }

      // Handle >, <, >=, <= comparisons: x op y
      const cmpMatch = condition.match(/\(?\s*(OLD\.\w+|NEW\.\w+|\w+)\s*(>=|<=|!=|<>|>|<|=)\s*(OLD\.\w+|NEW\.\w+|\w+|'[^']*'|-?\d+(?:\.\d+)?)\s*\)?/i);
      if (cmpMatch) {
        const left = resolve(cmpMatch[1]);
        const operator = cmpMatch[2];
        const rawRight = cmpMatch[3];
        const right = resolve(rawRight) !== undefined ? resolve(rawRight) : parseLiteral(rawRight);

        switch (operator) {
          case '>': return left > right;
          case '<': return left < right;
          case '>=': return left >= right;
          case '<=': return left <= right;
          case '=': return left === right;
          case '!=':
          case '<>': return left !== right;
        }
      }

      // If we can't parse, assume true
      return true;
    } catch {
      // resolve/parseLiteral are total (optional chaining + Number/string guards),
      // so the heuristic never throws; this is a defensive fallback.
      /* c8 ignore next */
      return true;
    }
  }

  // ── Call depth management ─────────────────────────────────────

  /**
   * Check if the trigger call stack depth would be exceeded.
   *
   * @returns true if depth would exceed MAX_TRIGGER_DEPTH.
   */
  private wouldExceedDepth(): boolean {
    return this.callDepth >= MAX_TRIGGER_DEPTH;
  }

  /**
   * Reset the call depth counter (called at the start of each
   * top-level DML operation).
   */
  resetCallDepth(): void {
    this.callDepth = 0;
  }

  /**
   * Get the current call depth.
   */
  getCallDepth(): number {
    return this.callDepth;
  }

  // ── Trigger firing methods ─────────────────────────────────────

  /**
   * Fire BEFORE INSERT triggers for the given table and row.
   *
   * If any trigger returns `skip: true`, the operation is cancelled.
   * If any trigger returns an `error`, an exception is thrown.
   * Triggers may modify the new row (returned via `row` in result).
   *
   * @param tableName - The table name.
   * @param newRow - The row to be inserted.
   * @returns The (possibly modified) row, or null if the operation should be skipped.
   * @throws If a trigger raises an error.
   */
  async fireBeforeInsert(
    tableName: string,
    newRow: Record<string, any>,
  ): Promise<Record<string, any> | null> {
    this.callDepth++;
    if (this.wouldExceedDepth()) {
      this.callDepth--;
      throw new Error(
        `trigger stack depth limit exceeded (max ${MAX_TRIGGER_DEPTH})`,
      );
    }

    try {
      const triggers = this.getTriggersFor(tableName, 'INSERT', 'BEFORE', 'ROW');

      let currentRow = { ...newRow };

      for (const trigger of triggers) {
        // Evaluate WHEN condition
        if (trigger.whenCondition) {
          const conditionMet = await this.evaluateWhenCondition(
            trigger.whenCondition,
            undefined, // oldRow is null for INSERT
            currentRow,
          );
          if (!conditionMet) continue;
        }

        const ctx: DMLTriggerContext = {
          oldRow: undefined,
          newRow: currentRow,
          tableName: tableName.toLowerCase(),
          operation: 'INSERT',
          triggerName: trigger.name,
        };

        const result = await trigger.callback(ctx);

        if (result.error) {
          this.logger.info(
            { trigger: trigger.name, error: result.error },
            'BEFORE INSERT trigger raised exception',
          );
          throw new Error(result.error);
        }

        if (result.skip) {
          this.logger.info(
            { trigger: trigger.name },
            'BEFORE INSERT trigger cancelled operation',
          );
          return null;
        }

        if (result.row) {
          currentRow = result.row;
        }
      }

      // STATEMENT-level BEFORE INSERT triggers
      // (WHEN conditions are a ROW-level concept; statement-level triggers,
      // matching every other fire* statement-level path here, ignore WHEN.)
      const statementTriggers = this.getTriggersFor(tableName, 'INSERT', 'BEFORE', 'STATEMENT');
      for (const trigger of statementTriggers) {
        const ctx: DMLTriggerContext = {
          oldRow: undefined,
          newRow: currentRow,
          tableName: tableName.toLowerCase(),
          operation: 'INSERT',
          triggerName: trigger.name,
        };

        const result = await trigger.callback(ctx);
        if (result.error) throw new Error(result.error);
        if (result.skip) return null;
      }

      return currentRow;
    } finally {
      this.callDepth--;
    }
  }

  /**
   * Fire AFTER INSERT triggers for the given table and row.
   *
   * @param tableName - The table name.
   * @param newRow - The inserted row.
   */
  async fireAfterInsert(
    tableName: string,
    newRow: Record<string, any>,
  ): Promise<void> {
    this.callDepth++;
    if (this.wouldExceedDepth()) {
      this.callDepth--;
      throw new Error(
        `trigger stack depth limit exceeded (max ${MAX_TRIGGER_DEPTH})`,
      );
    }

    try {
      const triggers = this.getTriggersFor(tableName, 'INSERT', 'AFTER', 'ROW');

      for (const trigger of triggers) {
        if (trigger.whenCondition) {
          const conditionMet = await this.evaluateWhenCondition(
            trigger.whenCondition,
            undefined,
            newRow,
          );
          if (!conditionMet) continue;
        }

        const ctx: DMLTriggerContext = {
          oldRow: undefined,
          newRow,
          tableName: tableName.toLowerCase(),
          operation: 'INSERT',
          triggerName: trigger.name,
        };

        await trigger.callback(ctx);
      }

      // STATEMENT-level AFTER INSERT triggers
      const statementTriggers = this.getTriggersFor(tableName, 'INSERT', 'AFTER', 'STATEMENT');
      for (const trigger of statementTriggers) {
        const ctx: DMLTriggerContext = {
          oldRow: undefined,
          newRow,
          tableName: tableName.toLowerCase(),
          operation: 'INSERT',
          triggerName: trigger.name,
        };
        await trigger.callback(ctx);
      }
    } finally {
      this.callDepth--;
    }
  }

  /**
   * Fire BEFORE UPDATE triggers for the given table and rows.
   *
   * @param tableName - The table name.
   * @param oldRow - The existing row before the update.
   * @param newRow - The new row values to be applied.
   * @returns The (possibly modified) new row, or null if operation should be skipped.
   * @throws If a trigger raises an error.
   */
  async fireBeforeUpdate(
    tableName: string,
    oldRow: Record<string, any>,
    newRow: Record<string, any>,
  ): Promise<Record<string, any> | null> {
    this.callDepth++;
    if (this.wouldExceedDepth()) {
      this.callDepth--;
      throw new Error(
        `trigger stack depth limit exceeded (max ${MAX_TRIGGER_DEPTH})`,
      );
    }

    try {
      const triggers = this.getTriggersFor(tableName, 'UPDATE', 'BEFORE', 'ROW');

      let currentRow = { ...newRow };

      for (const trigger of triggers) {
        if (trigger.whenCondition) {
          const conditionMet = await this.evaluateWhenCondition(
            trigger.whenCondition,
            oldRow,
            currentRow,
          );
          if (!conditionMet) continue;
        }

        const ctx: DMLTriggerContext = {
          oldRow,
          newRow: currentRow,
          tableName: tableName.toLowerCase(),
          operation: 'UPDATE',
          triggerName: trigger.name,
        };

        const result = await trigger.callback(ctx);

        if (result.error) {
          throw new Error(result.error);
        }

        if (result.skip) {
          return null;
        }

        if (result.row) {
          currentRow = result.row;
        }
      }

      // STATEMENT-level BEFORE UPDATE triggers
      const statementTriggers = this.getTriggersFor(tableName, 'UPDATE', 'BEFORE', 'STATEMENT');
      for (const trigger of statementTriggers) {
        const ctx: DMLTriggerContext = {
          oldRow,
          newRow: currentRow,
          tableName: tableName.toLowerCase(),
          operation: 'UPDATE',
          triggerName: trigger.name,
        };
        const result = await trigger.callback(ctx);
        if (result.error) throw new Error(result.error);
        if (result.skip) return null;
      }

      return currentRow;
    } finally {
      this.callDepth--;
    }
  }

  /**
   * Fire AFTER UPDATE triggers for the given table and rows.
   *
   * @param tableName - The table name.
   * @param oldRow - The row before the update.
   * @param newRow - The row after the update.
   */
  async fireAfterUpdate(
    tableName: string,
    oldRow: Record<string, any>,
    newRow: Record<string, any>,
  ): Promise<void> {
    this.callDepth++;
    if (this.wouldExceedDepth()) {
      this.callDepth--;
      throw new Error(
        `trigger stack depth limit exceeded (max ${MAX_TRIGGER_DEPTH})`,
      );
    }

    try {
      const triggers = this.getTriggersFor(tableName, 'UPDATE', 'AFTER', 'ROW');

      for (const trigger of triggers) {
        if (trigger.whenCondition) {
          const conditionMet = await this.evaluateWhenCondition(
            trigger.whenCondition,
            oldRow,
            newRow,
          );
          if (!conditionMet) continue;
        }

        const ctx: DMLTriggerContext = {
          oldRow,
          newRow,
          tableName: tableName.toLowerCase(),
          operation: 'UPDATE',
          triggerName: trigger.name,
        };

        await trigger.callback(ctx);
      }

      // STATEMENT-level AFTER UPDATE triggers
      const statementTriggers = this.getTriggersFor(tableName, 'UPDATE', 'AFTER', 'STATEMENT');
      for (const trigger of statementTriggers) {
        const ctx: DMLTriggerContext = {
          oldRow,
          newRow,
          tableName: tableName.toLowerCase(),
          operation: 'UPDATE',
          triggerName: trigger.name,
        };
        await trigger.callback(ctx);
      }
    } finally {
      this.callDepth--;
    }
  }

  /**
   * Fire BEFORE DELETE triggers for the given table and row.
   *
   * @param tableName - The table name.
   * @param oldRow - The row to be deleted.
   * @returns true if the operation should proceed, false if cancelled.
   * @throws If a trigger raises an error.
   */
  async fireBeforeDelete(
    tableName: string,
    oldRow: Record<string, any>,
  ): Promise<boolean> {
    this.callDepth++;
    if (this.wouldExceedDepth()) {
      this.callDepth--;
      throw new Error(
        `trigger stack depth limit exceeded (max ${MAX_TRIGGER_DEPTH})`,
      );
    }

    try {
      const triggers = this.getTriggersFor(tableName, 'DELETE', 'BEFORE', 'ROW');

      for (const trigger of triggers) {
        if (trigger.whenCondition) {
          const conditionMet = await this.evaluateWhenCondition(
            trigger.whenCondition,
            oldRow,
            undefined,
          );
          if (!conditionMet) continue;
        }

        const ctx: DMLTriggerContext = {
          oldRow,
          newRow: undefined,
          tableName: tableName.toLowerCase(),
          operation: 'DELETE',
          triggerName: trigger.name,
        };

        const result = await trigger.callback(ctx);

        if (result.error) {
          throw new Error(result.error);
        }

        if (result.skip) {
          return false;
        }
      }

      // STATEMENT-level BEFORE DELETE triggers
      const statementTriggers = this.getTriggersFor(tableName, 'DELETE', 'BEFORE', 'STATEMENT');
      for (const trigger of statementTriggers) {
        const ctx: DMLTriggerContext = {
          oldRow,
          newRow: undefined,
          tableName: tableName.toLowerCase(),
          operation: 'DELETE',
          triggerName: trigger.name,
        };
        const result = await trigger.callback(ctx);
        if (result.error) throw new Error(result.error);
        if (result.skip) return false;
      }

      return true;
    } finally {
      this.callDepth--;
    }
  }

  /**
   * Fire AFTER DELETE triggers for the given table and row.
   *
   * @param tableName - The table name.
   * @param oldRow - The deleted row.
   */
  async fireAfterDelete(
    tableName: string,
    oldRow: Record<string, any>,
  ): Promise<void> {
    this.callDepth++;
    if (this.wouldExceedDepth()) {
      this.callDepth--;
      throw new Error(
        `trigger stack depth limit exceeded (max ${MAX_TRIGGER_DEPTH})`,
      );
    }

    try {
      const triggers = this.getTriggersFor(tableName, 'DELETE', 'AFTER', 'ROW');

      for (const trigger of triggers) {
        if (trigger.whenCondition) {
          const conditionMet = await this.evaluateWhenCondition(
            trigger.whenCondition,
            oldRow,
            undefined,
          );
          if (!conditionMet) continue;
        }

        const ctx: DMLTriggerContext = {
          oldRow,
          newRow: undefined,
          tableName: tableName.toLowerCase(),
          operation: 'DELETE',
          triggerName: trigger.name,
        };

        await trigger.callback(ctx);
      }

      // STATEMENT-level AFTER DELETE triggers
      const statementTriggers = this.getTriggersFor(tableName, 'DELETE', 'AFTER', 'STATEMENT');
      for (const trigger of statementTriggers) {
        const ctx: DMLTriggerContext = {
          oldRow,
          newRow: undefined,
          tableName: tableName.toLowerCase(),
          operation: 'DELETE',
          triggerName: trigger.name,
        };
        await trigger.callback(ctx);
      }
    } finally {
      this.callDepth--;
    }
  }

  /**
   * Fire TRUNCATE triggers (statement-level only in PostgreSQL).
   *
   * @param tableName - The table name.
   * @throws If a trigger raises an error.
   */
  async fireTruncate(tableName: string): Promise<void> {
    this.callDepth++;
    if (this.wouldExceedDepth()) {
      this.callDepth--;
      throw new Error(
        `trigger stack depth limit exceeded (max ${MAX_TRIGGER_DEPTH})`,
      );
    }

    try {
      const triggers = Array.from(this.triggers.values()).filter(
        (t) =>
          t.enabled &&
          t.tableName === tableName.toLowerCase() &&
          t.event === 'TRUNCATE',
      );
      triggers.sort((a, b) => a.name.localeCompare(b.name));

      for (const trigger of triggers) {
        const ctx: DMLTriggerContext = {
          oldRow: undefined,
          newRow: undefined,
          tableName: tableName.toLowerCase(),
          operation: 'TRUNCATE',
          triggerName: trigger.name,
        };

        const result = await trigger.callback(ctx);

        if (result.error) {
          throw new Error(result.error);
        }
      }
    } finally {
      this.callDepth--;
    }
  }

  /**
   * Fire INSTEAD OF INSERT trigger.
   * The trigger callback is responsible for performing the actual operation.
   *
   * @param tableName - The view/table name.
   * @param newRow - The row to insert.
   * @returns The trigger result (may contain error to abort).
   */
  async fireInsteadOfInsert(
    tableName: string,
    newRow: Record<string, any>,
  ): Promise<DMLTriggerResult> {
    this.callDepth++;
    if (this.wouldExceedDepth()) {
      this.callDepth--;
      throw new Error(
        `trigger stack depth limit exceeded (max ${MAX_TRIGGER_DEPTH})`,
      );
    }

    try {
      const triggers = this.getTriggersFor(tableName, 'INSERT', 'INSTEAD OF', 'ROW');

      for (const trigger of triggers) {
        const ctx: DMLTriggerContext = {
          oldRow: undefined,
          newRow,
          tableName: tableName.toLowerCase(),
          operation: 'INSERT',
          triggerName: trigger.name,
        };

        return await trigger.callback(ctx);
      }

      // No INSTEAD OF trigger found
      return { skip: true, error: `no INSTEAD OF INSERT trigger found on "${tableName}"` };
    } finally {
      this.callDepth--;
    }
  }

  /**
   * Parse a `CREATE TRIGGER` SQL statement and register the trigger.
   *
   * Note: Since we use JS callbacks rather than SQL function bodies,
   * this parser extracts the metadata and expects the callback to
   * be registered separately via `registerCallback()`.
   *
   * @param sql - CREATE TRIGGER statement.
   * @returns Parsed trigger metadata, or null if parsing fails.
   */
  parseCreateTriggerSQL(sql: string): {
    name: string;
    timing: DMLTriggerTiming;
    event: DMLTriggerEvent;
    level: DMLTriggerLevel;
    tableName: string;
    whenCondition?: string;
  } | null {
    const trimmed = sql.trim();

    // Match: CREATE [OR REPLACE] TRIGGER name { BEFORE | AFTER | INSTEAD OF }
    //        { INSERT | UPDATE | DELETE | TRUNCATE } [OF col1,col2]
    //        ON table_name
    //        [ REFERENCING ... ]
    //        [ FOR EACH { ROW | STATEMENT } ]
    //        [ WHEN (condition) ]
    //        EXECUTE { FUNCTION | PROCEDURE } func_name()
    const mainMatch = trimmed.match(
      /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE|TRUNCATE)(?:\s+OF\s+.+?)?\s+ON\s+(\w+)/i,
    );

    if (!mainMatch) return null;

    const name = mainMatch[1];
    // The alternation `INSTEAD\s+OF` already captures the full "INSTEAD OF"
    // timing value; normalizing whitespace yields the canonical form that the
    // firing methods match against.
    const timing = mainMatch[2].toUpperCase().replace(/\s+/g, ' ') as DMLTriggerTiming;
    const event = mainMatch[3].toUpperCase() as DMLTriggerEvent;
    const tableName = mainMatch[4];

    // Determine level (default is STATEMENT in PG, but we default to ROW for clarity)
    let level: DMLTriggerLevel = 'ROW';
    const levelMatch = trimmed.match(/FOR\s+EACH\s+(ROW|STATEMENT)/i);
    if (levelMatch) {
      level = levelMatch[1].toUpperCase() as DMLTriggerLevel;
    }

    // Extract WHEN condition
    let whenCondition: string | undefined;
    const whenMatch = trimmed.match(/WHEN\s*\((.+?)\)(?:\s*REFERENCING|\s*EXECUTE)/i);
    if (whenMatch) {
      whenCondition = whenMatch[1].trim();
    }

    return { name, timing, event, level, tableName, whenCondition };
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.triggers.clear();
    this.callDepth = 0;
    this.logger.info('DMLTriggerManager state reset');
  }
}
