// @ts-nocheck
/**
 * ScopedConnection — per-connection/session execution context for QueryRouter.
 *
 * Manages connection-scoped state that was previously scattered as private
 * fields in QueryRouter:
 *   - Current user (for column-level privilege enforcement)
 *   - Column grant checker reference
 *   - Connection-level flags and context
 *
 * Each PG Wire connection (or programmatic session) gets its own scope,
 * ensuring that concurrent sessions don't share mutable user state.
 */

import { ColumnGrantChecker } from '../security/ColumnGrantChecker';

export interface ScopedConnectionOptions {
  /** Initial user for column-level privilege enforcement. */
  user?: string;
  /** Column grant checker instance (shared across all scopes). */
  columnGrantChecker?: ColumnGrantChecker | null;
}

export class ScopedConnection {
  /** The current user for privilege enforcement (lowercased). */
  private _user: string;

  /** Column-level grant checker (shared singleton, not per-scope). */
  public columnGrantChecker: ColumnGrantChecker | null;

  constructor(opts: ScopedConnectionOptions = {}) {
    this._user = (opts.user || 'public').toLowerCase();
    this.columnGrantChecker = opts.columnGrantChecker ?? null;
  }

  // ── User identity ───────────────────────────────────────────

  get user(): string {
    return this._user;
  }

  setUser(user: string): void {
    this._user = user.toLowerCase();
  }

  /**
   * Check if a specific user is NOT the default 'public' user.
   * When true, column-level grant enforcement may be active.
   */
  get isPrivilegedUser(): boolean {
    return this._user !== 'public';
  }

  /**
   * Check if column grant enforcement is available and should be applied.
   */
  get hasColumnGrants(): boolean {
    return !!(this.columnGrantChecker && this.columnGrantChecker.isReady() && this._user !== 'public');
  }

  // ── Factory ─────────────────────────────────────────────────

  /**
   * Create a clone of this scope (for spawning sub-sessions).
   * The clone shares the same columnGrantChecker reference.
   */
  clone(): ScopedConnection {
    const copy = new ScopedConnection({ user: this._user, columnGrantChecker: this.columnGrantChecker });
    return copy;
  }
}
