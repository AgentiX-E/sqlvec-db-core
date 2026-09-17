/**
 * ColumnGrantChecker — column-level privilege enforcement.
 *
 * PostgreSQL allows privileges to be granted on individual table columns
 * (e.g. `GRANT SELECT (email, phone) ON users TO support`).  This module keeps
 * an in-memory record of those grants and answers "does user `u` hold privilege
 * `p` on column `c` of table `t`?".
 *
 * Enforcement is *fail-closed*: a column is only accessible when an explicit
 * column-level grant exists for it.  (Table-level grants, which cover every
 * column, are the responsibility of the table-privilege layer and are not in
 * scope here — this checker is only consulted for per-column decisions.)
 *
 * @module security/ColumnGrantChecker
 */

/** The privileges that may be granted on a column. */
export type ColumnPrivilege = 'SELECT' | 'INSERT' | 'UPDATE';

/**
 * In-memory column-grant directory.  Identifiers are matched exactly (the SQL
 * layer already normalizes identifiers where necessary); grants are keyed by
 * `(grantee, table, column)` and hold a set of privileges.
 */
export class ColumnGrantChecker {
  /**
   * Whether the checker is ready to enforce grants.  This is a plain boolean
   * *field* (not a method) — callers read `checker.isReady` directly.
   */
  isReady = true;

  /** grantee (lowercased) → table (lowercased) → column (lowercased) → privileges. */
  private readonly grants = new Map<string, Map<string, Map<string, Set<ColumnPrivilege>>>>();

  /**
   * Record column-level privileges for a grantee.
   *
   * @param grantee   The role receiving the grant.
   * @param tableName The table whose columns are granted.
   * @param privilege The privilege being granted (`SELECT`/`INSERT`/`UPDATE`).
   * @param columns   The columns covered by the grant.
   */
  grantColumnPrivilege(
    grantee: string,
    tableName: string,
    privilege: string,
    columns: string[],
  ): void {
    const priv = normalizePrivilege(privilege);
    if (!priv) return; // Ignore unsupported privilege keywords.

    const validColumns = columns.filter((c) => c.trim().length > 0);
    if (validColumns.length === 0) return; // Nothing to record — do not grow the map.

    const granteeKey = grantee.toLowerCase();
    const tableKey = tableName.toLowerCase();

    let tables = this.grants.get(granteeKey);
    if (!tables) {
      tables = new Map();
      this.grants.set(granteeKey, tables);
    }

    let cols = tables.get(tableKey);
    if (!cols) {
      cols = new Map();
      tables.set(tableKey, cols);
    }

    for (const column of validColumns) {
      const colKey = column.trim().toLowerCase();
      let privileges = cols.get(colKey);
      if (!privileges) {
        privileges = new Set();
        cols.set(colKey, privileges);
      }
      privileges.add(priv);
    }
  }

  /**
   * Whether `user` holds `operation` on the given `tableName.columnName`.
   *
   * @returns `false` unless an explicit grant matches (fail-closed).
   */
  checkColumnPrivilege(
    user: string,
    tableName: string,
    operation: string,
    columnName: string,
  ): boolean {
    const op = normalizePrivilege(operation);
    if (!op) return false;

    const table = this.grants.get(user.toLowerCase())?.get(tableName.toLowerCase());
    const privileges = table?.get(columnName.toLowerCase());
    return privileges?.has(op) ?? false;
  }

  /** Whether any column-level grants have been recorded. */
  hasAnyGrants(): boolean {
    return this.grants.size > 0;
  }
}

/** Normalize a privilege keyword, returning `undefined` for unsupported values. */
function normalizePrivilege(privilege: string): ColumnPrivilege | undefined {
  switch (privilege.toUpperCase()) {
    case 'SELECT':
    case 'INSERT':
    case 'UPDATE':
      return privilege.toUpperCase() as ColumnPrivilege;
    default:
      return undefined;
  }
}
