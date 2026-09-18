/**
 * ConnectionManager — runtime registry of client sessions and active queries.
 *
 * Backs the `pg_stat_activity` / `pg_stat_ssl` system views by tracking the
 * sessions that are currently attached to the server and the queries each one
 * is running.  The data is process-local (there is no cross-node coordinator
 * requirement for single-node observability) and is exposed via defensive
 * snapshots so callers cannot mutate registry state.
 *
 * Field semantics mirror PostgreSQL:
 *   - `queryStart` / `backendStart` are epoch milliseconds (`Date.now()`).
 *   - `clientAddr` is `null` for local (Unix-socket) connections.
 *
 * @module monitoring/ConnectionManager
 */

/** A single active query, as surfaced by `pg_stat_activity`. */
export interface ActiveQuery {
  /** Backend PID (session identifier). */
  pid: number;
  /** Owning role id/number (mapped to `usesysid`). */
  userId: string;
  /** Client address (`null` for local connections, else IP or `'unknown'`). */
  clientAddr: string | null;
  /** Epoch milliseconds when the query began. */
  queryStart: number;
  /** Session state: `active`, `idle`, or `idle in transaction`. */
  state: string;
  /** The SQL text being executed. */
  sql: string;
  /** Database name the session is connected to. */
  database: string;
  /** Owning role name (mapped to `usename`). */
  userName: string;
  /**
   * Epoch milliseconds when the backend process started.  Optional because a
   * lightweight registry (e.g. an external `pg_stat_activity` source) may only
   * know the query start time; consumers fall back to `queryStart`.
   */
  backendStart?: number;
}

/** Connection-level metadata used by `pg_stat_ssl`. */
export interface SessionInfo {
  /** Session identifier. */
  sessionId: string;
  /** Whether the session uses SSL. */
  ssl: boolean;
  /** SSL protocol version, if any. */
  sslVersion: string | null;
  /** Client certificate DN, if client certificates are in use. */
  clientDn: string | null;
}

/**
 * Tracks active sessions and the queries running on them.
 *
 * Instances are cheap and safe to share: every read returns a snapshot, and
 * all mutation goes through explicit methods keyed by session/pid.
 */
export class ConnectionManager {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly queries = new Map<number, ActiveQuery>();

  /** Register a session.  Replaces any existing session with the same id. */
  registerSession(info: SessionInfo): void {
    this.sessions.set(info.sessionId, info);
  }

  /** Remove a session by id.  Returns whether a session was removed. */
  unregisterSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Look up a session, or `undefined` if unknown. */
  getSession(sessionId: string): SessionInfo | undefined {
    const info = this.sessions.get(sessionId);
    return info ? { ...info } : undefined;
  }

  /** Begin tracking a query on a backend.  Overwrites any prior query on pid. */
  beginQuery(query: ActiveQuery): void {
    this.queries.set(query.pid, { ...query });
  }

  /** Update the state/sql of a running query.  No-op if the pid is unknown. */
  updateQuery(pid: number, patch: Partial<Pick<ActiveQuery, 'state' | 'sql'>>): void {
    const existing = this.queries.get(pid);
    if (!existing) return;
    this.queries.set(pid, { ...existing, ...patch });
  }

  /** Stop tracking a query on a backend.  Returns whether a query was removed. */
  endQuery(pid: number): boolean {
    return this.queries.delete(pid);
  }

  /** All currently active queries (snapshot). */
  getActiveQueries(): ActiveQuery[] {
    return Array.from(this.queries.values()).map((q) => ({ ...q }));
  }

  /** All registered session ids (snapshot). */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** All sessions (snapshot), for `pg_stat_ssl`. */
  getSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s }));
  }
}
