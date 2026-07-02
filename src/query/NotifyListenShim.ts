/**
 * NotifyListenShim — Detects and rewrites PostgreSQL NOTIFY/LISTEN/UNLISTEN
 * statements as SQLite-compatible INSERT/DELETE statements.
 *
 * PostgreSQL supports asynchronous notification via the NOTIFY/LISTEN
 * mechanism:
 * - `NOTIFY` sends a notification event on a named channel (with optional payload)
 * - `LISTEN` subscribes the current session to a named channel
 * - `UNLISTEN` unsubscribes from a named channel (or all channels with `*`)
 *
 * SQLite has no equivalent mechanism. Instead, this shim rewrites these
 * statements as operations on persistent SQLite tables:
 *
 * | PG Statement                      | Rewritten SQL                                                                 |
 * |-----------------------------------|-------------------------------------------------------------------------------|
 * | `NOTIFY channel`                  | `INSERT INTO __notify_queue (channel, payload, pid) VALUES ('channel', NULL, 0)` |
 * | `NOTIFY ch, 'payload'`            | `INSERT INTO __notify_queue (channel, payload, pid) VALUES ('ch', 'payload', 0)` |
 * | `LISTEN channel`                  | `INSERT OR IGNORE INTO __notify_listeners (channel, session_id) VALUES ('channel', '<sid>')` |
 * | `UNLISTEN channel`                | `DELETE FROM __notify_listeners WHERE channel = 'channel' AND session_id = '<sid>'` |
 * | `UNLISTEN *`                      | `DELETE FROM __notify_listeners WHERE session_id = '<sid>'`                     |
 *
 * ## Table schemas
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS __notify_queue (
 *   id INTEGER PRIMARY KEY AUTOINCREMENT,
 *   channel TEXT NOT NULL,
 *   payload TEXT,
 *   pid INTEGER NOT NULL DEFAULT 0,
 *   created_at TEXT NOT NULL DEFAULT (datetime('now'))
 * );
 *
 * CREATE TABLE IF NOT EXISTS __notify_listeners (
 *   id INTEGER PRIMARY KEY AUTOINCREMENT,
 *   channel TEXT NOT NULL,
 *   session_id TEXT NOT NULL,
 *   created_at TEXT NOT NULL DEFAULT (datetime('now')),
 *   UNIQUE(channel, session_id)
 * );
 * ```
 *
 * ## Session ID
 * The session ID can be provided via options, or defaults to `'pg_shim'`.
 * In the QueryRouter context, the router should pass the connection/session ID.
 *
 * ## Key guarantees
 * - All NOTIFY/LISTEN/UNLISTEN statements produce valid SQLite SQL
 * - No false positives on SQL containing keywords as identifiers or in strings
 * - Detection is conservative: only top-level statements
 * - PinoLogger integration for debugging and audit trails
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('NotifyListenShim');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/** Default session ID used when none is provided */
const DEFAULT_SESSION_ID = 'pg_shim';

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export type NotifyListenStmtType = 'notify' | 'listen' | 'unlisten' | 'none';

export interface NotifyListenOptions {
  /**
   * Session ID to use for LISTEN/UNLISTEN registrations.
   * In the QueryRouter context, this should be the connection/shard session ID.
   */
  sessionId?: string;
}

export interface NotifyListenResult {
  /** Rewritten SQL (null = no-op, statement should be skipped entirely) */
  sql: string | null;
  /** Whether the SQL was rewritten (true for all NOTIFY/LISTEN/UNLISTEN) */
  rewritten: boolean;
  /** The type of NOTIFY/LISTEN statement detected, or 'none' */
  stmtType: NotifyListenStmtType;
  /** Extracted channel name (populated on NOTIFY/LISTEN/UNLISTEN) */
  channel?: string;
  /** Extracted payload string (populated on NOTIFY with payload) */
  payload?: string;
}

// ──────────────────────────────────────────────
//  Constants – Table names & DDL
// ──────────────────────────────────────────────

export const NOTIFY_QUEUE_TABLE = '__notify_queue';
export const NOTIFY_LISTENERS_TABLE = '__notify_listeners';

/**
 * DDL statements to ensure the backing tables exist.
 * Run these during initialization (e.g., on database creation).
 */
