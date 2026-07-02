/**
 * PgDateFuncShim — PostgreSQL date/time function shim for SQLite
 *
 * Registers PG-compatible date functions as SQLite custom functions
 * via db.function() so they can be used inline in SELECT queries.
 *
 * Functions registered:
 *   - now()       → YYYY-MM-DD HH:MM:SS (equivalent to CURRENT_TIMESTAMP)
 *   - current_date  → YYYY-MM-DD (bare keyword handled by SystemIntegration)
 *
 * Usage:
 *   import { registerDateFunctions } from './PgDateFuncShim';
 *   registerDateFactors(shard.db);
 *
 * Note: `current_date`, `current_time`, `current_timestamp` are handled
 * as bare column references in SystemIntegration.ts, but `now()` requires
 * SQLite custom function registration because it's a function call.
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('PgDateFuncShim');

/**
 * Format a Date to `YYYY-MM-DD HH:MM:SS` (PG timestamp without timezone).
 */
function fmtTimestamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

/**
 * Register PG-compatible date/time functions on a SQLite database.
 *
 * @param db - better-sqlite3 Database instance
 */
export function registerDateFunctions(db: any): void {
  if (typeof db.function !== 'function') {
    logger.warn('No .function() method on database — cannot register date functions');
    return;
  }

  // SQLite's built-in date(), time(), datetime() handle 'now' as a modifier,
  // but PG's now() takes no arguments and returns timestamp — register it.
  // Note: not deterministic=true because now() changes every call.
  db.function('now', {}, () => fmtTimestamp(new Date()));
}
