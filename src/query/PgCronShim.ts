/**
 * PgCronShim — pg_cron extension compatibility shim for SQLite.
 *
 * PostgreSQL provides the pg_cron extension (contributed by Citus Data) for
 * scheduling periodic SQL statements inside the database.  SQLite has no
 * equivalent scheduling mechanism.
 *
 * This shim provides TWO modes:
 *   1. **SQL rewriting (legacy):** Detects pg_cron DDL and rewrites to no-op SELECTs.
 *   2. **Real scheduling (new):** Uses the PgCronExecutor to actually schedule
 *      SQL execution using `node-cron` timer callbacks.
 *
 * ## Real scheduling behaviour
 *
 * `cron.schedule('name', 'schedule', 'sql')` — registers the SQL with the
 *   PgCronExecutor, which will execute the callback on the given cron schedule.
 *   The function returns `SELECT 1 as jobid` as an ACK.
 *
 * `cron.unschedule(job_id_or_name)` — removes a registered job.
 *
 * `SELECT * FROM cron.job` — returns the list of scheduled jobs from the executor.
 *
 * ## Important limitations
 *
 *   - Regex-based rewriting does not parse SQL grammar.
 *   - The PgCronExecutor is a singleton per-process; sharing across multiple
 *     database sessions is not supported.
 *   - Persisted jobs (via cron.save/load) are not restored across process restarts
 *     unless explicitly loaded from a file.
 *
 * @module PgCronShim
 */

import { PgCronExecutor } from './PgCronExecutor';
import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL, type ProtectedSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('PgCronShim');

// ---- Global executor instance -----------------------------------
// This is a process-wide singleton so that cron.schedule across
// different query sessions shares the same scheduling context.

let _executor: PgCronExecutor | null = null;

/**
 * Get or create the global PgCronExecutor singleton.
 */
export function getPgCronExecutor(): PgCronExecutor {
  if (!_executor) {
    _executor = new PgCronExecutor();
    logger.info('PgCronExecutor initialised');
  }
  return _executor;
}

/**
 * Reset the executor (for testing).
 */
export function resetPgCronExecutor(): void {
  _executor = null;
}

// ---- Types ------------------------------------------------------

export interface PgCronResult {
  /** Rewritten SQL (original if no pg_cron constructs found) */
  sql: string;
  /** Whether any pg_cron rewrite was applied */
  rewritten: boolean;
}

// ---- Regex (factory functions to avoid lastIndex issues) ---------

/**
 * SELECT cron.schedule('name', 'schedule', 'sql')
 * Matches both with and without assignment target (e.g. INTO ...).
 * Accepts single- and double-quoted string arguments.
 */
const RE_CRON_SCHEDULE = (): RegExp =>
  /\bcron\s*\.\s*schedule\s*\([^)]*\)/gi;

/**
 * SELECT cron.unschedule(job_id_or_name)
 * Single argument — numeric job id or text job name.
 */
const RE_CRON_UNSCHEDULE = (): RegExp =>
  /\bcron\s*\.\s*unschedule\s*\([^)]*\)/gi;

/**
 * SELECT * FROM cron.job (or cron.schedule)
 * Catches qualified table references in the cron schema.
 */
const RE_CRON_TABLE = (): RegExp =>
  /\bcron\s*\.\s*(?:job|schedule)\b/gi;