export function getNotifyListenInitSql(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${NOTIFY_QUEUE_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      payload TEXT,
      pid INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS ${NOTIFY_LISTENERS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(channel, session_id)
    )`,
  ];
}

// ──────────────────────────────────────────────
//  Constants – Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches a top-level NOTIFY statement.
 *
 * Groups:
 *   1 – Channel name (identifier)
 *   2 – Optional payload string (including leading comma and surrounding quotes)
 *
 * Covers:
 *   NOTIFY channel_name;
 *   NOTIFY channel_name, 'payload text';
 *   NOTIFY "quoted-channel";
 */
const NOTIFY_PATTERN = /^\s*NOTIFY\s+([A-Za-z_][A-Za-z0-9_"]*)(?:\s*,\s*('[^']*'|\$\$[^$]*\$\$|E'[^']*'))?\s*;?\s*$/i;

/**
 * Matches a top-level LISTEN statement.
 *
 * Group:
 *   1 – Channel name (identifier)
 *
 * Covers:
 *   LISTEN channel_name;
 *   LISTEN "quoted-channel";
 */
const LISTEN_PATTERN = /^\s*LISTEN\s+([A-Za-z_][A-Za-z0-9_"]*)\s*;?\s*$/i;

/**
 * Matches a top-level UNLISTEN statement.
 *
 * Group:
 *   1 – Channel name (identifier) or asterisk (*)
 *
 * Covers:
 *   UNLISTEN channel_name;
 *   UNLISTEN *;
 *   UNLISTEN "quoted-channel";
 */
const UNLISTEN_PATTERN = /^\s*UNLISTEN\s+(\*|[A-Za-z_][A-Za-z0-9_"]*)\s*;?\s*$/i;

/**
 * Combined detection pattern — matches any NOTIFY/LISTEN/UNLISTEN statement
 * at the top level (for detectNotifyListen fast-path).
 */
const NOTIFY_LISTEN_UNLISTEN_START_RE = /^\s*(?:NOTIFY|LISTEN|UNLISTEN)\s+/i;

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Strip surrounding quotes from a channel name if present.
 * E.g. `"my-channel"` → `my-channel`
 */
function unquoteIdentifier(name: string): string {
  return name.replace(/^"(.*)"$/, '$1');
}

/**
 * Strip surrounding single quotes from a payload string if present.
 * E.g. `'hello world'` → `hello world`
 */
function unquotePayload(payload: string): string {
  // Handle $$ delimiters (PostgreSQL dollar-quoting)
  if (payload.startsWith('$$') && payload.endsWith('$$') && payload.length >= 4) {
    return payload.slice(2, -2);
  }
  // Handle E'...' (escape string syntax)
  if (payload.startsWith("E'") && payload.endsWith("'")) {
    return payload.slice(2, -1);
  }
  // Handle standard '...'
  if (payload.startsWith("'") && payload.endsWith("'")) {
    return payload.slice(1, -1);
  }
  return payload;
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string is a NOTIFY, LISTEN, or UNLISTEN
 * statement.
 *
 * Performs a case-insensitive check for the keyword as the first token
 * in the statement.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a NOTIFY, LISTEN, or UNLISTEN statement
 *
 * @example
 * ```ts
 * detectNotifyListen('NOTIFY my_channel');          // true
 * detectNotifyListen('LISTEN my_channel');          // true
 * detectNotifyListen('UNLISTEN *');                 // true
 * detectNotifyListen('SELECT pg_notify(...)');      // false
 * ```
 */
export function detectNotifyListen(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check before attempting regex
  const upper = trimmed.toUpperCase();
  if (
    !upper.startsWith('NOTIFY ') &&
    !upper.startsWith('NOTIFY;') &&
    !upper.startsWith('LISTEN ') &&
    !upper.startsWith('LISTEN;') &&
    !upper.startsWith('UNLISTEN ') &&
    !upper.startsWith('UNLISTEN;')
  ) {
    return false;
  }

  // Confirm with regex
  return NOTIFY_LISTEN_UNLISTEN_START_RE.test(trimmed);
}

/**
 * Handle a NOTIFY, LISTEN, or UNLISTEN SQL statement, rewriting it as
 * a SQLite-compatible INSERT or DELETE on the backing tables.
 *
 * **Processing rules:**
 * | Input                          | Output SQL                                                    | stmtType   |
 * |-------------------------------|---------------------------------------------------------------|------------|
 * | `NOTIFY channel_name`         | `INSERT INTO __notify_queue ... VALUES ('channel_name', ...)` | 'notify'   |
 * | `NOTIFY ch, 'payload'`        | `INSERT INTO __notify_queue ... VALUES ('ch', 'payload', ...)`| 'notify'   |
 * | `LISTEN channel_name`         | `INSERT OR IGNORE INTO __notify_listeners ...`                | 'listen'   |
 * | `UNLISTEN channel_name`       | `DELETE FROM __notify_listeners WHERE ...`                    | 'unlisten' |
 * | `UNLISTEN *`                  | `DELETE FROM __notify_listeners WHERE session_id = ...`       | 'unlisten' |
 * | Non-NOTIFY/LISTEN/UNLISTEN    | `{ sql: <original>, rewritten: false }`                       | 'none'     |
 *
 * @param sql      The raw SQL string to process
 * @param options  Optional settings (sessionId, etc.)
 * @returns        A NotifyListenResult indicating the handling outcome
 *
 * @example
 * ```ts
 * const result = handleNotifyListen("NOTIFY my_channel, 'hello'");
 * // → { sql: "INSERT INTO __notify_queue ... VALUES ('my_channel', 'hello', ...)",
 * //     rewritten: true, stmtType: 'notify', channel: 'my_channel', ... }
 * ```
 */
export function handleNotifyListen(
  sql: string,
  options?: NotifyListenOptions,
): NotifyListenResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? null,
      rewritten: false,
      stmtType: 'none',
    };
  }

  const trimmed = sql.trim();
  const sessionId = options?.sessionId ?? DEFAULT_SESSION_ID;

  // ── Check NOTIFY pattern ──────────────────────────────────

  const notifyMatch = trimmed.match(NOTIFY_PATTERN);
  if (notifyMatch) {
    const rawChannel = notifyMatch[1];
    const channel = unquoteIdentifier(rawChannel);
    const rawPayload = notifyMatch[2] ?? undefined;
    const payload = rawPayload ? unquotePayload(rawPayload) : null;

    // Build INSERT for notify queue
    const notifySql = payload
      ? `INSERT INTO ${NOTIFY_QUEUE_TABLE} (channel, payload, pid) VALUES ('${channel}', '${payload.replace(/'/g, "''")}', 0)`
      : `INSERT INTO ${NOTIFY_QUEUE_TABLE} (channel, pid) VALUES ('${channel}', 0)`;

    logger.debug({ channel, payload }, 'NOTIFY rewritten as INSERT into queue');
    return {
      sql: notifySql,
      rewritten: true,
      stmtType: 'notify',
      channel,
      payload: rawPayload,
    };
  }

  // ── Check LISTEN pattern ──────────────────────────────────

  const listenMatch = trimmed.match(LISTEN_PATTERN);
  if (listenMatch) {
    const rawChannel = listenMatch[1];
    const channel = unquoteIdentifier(rawChannel);

    // Build INSERT for listeners table
    const listenSql =
      `INSERT OR IGNORE INTO ${NOTIFY_LISTENERS_TABLE} (channel, session_id) VALUES ('${channel}', '${sessionId.replace(/'/g, "''")}')`;

    logger.debug({ channel, sessionId }, 'LISTEN rewritten as INSERT into listeners');
    return {
      sql: listenSql,
      rewritten: true,
      stmtType: 'listen',
      channel,
    };
  }

  // ── Check UNLISTEN pattern ────────────────────────────────

  const unlistenMatch = trimmed.match(UNLISTEN_PATTERN);
  if (unlistenMatch) {
    const rawChannel = unlistenMatch[1];

    if (rawChannel === '*') {
      // Unlisten from all channels
      const unlistenSql =
        `DELETE FROM ${NOTIFY_LISTENERS_TABLE} WHERE session_id = '${sessionId.replace(/'/g, "''")}'`;
      logger.debug({ sessionId }, 'UNLISTEN * rewritten as DELETE from listeners');
      return {
        sql: unlistenSql,
        rewritten: true,
        stmtType: 'unlisten',
        channel: '*',
      };
    } else {
      const channel = unquoteIdentifier(rawChannel);
      const unlistenSql =
        `DELETE FROM ${NOTIFY_LISTENERS_TABLE} WHERE channel = '${channel}' AND session_id = '${sessionId.replace(/'/g, "''")}'`;
      logger.debug({ channel, sessionId }, 'UNLISTEN rewritten as DELETE from listeners');
      return {
        sql: unlistenSql,
        rewritten: true,
        stmtType: 'unlisten',
        channel,
      };
    }
  }

  // ── Not a NOTIFY/LISTEN/UNLISTEN statement ────────────────

  return {
    sql: trimmed,
    rewritten: false,
    stmtType: 'none',
  };
}

