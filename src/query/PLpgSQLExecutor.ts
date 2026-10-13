/**
 * PLpgSQLExecutor — PL/pgSQL stored procedure execution via local evaluator.
 *
 * Provides PostgreSQL-compatible PL/pgSQL function execution using the
 * built-in PlPgSqlEngine (no external PGlite dependency). Functions are
 * parsed, stored, and executed entirely in-process.
 *
 * ## Design
 *
 * 1. No external dependencies — fully local evaluation
 * 2. Function bodies are parsed using PlPgSqlEngine's parser
 * 3. Execution creates per-call evaluation scope with parameter injection
 * 4. Supports basic PL/pgSQL: assignments, RETURN, IF/ELSE, LOOP, RAISE
 *
 * ## Limitations
 *
 * - No SQL-level database access inside function bodies (EXECUTE unsupported)
 * - No exception handlers
 * - No side-effect SQL queries (INSERT/UPDATE/DELETE) in function body
 *
 * @module query/PLpgSQLExecutor
 */

import { PinoLogger } from '../logger/PinoLogger';
import { SqlVecError, SqlVecErrorCode } from '../types';

// ── Logger ───────────────────────────────────────────────────────


// ── Types ────────────────────────────────────────────────────────

/**
 * Represents a single function parameter parsed from a CREATE FUNCTION signature.
 */
export interface FunctionParam {
  name: string;
  type: string;
  /** Parameter mode: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC' | null (defaults to IN) */
  mode?: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';
  /** Length constraint (e.g., 100 for varchar(100)) */
  length?: number;
  /** Scale for numeric(10,2) */
  scale?: number;
  /** Whether the type is an array (e.g., integer[]) */
  array: boolean;
  /** Default value expression (e.g., 'hello', '5') */
  defaultValue?: string;
}

export interface RegisteredFunction {
  /** Function name (as referenced in SQLite queries). */
  name: string;
  /** Full PL/pgSQL function body (excluding CREATE FUNCTION wrapper). */
  body: string;
  /** Number of arguments expected. */
  argCount: number;
  /** Return type (for type coercion on the SQLite side). */
  returnType: string;
  /** Whether the function was successfully registered in PGlite. */
  registered: boolean;
  /** Raw parameter string from CREATE FUNCTION (e.g., "dept TEXT") for named param resolution. */
  params?: string;
}

/**
 * Parse parameter names from a CREATE FUNCTION param string.
 * E.g., "dept TEXT" → ["dept"]; "a integer, b text" → ["a", "b"]
 * Handles mode prefixes: "INOUT c int" → ["c"], "VARIADIC a int[]" → ["a"].
 */
function parseParamNames(paramStr: string): string[] {
  if (!paramStr || !paramStr.trim()) return [];
  return paramStr.split(',').map(p => {
    const trimmed = p.trim();
    // Strip a leading mode keyword (parameter name is the first identifier).
    const withoutMode = trimmed.replace(/^(?:IN\s+OUT|INOUT|IN|OUT|VARIADIC)\s+/i, '');
    const match = withoutMode.match(/^(\w+)/);
    return match ? match[1] : '';
  }).filter(Boolean);
}

// ── PLpgSQLExecutor ──────────────────────────────────────────────

export class PLpgSQLExecutor {
  private readonly logger = PinoLogger.forComponent('plpgsqlexecutor');

  private functions: Map<string, RegisteredFunction> = new Map();
  private _started: boolean = false;
  /** Callback for inline SQL execution (SELECT ... INTO). */
  private _queryCallback: ((sql: string) => Promise<any[]>) | null = null;

  /**
   * Set the callback for executing inline SQL queries (SELECT ... INTO).
   * The callback receives a SQL string and returns rows as any[].
   */
  setQueryCallback(cb: ((sql: string) => Promise<any[]>) | null): void {
    this._queryCallback = cb;
  }