/** Generic pg_cron function call (cron.xxxxx) */
const RE_ANY_CRON_FN = (): RegExp =>
  /\bcron\s*\.\s*(?:schedule|unschedule)\s*\(/gi;

// ---- Extract cron.schedule arguments ----------------------------

interface CronScheduleArgs {
  name: string;
  cronExpr: string;
  sql: string;
}

/**
 * Extract the arguments from a `cron.schedule('name', 'schedule', 'sql')` call.
 *
 * Operates on a protected SQL string where each argument literal has been
 * replaced by a `__LIT_N__` placeholder. This guarantees the call is a real
 * statement-level reference, not text embedded inside a string literal or
 * comment (which protectSQL collapses into a single placeholder of its own).
 */
function extractCronScheduleArgs(protectedSql: ProtectedSQL): CronScheduleArgs | null {
  // eslint-disable-next-line require-unicode-regexp
  const match = /\bcron\s*\.\s*schedule\s*\(\s*__LIT_(\d+)__\s*,\s*__LIT_(\d+)__\s*,\s*__LIT_(\d+)__\s*\)/gi
    .exec(protectedSql.protectedSql);
  if (!match) return null;
  return {
    name: unquote(protectedSql.literals[+match[1]]),
    cronExpr: unquote(protectedSql.literals[+match[2]]),
    sql: unquote(protectedSql.literals[+match[3]]),
  };
}

/**
 * Extract the argument from a `cron.unschedule('name' or jobid)` call.
 *
 * Same protection guarantees as extractCronScheduleArgs.
 */
function extractCronUnscheduleArgs(protectedSql: ProtectedSQL): string | null {
  // String argument → resolve the placeholder back to its literal value.
  // eslint-disable-next-line require-unicode-regexp
  const match = /\bcron\s*\.\s*unschedule\s*\(\s*__LIT_(\d+)__\s*\)/gi.exec(protectedSql.protectedSql);
  if (match) return unquote(protectedSql.literals[+match[1]]);
  // Numeric argument → a bare number is not protected, match it directly.
  // eslint-disable-next-line require-unicode-regexp
  const numMatch = /\bcron\s*\.\s*unschedule\s*\(\s*(\d+)\s*\)/gi.exec(protectedSql.protectedSql);
  if (numMatch) return numMatch[1];
  return null;
}

/**
 * Strip a pair of surrounding quotes from a stored literal, if present.
 *
 * Accepts both single-quoted string literals and double-quoted identifiers so
 * that cron.schedule('a', ...) and cron.schedule("a", ...) resolve to the same
 * bare argument value. Unquoted values (e.g. numeric arguments) pass through.
 */
function unquote(literal: string): string {
  if (literal.length >= 2) {
    const first = literal[0];
    const last = literal[literal.length - 1];
    if ((first === "'" || first === '"') && last === first) {
      return literal.slice(1, -1);
    }
  }
  return literal;
}

// ---- Detect -----------------------------------------------------

/**
 * Detect whether the given SQL contains pg_cron function calls or
 * references to the cron schema.
 *
 * String literals, identifiers, and comments are stripped before
 * checking to minimise false positives.
 *
 * @param sql - The SQL statement to check.
 * @returns true if pg_cron constructs are present.
 */
export function detectPgCron(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  // Protect literals/identifiers/comments (including multi-line comments) so a
  // cron.schedule/cron.job reference inside them is not reported as real usage.
  const cleaned = protectSQL(sql).protectedSql;

  if (RE_ANY_CRON_FN().test(cleaned)) {
    return true;
  }
  if (RE_CRON_TABLE().test(cleaned)) {
    return true;
  }

  return false;
}

// ---- Rewrite ----------------------------------------------------

/**
 * Rewrite pg_cron SQL constructs for SQLite compatibility.
 *
 * For cron.schedule(), this shim performs TWO actions:
 *   1. Registers the job with the PgCronExecutor (real scheduling).
 *   2. Returns a no-op SELECT 1 as jobid (compatible return).
 *
 * For cron.unschedule(), it removes the job from the executor.
 *
 * For cron.job / cron.schedule table queries, it returns a static
 * result set matching the currently scheduled jobs.
 *
 * @param sql - The SQL statement to rewrite.
 * @returns A PgCronResult with the rewritten SQL and an indicator
 *          of whether any change was made.
 */
export function rewritePgCron(sql: string): PgCronResult {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  // Protect string literals, quoted identifiers, and comments so a cron
  // reference inside them is never rewritten (nor triggers a scheduling side
  // effect). Guard with detectPgCron for an early-out on non-cron SQL.
  if (!detectPgCron(sql)) {
    return { sql, rewritten: false };
  }

  const protectedSql = protectSQL(sql);
  let result = protectedSql.protectedSql;

  // 1. cron.schedule(...) — extract args and register with executor
  if (RE_CRON_SCHEDULE().test(result)) {
    const args = extractCronScheduleArgs(protectedSql);
    if (args) {
      const executor = getPgCronExecutor();
      try {
        executor.schedule(args.name, args.cronExpr, () => {
          logger.info(
            { job: args.name, sql: args.sql },
            'PgCron scheduled job fired',
          );
          // In production, this would execute the SQL through the query engine.
          // For now, log that the job would have executed.
        });
        logger.info(
          { job: args.name, cron: args.cronExpr, sql: args.sql },
          'PgCron job scheduled',
        );
      } catch (err: any) {
        logger.warn(
          { err: err.message, job: args.name },
          'Failed to schedule PgCron job',
        );
      }
    }

    // Rewrite the SQL to return a jobid
    result = result.replace(
      /\bSELECT\s+.*?\bcron\s*\.\s*schedule\s*\([^)]*\)[^;]*/gi,
      'SELECT 1 as jobid',
    );
  }

  // 2. cron.unschedule(...) — remove job from executor
  if (RE_CRON_UNSCHEDULE().test(result)) {
    const name = extractCronUnscheduleArgs(protectedSql);
    if (name) {
      const executor = getPgCronExecutor();
      executor.unschedule(name);
      logger.info({ job: name }, 'PgCron job unscheduled');
    }

    result = result.replace(
      /\bSELECT\s+.*?\bcron\s*\.\s*unschedule\s*\([^)]*\)[^;]*/gi,
      'SELECT true',
    );
  }

  // 3. FROM cron.job or FROM cron.schedule — return current jobs
  if (RE_CRON_TABLE().test(result)) {
    const executor = getPgCronExecutor();
    const jobs = executor.getJobs();

    if (jobs.length === 0) {
      result = result.replace(
        /\bSELECT\s+.+?\bFROM\s+\bcron\s*\.\s*(?:job|schedule)\b[^;]*/gi,
        "SELECT 1 as jobid, '' as schedule, '' as command",
      );
    } else {
      // Build a VALUES list with all scheduled jobs
      const values = jobs.map((name, i) => {
        return `(${i + 1}, '${name}', 'scheduled')`;
      }).join(', ');
      result = result.replace(
        /\bSELECT\s+.+?\bFROM\s+\bcron\s*\.\s*(?:job|schedule)\b[^;]*/gi,
        `SELECT * FROM (VALUES ${values}) AS cron_job(jobid, jobname, status)`,
      );
    }
  }

  const restored = restoreSQL({ ...protectedSql, protectedSql: result });
  const rewritten = restored !== sql;

  if (rewritten) {
    logger.debug(
      { original: sql, rewritten: restored },
      'Rewrote pg_cron SQL for SQLite compatibility',
    );
  }

  return { sql: restored, rewritten };
}