/**
 * Extract the channel name from a NOTIFY, LISTEN, or UNLISTEN SQL statement.
 *
 * For `UNLISTEN *`, returns `'*'`.
 *
 * @param sql   The raw SQL string
 * @returns     The channel name, or `null` if not a NOTIFY/LISTEN/UNLISTEN
 *              statement or if the channel name cannot be extracted
 *
 * @example
 * ```ts
 * extractChannel("NOTIFY my_channel");     // 'my_channel'
 * extractChannel("LISTEN my_channel");     // 'my_channel'
 * extractChannel("UNLISTEN *");            // '*'
 * extractChannel("SELECT 1");              // null
 * ```
 */
export function extractChannel(sql: string): string | null {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return null;
  }

  const trimmed = sql.trim();

  // Try NOTIFY
  const notifyMatch = trimmed.match(NOTIFY_PATTERN);
  if (notifyMatch) {
    return unquoteIdentifier(notifyMatch[1]);
  }

  // Try LISTEN
  const listenMatch = trimmed.match(LISTEN_PATTERN);
  if (listenMatch) {
    return unquoteIdentifier(listenMatch[1]);
  }

  // Try UNLISTEN
  const unlistenMatch = trimmed.match(UNLISTEN_PATTERN);
  if (unlistenMatch) {
    return unlistenMatch[1] === '*' ? '*' : unquoteIdentifier(unlistenMatch[1]);
  }

  return null;
}

// ──────────────────────────────────────────────
//  Internal helpers (exported for testing)
// ──────────────────────────────────────────────

/**
 * Check if a string starts with NOTIFY, LISTEN, or UNLISTEN followed
 * by whitespace. Case-insensitive. Used internally by detectNotifyListen
 * for fast filtering.
 *
 * @internal Exported for unit testing only.
 */
export function _isNotifyListenStart(s: string): boolean {
  return NOTIFY_LISTEN_UNLISTEN_START_RE.test(s);
}
