/**
 * ActiveQueryRegistry — lightweight registry of in-flight queries.
 *
 * Provides `pg_stat_activity` / `pg_stat_get_activity` data when the richer
 * {@link ConnectionManager} is unavailable.  Unlike ConnectionManager, this
 * registry tracks only queries (no session/SSL metadata); it is the fallback
 * source of truth consumed by `PgSystemViews.collectActivityData` (Priority 2)
 * and by the `pg_stat_get_activity` SQL function handler.
 *
 * @module monitoring/ActiveQueryRegistry
 */

import type { ActiveQuery } from './ConnectionManager';

/**
 * Tracks queries that are currently executing.
 *
 * Reads return defensive snapshots; mutation is explicit and keyed by backend
 * pid.
 */
export class ActiveQueryRegistry {
  private readonly queries = new Map<number, ActiveQuery>();

  /** Register a query (overwrites any existing query on the same pid). */
  register(query: ActiveQuery): void {
    this.queries.set(query.pid, { ...query });
  }

  /** Remove a query by pid.  Returns whether a query was removed. */
  unregister(pid: number): boolean {
    return this.queries.delete(pid);
  }

  /** Update the state/sql of a running query.  No-op if the pid is unknown. */
  update(pid: number, patch: Partial<Pick<ActiveQuery, 'state' | 'sql'>>): void {
    const existing = this.queries.get(pid);
    if (!existing) return;
    this.queries.set(pid, { ...existing, ...patch });
  }

  /** All currently active queries (snapshot). */
  getActiveQueries(): ActiveQuery[] {
    return this.list();
  }

  /** All currently active queries (snapshot). */
  list(): ActiveQuery[] {
    return Array.from(this.queries.values()).map((q) => ({ ...q }));
  }

  /** Number of currently active queries. */
  get size(): number {
    return this.queries.size;
  }
}
