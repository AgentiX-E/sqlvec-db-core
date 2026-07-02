/**
 * FunctionRegistry — PostgreSQL SQL function registry
 *
 * Centralized registry for looking up and invoking PG-compatible SQL functions.
 * Functions are registered from PgFunctions.ts and can be looked up by name
 * during query execution.
 */

import { buildPgFunctions, type PgFunctionDef, type PgReturnType } from './PgFunctions';

// ──────────────────────────────────────────────
//  Public Interface
// ──────────────────────────────────────────────

export interface PgFunction {
  name: string;
  minArgs: number;
  maxArgs: number;
  returns: PgReturnType;
  fn: (...args: any[]) => any;
}

// ──────────────────────────────────────────────
//  FunctionRegistry
// ──────────────────────────────────────────────

export class FunctionRegistry {
  private functions: Map<string, PgFunctionDef>;

  constructor() {
    this.functions = buildPgFunctions();
  }

  /**
   * Register a custom function (overrides built-in if name matches).
   */
  register(name: string, fn: PgFunction): void {
    this.functions.set(name.toLowerCase(), {
      name: name.toLowerCase(),
      minArgs: fn.minArgs,
      maxArgs: fn.maxArgs,
      returns: fn.returns,
      fn: fn.fn,
    });
  }

  /**
   * Remove a function by name (case-insensitive).
   * No-op if the function doesn't exist.
   */
  remove(name: string): void {
    this.functions.delete(name.toLowerCase());
  }

  /**
   * Find a function by name (case-insensitive).
   * Returns undefined if not found.
   */
  find(name: string): PgFunction | undefined {
    const def = this.functions.get(name.toLowerCase());
    if (!def) return undefined;
    return {
      name: def.name,
      minArgs: def.minArgs,
      maxArgs: def.maxArgs,
      returns: def.returns,
      fn: def.fn,
    };
  }

  /**
   * Get all registered functions as a map.
   */
  getAll(): Map<string, PgFunction> {
    // Return a shallow copy for safety
    const copy = new Map<string, PgFunction>();
    for (const [key, def] of this.functions) {
      copy.set(key, {
        name: def.name,
        minArgs: def.minArgs,
        maxArgs: def.maxArgs,
        returns: def.returns,
        fn: def.fn,
      });
    }
    return copy;
  }

  /**
   * Invoke a function by name with the given arguments.
   * Validates argument count, returns undefined for unknown functions.
   * Returns null if args don't match min/max.
   */
  invoke(name: string, args: any[]): any {
    const fn = this.find(name);
    if (!fn) return undefined;

    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      return null;
    }

    return fn.fn(...args);
  }

  /**
   * Get the count of registered functions.
   */
  get size(): number {
    return this.functions.size;
  }
}
