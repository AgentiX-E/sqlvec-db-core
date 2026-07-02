/**
 * PrepareExecuteShim — PREPARE / EXECUTE / DEALLOCATE SQL parsing extension
 *
 * PostgreSQL's PREPARE/EXECUTE/DEALLOCATE are not supported by pgsql-ast-parser.
 * This shim handles them at the parsing layer by converting them into equivalent
 * SQLite-friendly operations.
 *
 * Architecture:
 * - PREPARE stmt: store the SQL text in a prepared statement registry, then
 *   parse the inner SQL for execution
 * - EXECUTE stmt: look up the stored SQL, return it for execution
 * - DEALLOCATE stmt: remove from registry
 *
 * Parsing strategy:
 * - Regex-based extraction (pgsql-ast-parser doesn't cover these statements)
 * - Result: parsed statement object compatible with existing parseStatement() output
 */

import { PinoLogger } from './monitoring/PinoLogger';

const logger = PinoLogger.forComponent('PrepareExecuteShim');

// ── Types ──

export interface PreparedStatement {
  name: string;
  sql: string;
  paramTypes: string[];
  createdAt: number;
}

export interface ParsedPrepExec {
  type: 'PREPARE' | 'EXECUTE' | 'DEALLOCATE' | 'CURSOR';
  name: string;
  innerSql?: string;
  paramTypes?: string[];
  params?: any[];
}

// ── Registry ──

const PREPARE_PATTERN = /^\s*PREPARE\s+(\w+)\s*(?:\(([^)]*)\))?\s*AS\s+(.+)/i;
const EXECUTE_PATTERN = /^\s*EXECUTE\s+(\w+)\s*(?:\(([^)]*)\))?/i;
const DEALLOCATE_PATTERN = /^\s*DEALLOCATE\s+(?:PREPARE\s+)?(\w+)\s*;?\s*$/i;
const CURSOR_PATTERN = /^\s*(DECLARE|FETCH|MOVE|CLOSE)\s+(\w+)\s+(CURSOR|FROM|IN|NEXT|PRIOR|FIRST|LAST|ABSOLUTE|RELATIVE|FORWARD|BACKWARD|SCROLL|WITHOUT|WITH|HOLD)/is;

/**
 * Attempt to parse a PREPARE/EXECUTE/DEALLOCATE/CURSOR statement.
 * Returns ParsedPrepExec on match, null otherwise.
 */
export function tryParsePrepExec(sql: string): ParsedPrepExec | null {
  // PREPARE
  const prepareMatch = sql.match(PREPARE_PATTERN);
  if (prepareMatch) {
    const name = prepareMatch[1];
    const paramDefs = prepareMatch[2] || '';
    const innerSql = prepareMatch[3].trim().replace(/;\s*$/, '');
    const paramTypes = paramDefs
      .split(',')
      .map(s => s.trim().split(/\s+/).pop() || 'text')
      .filter(Boolean);
    return {
      type: 'PREPARE',
      name,
      innerSql,
      paramTypes,
    };
  }

  // EXECUTE
  const execMatch = sql.match(EXECUTE_PATTERN);
  if (execMatch) {
    const name = execMatch[1];
    const paramStr = execMatch[2] || '';
    const params = paramStr.split(',').map(s => s.trim()).filter(Boolean);
    return {
      type: 'EXECUTE',
      name,
      params,
    };
  }

  // DEALLOCATE
  const deallocMatch = sql.match(DEALLOCATE_PATTERN);
  if (deallocMatch) {
    return {
      type: 'DEALLOCATE',
      name: deallocMatch[1],
    };
  }

  return null;
}

/**
 * Detect if a SQL statement is a PREPARE/EXECUTE/DEALLOCATE that should
 * be routed through this shim instead of the AST parser.
 */
export function isPrepExecStatement(sql: string): boolean {
  return PREPARE_PATTERN.test(sql) ||
         EXECUTE_PATTERN.test(sql) ||
         DEALLOCATE_PATTERN.test(sql);
}
