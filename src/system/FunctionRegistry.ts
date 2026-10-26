/**
 * FunctionRegistry — PostgreSQL SQL function registry
 *
 * Centralized registry for looking up and invoking PG-compatible SQL functions.
 * Functions are registered from PgFunctions.ts and can be looked up by name
 * during query execution.
 */

import { buildPgFunctions, type PgFunctionDef, type PgReturnType } from './PgFunctions';
import { PinoLogger } from '../logger/PinoLogger';
import { pgp_sym_encrypt, pgp_sym_decrypt } from '../query/PgCryptoShim';

const logger = PinoLogger.forComponent('FunctionRegistry');

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

// ──────────────────────────────────────────────
//  SQLite registration helper
// ──────────────────────────────────────────────

/**
 * SQLite built-in scalar function names that must NOT be re-registered.
 *
 * better-sqlite3 throws when a name collides with an existing SQLite builtin,
 * so the pg scalar installer skips these. Several pg functions (abs, length,
 * lower, upper, substr, trim, round, random, replace, sign, hex) already have
 * equivalent SQLite builtins with compatible semantics.
 */
const SQLITE_BUILTIN_FUNCTIONS = new Set<string>([
  'abs', 'changes', 'char', 'coalesce', 'count', 'date', 'datetime', 'glob',
  'group_concat', 'hex', 'ifnull', 'instr', 'julianday', 'last_insert_rowid',
  'length', 'likely', 'load_extension', 'lower', 'ltrim', 'max', 'min',
  'nullif', 'printf', 'quote', 'random', 'randomblob', 'replace', 'round',
  'rtrim', 'sign', 'soundex', 'sqlite_compileoption_get',
  'sqlite_compileoption_used', 'sqlite_offset', 'sqlite_source_id',
  'sqlite_version', 'substr', 'substring', 'sum', 'total', 'trim', 'typeof',
  'unlikely', 'unicode', 'upper', 'zeroblob',
]);

/**
 * Register the pg scalar function registry onto a SQLite database connection.
 *
 * The FunctionRegistry holds 140+ PG-compatible scalar functions (md5, sha256,
 * encode, decode, div, width_bucket, …). Without this step they exist only as
 * JS-side lookups and a bare `SELECT md5('x')` reaches SQLite as
 * `no such function: md5`. SQLite builtins are skipped to avoid re-registration
 * errors, and any residual failure is logged rather than thrown so a single
 * incompatible function cannot bring down initialization.
 *
 * @param db - A better-sqlite3 (or compatible) database handle.
 */
export function registerPgScalarFunctions(db: any): void {
  if (typeof db?.function !== 'function') {
    // Defensive: no SQLite `.function()` binding available.
    return;
  }

  const registry = new FunctionRegistry();
    let registered = 0;
  let skipped = 0;

  for (const [name, fn] of registry.getAll()) {
    if (SQLITE_BUILTIN_FUNCTIONS.has(name)) {
      skipped++;
      continue;
    }
    try {
      // Any function whose accepted arity is not a single fixed value
      // (minArgs !== maxArgs) must be bound variadically. better-sqlite3 would
      // otherwise infer the arity from `fn.length`, which counts only required
      // parameters — so `(a, b, c?) => …` (fn.length 3) rejects the 2-argument
      // PG call `regexp_matches('abc','b')` with "wrong number of arguments".
      // varargs:true hands the call args to us as a single array, so wrap the
      // user fn to spread them back into its positional signature.
      if (fn.minArgs !== fn.maxArgs) {
        db.function(name, { deterministic: true, varargs: true }, (...args: any[]) => fn.fn(...args));
      } else {
        db.function(name, { deterministic: true }, fn.fn);
      }
      registered++;
    } catch {
      // A name collision or binding incompatibility on one function must not
      // abort the rest of the registry.
      skipped++;
    }
  }

  // ── pgcrypto symmetric-encryption wrappers ──────────────────────────────
  // rewritePgCrypto translates `pgp_sym_encrypt(data, key)` into a call to the
  // `_pgp_sym_encrypt_sc` SQL scalar (and `pgp_sym_decrypt` into
  // `_pgp_sym_decrypt_sc`). Those wrappers are implemented in PgCryptoShim but
  // were never bound to the SQLite connection, so the rewritten statement
  // failed with `no such function: _pgp_sym_encrypt_sc`. Bind them here so the
  // pgcrypto encrypt/decrypt path actually works end-to-end.
  for (const [name, fn] of [
    ['_pgp_sym_encrypt_sc', pgp_sym_encrypt],
    ['_pgp_sym_decrypt_sc', pgp_sym_decrypt],
  ] as const) {
    try {
      db.function(name, { deterministic: true }, fn as any);
      registered++;
    } catch {
      skipped++;
    }
  }

  // ── REGEXP functions for PG pattern operators (`~`, `~*`, `!~`, `!~*`,
  //    complex `SIMILAR TO`) ────────────────────────────────────────────────
  // rewritePGPattern translates `expr ~ 'pat'` to `expr REGEXP 'pat'` and
  // `expr ~* 'pat'` to `regexp_isens('pat', expr)`, but SQLite does not ship a
  // REGEXP function. Without these bindings a `~`/`~*` predicate reaches
  // SQLite and fails with `no such function: REGEXP`. SQLite invokes the
  // `REGEXP` operator as `regexp(pattern, value)` (pattern first), and the
  // dedicated `regexp_isens(pattern, value)` handles case-insensitive matches
  // (JS RegExp has no inline `/i` flag for dynamically-built patterns via a
  // bare function name).
  try {
    db.function('regexp', { deterministic: true }, (pattern: any, value: any) => {
      if (pattern == null || value == null) return 0;
      try {
        return new RegExp(String(pattern)).test(String(value)) ? 1 : 0;
      } catch {
        return 0;
      }
    });
    registered++;
  } catch {
    skipped++;
  }
  try {
    db.function('regexp_isens', { deterministic: true }, (pattern: any, value: any) => {
      if (pattern == null || value == null) return 0;
      try {
        return new RegExp(String(pattern), 'i').test(String(value)) ? 1 : 0;
      } catch {
        return 0;
      }
    });
    registered++;
  } catch {
    skipped++;
  }

  logger.info(
    { registered, skipped },
    'Registered pg scalar functions on SQLite connection',
  );
}
