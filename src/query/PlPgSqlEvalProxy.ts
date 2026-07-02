/**
 * PlPgSqlEvalProxy — wraps the local PlPgSqlEvaluator for per-call use.
 *
 * Each function execution gets its own proxy (fresh variable scope).
 * This avoids importing the full engine into PLpgSQLExecutor directly.
 *
 * @module query/PlPgSqlEvalProxy
 */

import { PlPgSqlEngine, parsePlPgSql } from '../plpgsql/PlPgSqlEngine';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('plpgsql-eval-proxy');

/**
 * Simplified execution result from the local evaluator.
 */
export interface PlPgSqlEvalResult {
  success: boolean;
  error?: string;
  returnValue?: any;
}

/** Callback for executing inline SQL (SELECT ... INTO). */
export type PlPgSqlQueryCallback = (sql: string) => Promise<any[]>;

/**
 * Proxy around the PlPgSqlEngine evaluator for per-function-call execution.
 */
export class PlPgSqlEvaluatorProxy {
  private engine: PlPgSqlEngine;
  private _queryCallback: PlPgSqlQueryCallback | null = null;

  constructor() {
    this.engine = new PlPgSqlEngine();
  }

  /**
   * Set the inline SQL query callback.
   */
  setQueryCallback(cb: PlPgSqlQueryCallback | null): void {
    this._queryCallback = cb;
    this.engine.setQueryCallback(cb);
  }

  /**
   * Set a variable in the engine's scope.
   */
  setVariable(name: string, value: any): void {
    this.engine.setVariable(name, value);
  }

  /**
   * Execute a PL/pgSQL function body.
   * The body should be just the function internals (e.g., "BEGIN RETURN $1 + $2; END;").
   */
  async execute(body: string): Promise<PlPgSqlEvalResult> {
    try {
      await this.engine.start();

      // Parse to validate the body
      try {
        const parsed = this.engine.parse(body);
        if (!parsed || !parsed.block) {
          return { success: false, error: 'Failed to parse function body' };
        }
      } catch (parseErr: any) {
        return { success: false, error: `Parse error: ${parseErr.message}` };
      }

      // Execute
      const result = await this.engine.execute(body);

      if (!result.success) {
        return { success: false, error: result.error || 'Execution failed' };
      }

      // Return the return value
      return {
        success: true,
        returnValue: result.returnValue,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    } finally {
      await this.engine.stop();
    }
  }
}