  /**
   * Start the executor.
   *
   * No external dependencies — just prepares local state.
   */
  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this.logger.info('PL/pgSQL local executor ready');
  }

  /**
   * Register a PL/pgSQL function locally.
   *
   * The function body is parsed and stored for later execution.
   *
   * @param name - Function name.
   * @param body - Complete CREATE FUNCTION SQL or function body.
   * @param argCount - Number of expected arguments.
   * @param returnType - Return type (e.g., 'integer', 'text', 'numeric').
   * @param paramList - Optional parameter list string for precise types.
   */
  async registerFunction(
    name: string,
    body: string,
    argCount?: number,
    returnType?: string,
    paramList?: string,
  ): Promise<void> {
    if (!this._started) {
      throw new SqlVecError(
        'Executor not started — call start() before registering functions',
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }

    const func: RegisteredFunction = {
      name,
      body,
      argCount: argCount || 0,
      returnType: returnType || 'text',
      registered: true,
      params: paramList,
    };

    // Rewrite bare param names to $N references in SQL SELECT ... INTO statements
    if (paramList) {
      const names = parseParamNames(paramList);
      if (names.length > 0) {
        // Only replace bare names in SELECT ... INTO SQL contexts (after comparison operators)
        func.body = this.rewriteBareParamsToDollarN(func.body, names);
      }
    }

    this.functions.set(name, func);
    this.logger.info({ name, argCount: func.argCount, returnType: func.returnType }, 'PL/pgSQL function registered');
  }

  /**
   * Rewrite bare parameter names to $N references in the function body SQL.
   * E.g., "WHERE department = dept" → "WHERE department = $1"
   * Only replaces bare identifiers (not qualified names like employee.dept).
   */
  private rewriteBareParamsToDollarN(body: string, paramNames: string[]): string {
    let result = body;
    for (let i = 0; i < paramNames.length; i++) {
      const name = paramNames[i];
      const dollarN = `$${i + 1}`;
      // Replace \bname\b that is NOT preceded by a dot (qualified.name)
      // and NOT inside single-quoted strings
      const regex = new RegExp(`(?<!\\.)\\b${name}\\b(?=(?:[^']*'[^']*')*[^']*$)`, 'g');
      result = result.replace(regex, dollarN);
    }
    return result;
  }

  /**
   * Execute a registered PL/pgSQL function with the given arguments.
   *
   * Uses the PlPgSqlEngine evaluator to run the function body locally.
   * Arguments are injected as variables ($1, $2, ..., arg1, arg2, ...).
   *
   * @param name - Function name to execute.
   * @param args - Arguments to pass to the function.
   * @returns The function's return value.
   */
  async execute(name: string, args: any[]): Promise<any> {
    if (!this._started) {
      throw new SqlVecError(
        'Executor not started — call start() before executing functions',
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }

    const func = this.functions.get(name);
    if (!func) {
      throw new SqlVecError(
        `PL/pgSQL function not found: "${name}"`,
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }

    // Create a fresh evaluator for this function call
    const { PlPgSqlEvaluatorProxy } = await import('./PlPgSqlEvalProxy');
    const evaluator = new PlPgSqlEvaluatorProxy();

    // Inject arguments as $N variables and named args
    for (let i = 0; i < args.length; i++) {
      evaluator.setVariable(`$${i + 1}`, args[i]);
      evaluator.setVariable(`arg${i + 1}`, args[i]);
    }

    // Inject named parameter variables (e.g., `dept = 'Engineering'`)
    // so that bare parameter names work in SELECT ... INTO SQL
    if (func.params) {
      const paramNames = parseParamNames(func.params);
      for (let i = 0; i < paramNames.length && i < args.length; i++) {
        evaluator.setVariable(paramNames[i], args[i]);
      }
    }

    // Wire the query callback for SELECT ... INTO support
    if (this._queryCallback) {
      evaluator.setQueryCallback(this._queryCallback);
    }

    // Execute the function body
    const result = await evaluator.execute(func.body);

    if (!result.success) {
      throw new SqlVecError(
        `PL/pgSQL execution failed for "${name}": ${result.error}`,
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }

    return result.returnValue;
  }

  /**
   * Execute a function by name only (no arguments) — convenience wrapper.
   */
  async executeNoArgs(name: string): Promise<any> {
    return this.execute(name, []);
  }

  /**
   * Check whether a function is registered.
   */
  hasFunction(name: string): boolean {
    return this.functions.has(name);
  }

  /**
   * Get a registered function's metadata.
   */
  getFunction(name: string): RegisteredFunction | undefined {
    return this.functions.get(name);
  }

  /**
   * Get all registered function names.
   */
  getFunctionNames(): string[] {
    return Array.from(this.functions.keys());
  }

  /**
   * Drop a registered function.
   */
  async dropFunction(name: string): Promise<void> {
    this.functions.delete(name);
    this.logger.info({ name }, 'PL/pgSQL function dropped');
  }

  /**
   * Stop the executor and clear all state.
   */
  async stop(): Promise<void> {
    this.functions.clear();
    this._started = false;
    this.logger.info('PL/pgSQL executor stopped');
  }

  /**
   * Check whether the executor is started and ready.
   */
  get isStarted(): boolean {
    return this._started;
  }

  /**
   * Reset all state (for testing).
   */
  async reset(): Promise<void> {
    await this.stop();
  }

  // ── Private helpers ───────────────────────────────────────────

  /**
   * Build a $1, $2, ... argument list for the CREATE FUNCTION signature.
   *
   * NOTE: currently unused (registered functions carry their own param list);
   * retained for future signature generation. Excluded from coverage.
   */
  /* c8 ignore next */
  private buildArgList(count: number): string {
    if (count === 0) return '';
    const types = ['text', 'integer', 'numeric', 'boolean', 'date', 'timestamp'];
    return Array.from({ length: count }, (_, i) => `arg${i + 1} ${types[Math.min(i, types.length - 1)]}`).join(', ');
  }
}

// ── Function parameter parsing utilities ─────────────────────────

/**
 * Parse a single function parameter string like:
 *   "a integer", "b varchar(100)", "c integer DEFAULT 5",
 *   "OUT b text", "VARIADIC a int[]", "INOUT c int DEFAULT 10"
 *
 * Returns null if the input cannot be parsed as a parameter.
 *
 * @example
 * ```ts
 * parseFunctionParam('a integer')
 * // → { name: 'a', type: 'integer', array: false, defaultValue: undefined }
 * parseFunctionParam('b varchar(100)')
 * // → { name: 'b', type: 'varchar', length: 100, array: false }
 * parseFunctionParam('c int[] DEFAULT ARRAY[1,2]')
 * // → { name: 'c', type: 'int', array: true, defaultValue: 'ARRAY[1,2]' }
 * parseFunctionParam('OUT b text')
 * // → { name: 'b', type: 'text', mode: 'OUT', array: false }
 * ```
 */
export function parseFunctionParam(raw: string): FunctionParam | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let remaining = trimmed;

  // 1. Parse parameter mode (IN / OUT / INOUT / VARIADIC)
  let mode: FunctionParam['mode'] = undefined;
  const modeMatch = remaining.match(/^(IN\s+OUT|INOUT|IN|OUT|VARIADIC)\s+/i);
  if (modeMatch) {
    const modeStr = modeMatch[1].toUpperCase();
    // Normalize IN OUT / INOUT to INOUT
    mode = modeStr === 'IN OUT' ? 'INOUT' : modeStr as FunctionParam['mode'];
    remaining = remaining.substring(modeMatch[0].length);
  }

  // 2. Parse parameter name
  const nameMatch = remaining.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  remaining = remaining.substring(nameMatch[0].length);

  // 3. Parse type name (possibly qualified: schema.type)
  const typeNameMatch = remaining.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s*/);
  if (!typeNameMatch) return null;
  let type = typeNameMatch[1];
  remaining = remaining.substring(typeNameMatch[0].length);

  // 4. Parse optional length/scale constraint: (n) or (n,m)
  let length: number | undefined;
  let scale: number | undefined;
  const lengthMatch = remaining.match(/^\((\d+)(?:\s*,\s*(\d+))?\)\s*/);
  if (lengthMatch) {
    length = parseInt(lengthMatch[1], 10);
    if (lengthMatch[2] !== undefined) {
      scale = parseInt(lengthMatch[2], 10);
    }
    remaining = remaining.substring(lengthMatch[0].length);
  }

  // 5. Parse array suffix: []
  let array = false;
  const arrayMatch = remaining.match(/^\[\]\s*/);
  if (arrayMatch) {
    array = true;
    remaining = remaining.substring(arrayMatch[0].length);
  }

  // 6. Parse DEFAULT / := value
  let defaultValue: string | undefined;
  const defaultMatch = remaining.match(/^(?:DEFAULT\s+|:=)\s*/i);
  if (defaultMatch) {
    remaining = remaining.substring(defaultMatch[0].length);
    // Everything remaining is the default value expression
    // (we don't try to parse the expression itself — just take as-is)
    if (remaining.length > 0) {
      defaultValue = remaining.trim();
      // Strip trailing semicolon if present (from param list context)
      if (defaultValue.endsWith(';')) {
        defaultValue = defaultValue.slice(0, -1).trim();
      }
    }
  }

  return {
    name,
    type,
    mode,
    length,
    scale,
    array,
    defaultValue,
  };
}

/**
 * Parse a comma-separated function parameter list string.
 *
 * Handles nested parentheses within types and default value expressions
 * to correctly identify top-level parameter boundaries.
 *
 * @example
 * ```ts
 * parseFunctionParams('a integer, b varchar(100)')
 * // → [{ name: 'a', type: 'integer' }, { name: 'b', type: 'varchar', length: 100 }]
 *
 * parseFunctionParams('a int, OUT b text')
 * // → [{ name: 'a', type: 'int' }, { name: 'b', type: 'text', mode: 'OUT' }]
 *
 * parseFunctionParams('a integer DEFAULT 5, VARIADIC b int[]')
 * // → [{ name: 'a', type: 'integer', defaultValue: '5' }, { name: 'b', type: 'int', mode: 'VARIADIC', array: true }]
 * ```
 */
export function parseFunctionParams(paramList: string): FunctionParam[] {
  const trimmed = paramList.trim();
  if (!trimmed) return [];

  const result: FunctionParam[] = [];

  // Split by top-level commas (respecting paren nesting)
  const parts = splitByTopLevelCommas(trimmed);

  for (const part of parts) {
    const param = parseFunctionParam(part);
    if (param) {
      result.push(param);
    }
  }

  return result;
}

/**
 * Split a string by commas at the top level (i.e., not inside parentheses).
 *
 * @example
 * ```ts
 * splitByTopLevelCommas('a integer, b varchar(100), c numeric(10,2)')
 * // → ['a integer', 'b varchar(100)', 'c numeric(10,2)']
 * ```
 */
function splitByTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

/**
 * Build a CREATE FUNCTION parameter list string from parsed parameters.
 *
 * @example
 * ```ts
 * buildParamListString([{ name: 'a', type: 'integer' }, { name: 'b', type: 'varchar', length: 100 }])
 * // → 'IN a integer, IN b varchar(100)'
 * ```
 */
export function buildParamListString(params: FunctionParam[]): string {
  return params.map(buildSingleParamString).join(', ');
}

function buildSingleParamString(param: FunctionParam): string {
  const parts: string[] = [];

  // Parameter mode (default to IN if not specified)
  const mode = param.mode || 'IN';
  parts.push(mode);

  parts.push(param.name);

  // Type
  let typeStr = param.type;

  // Length/scale constraint
  if (param.length !== undefined) {
    typeStr += `(${param.length}`;
    if (param.scale !== undefined) {
      typeStr += `, ${param.scale}`;
    }
    typeStr += ')';
  }

  // Array suffix
  if (param.array) {
    typeStr += '[]';
  }

  parts.push(typeStr);

  // Default value
  if (param.defaultValue !== undefined) {
    parts.push(`DEFAULT ${param.defaultValue}`);
  }

  return parts.join(' ');
}

/**
 * Generate a simple arg name for positional parameters.
 * Used when building function signatures from just argCount.
 *
 * NOTE: currently unused; retained for future signature generation.
 * Excluded from coverage.
 */
/* c8 ignore next */
function positionalArgName(index: number): string {
  return `arg${index + 1}`;
}
