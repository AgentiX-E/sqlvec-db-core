/**
 * Tests for MVCCShim — PostgreSQL MVCC compatibility shim + SQL rewrite pipeline.
 *
 * Covers both public layers exported from src/query/MVCCShim.ts:
 *   1. The PG-MVCC compatibility shim (`detectMVCC` / `rewriteMVCC` and the
 *      `generatePgStat*Sql` / `setMvccExecutor` helpers).
 *   2. The MVCC SQL rewrite pipeline (`detectMvcc` / `rewriteMvccStatic` /
 *      `rewriteMvccContext` / `rewriteMvccBatch` / `rewriteCreateTable` /
 *      `wrapSelectWithMvcc` / the INSERT/UPDATE/DELETE/VACUUM rewriters and the
 *      `detectMVCCVisible` / `rewriteMVCCVisible` stubs).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  setMvccExecutor,
  generatePgStatDatabaseSql,
  generatePgStatActivitySql,
  detectMVCC,
  rewriteMVCC,
  detectMvcc,
  rewriteMvccStatic,
  rewriteMvccContext,
  rewriteMvccBatch,
  rewriteCreateTable,
  wrapSelectWithMvcc,
  rewriteInsertWithMvcc,
  rewriteUpdateWithMvcc,
  rewriteDeleteWithMvcc,
  rewriteVacuumWithMvcc,
  detectMVCCVisible,
  rewriteMVCCVisible,
  MVCC_COLUMNS,
  SYSTEM_COLUMNS,
  type MvccContext,
} from '../query/MVCCShim';

// Reset the module-level executor reference between tests.
afterEach(() => {
  setMvccExecutor(null);
});

function ctx(overrides: Partial<MvccContext> = {}): MvccContext {
  return {
    currentXid: 100,
    snapshotXmin: 50,
    snapshotXmax: 200,
    xipList: [],
    ...overrides,
  };
}

describe('MVCCShim — constants', () => {
  it('exposes MVCC columns and system columns', () => {
    expect(MVCC_COLUMNS).toEqual(['__xmin', '__xmax', '__ctid']);
    expect(SYSTEM_COLUMNS).toContain('__xmin');
    expect(SYSTEM_COLUMNS).toContain('rowid');
  });
});

describe('generatePgStatDatabaseSql', () => {
  it('returns default-valued mock SQL when no executor is set', () => {
    const sql = generatePgStatDatabaseSql();
    expect(sql).toContain('AS datid');
    expect(sql).toContain('0 AS xact_commit');
    expect(sql).toContain('0 AS numbackends');
  });

  it('uses real global stats when an executor is set', () => {
    setMvccExecutor({
      getGlobalStats: () => ({
        committedCount: 7,
        rolledBackCount: 2,
        deadlockCount: 1,
        conflictCount: 3,
        sessions: 4,
      }),
    });
    const sql = generatePgStatDatabaseSql();
    expect(sql).toContain('7 AS xact_commit');
    expect(sql).toContain('2 AS xact_rollback');
    expect(sql).toContain('1 AS deadlocks');
    expect(sql).toContain('3 AS conflicts');
    expect(sql).toContain('4 AS numbackends');
  });

  it('falls back to defaults when getGlobalStats throws', () => {
    setMvccExecutor({
      getGlobalStats: () => {
        throw new Error('boom');
      },
    });
    const sql = generatePgStatDatabaseSql();
    expect(sql).toContain('0 AS xact_commit');
  });
});

describe('generatePgStatActivitySql', () => {
  it('returns empty mock when no executor is set', () => {
    const sql = generatePgStatActivitySql();
    expect(sql).toContain('WHERE 1=0');
  });

  it('returns empty mock when executor has no active sessions', () => {
    setMvccExecutor({
      getActiveSessions: () => [],
    });
    const sql = generatePgStatActivitySql();
    expect(sql).toContain('WHERE 1=0');
  });

  it('emits one UNION ALL row per active session', () => {
    setMvccExecutor({
      getActiveSessions: () => ['s1', 's2'],
      getSessionStats: (sid: string) => ({
        sessionId: sid,
        xid: sid === 's1' ? 10 : 20,
        isolation: 'read committed',
        readOnly: false,
        started: 123,
        elapsedMs: 5,
        conflictStats: null,
        degradationRecord: null,
        waitingFor: null,
        deadlocked: false,
      }),
    });
    const sql = generatePgStatActivitySql();
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('10010 AS pid'); // 10000 + 10
    expect(sql).toContain('10020 AS pid'); // 10000 + 20
    expect(sql).toContain("'idle' AS state");
  });

  it('emits waiting-for state when a session is waiting', () => {
    setMvccExecutor({
      getActiveSessions: () => ['s1'],
      getSessionStats: () => ({
        sessionId: 's1',
        xid: 1,
        isolation: 'read committed',
        readOnly: false,
        started: 1,
        elapsedMs: 0,
        conflictStats: null,
        degradationRecord: null,
        waitingFor: 's2',
        deadlocked: false,
      }),
    });
    const sql = generatePgStatActivitySql();
    expect(sql).toContain("'active' AS state");
    expect(sql).toContain("'waiting for lock: s2'");
  });

  it('flags deadlocked sessions', () => {
    setMvccExecutor({
      getActiveSessions: () => ['s1'],
      getSessionStats: () => ({
        sessionId: 's1',
        xid: 2,
        isolation: 'read committed',
        readOnly: false,
        started: 1,
        elapsedMs: 0,
        conflictStats: null,
        degradationRecord: null,
        waitingFor: null,
        deadlocked: true,
      }),
    });
    const sql = generatePgStatActivitySql();
    expect(sql).toContain("'idle in transaction (deadlocked)' AS state");
  });

  it('skips sessions with null stats', () => {
    setMvccExecutor({
      getActiveSessions: () => ['s1', 's2'],
      getSessionStats: (sid: string) => (sid === 's1' ? null : null),
    });
    const sql = generatePgStatActivitySql();
    // All sessions skipped → empty mock
    expect(sql).toContain('WHERE 1=0');
  });

  it('falls back to empty when getActiveSessions throws', () => {
    setMvccExecutor({
      getActiveSessions: () => {
        throw new Error('boom');
      },
    });
    const sql = generatePgStatActivitySql();
    expect(sql).toContain('WHERE 1=0');
  });
});

describe('detectMVCC', () => {
  it('detects SET default_transaction_isolation', () => {
    expect(detectMVCC("SET default_transaction_isolation = 'serializable'")).toBe(true);
  });

  it('detects SET vacuum_cost_delay', () => {
    expect(detectMVCC('SET vacuum_cost_delay = 10')).toBe(true);
  });

  it('detects SET autovacuum_*', () => {
    expect(detectMVCC('SET autovacuum_naptime = 60')).toBe(true);
  });

  it('detects CREATE TABLE with storage params', () => {
    expect(detectMVCC('CREATE TABLE t (a int) WITH (fillfactor = 90)')).toBe(true);
    expect(detectMVCC('CREATE TABLE t (a int) WITH (autovacuum_enabled = false)')).toBe(true);
  });

  it('does not detect CREATE TABLE without storage params', () => {
    expect(detectMVCC('CREATE TABLE t (a int)')).toBe(false);
  });

  it('detects pg_current_snapshot()', () => {
    expect(detectMVCC('SELECT pg_current_snapshot()')).toBe(true);
  });

  it('detects pg_snapshot_xmin(pg_current_snapshot())', () => {
    expect(detectMVCC('SELECT pg_snapshot_xmin(pg_current_snapshot())')).toBe(true);
  });

  it('detects pg_stat_all_tables queries', () => {
    expect(detectMVCC('SELECT * FROM pg_stat_all_tables')).toBe(true);
    expect(detectMVCC('SELECT count(*) FROM pg_stat_all_tables')).toBe(true);
  });

  it('detects pg_stat_database queries', () => {
    expect(detectMVCC('SELECT * FROM pg_stat_database')).toBe(true);
  });

  it('detects pg_stat_activity queries', () => {
    expect(detectMVCC('SELECT * FROM pg_stat_activity')).toBe(true);
  });

  it('detects SHOW of MVCC parameters', () => {
    expect(detectMVCC('SHOW default_transaction_isolation')).toBe(true);
    expect(detectMVCC('SHOW autovacuum')).toBe(true);
    expect(detectMVCC('SHOW vacuum_cost_delay')).toBe(true);
    expect(detectMVCC('SHOW transaction_isolation')).toBe(true);
    expect(detectMVCC('SHOW autovacuum_naptime')).toBe(true);
  });

  it('does not detect SHOW of non-MVCC autovacuum-like param', () => {
    expect(detectMVCC('SHOW my_custom_param')).toBe(false);
  });

  it('does not detect non-MVCC SHOW', () => {
    expect(detectMVCC('SHOW search_path')).toBe(false);
  });

  it('does not detect ordinary SQL', () => {
    expect(detectMVCC('SELECT * FROM users WHERE id = 1')).toBe(false);
    expect(detectMVCC('INSERT INTO t VALUES (1)')).toBe(false);
  });
});

describe('rewriteMVCC', () => {
  it('rewrites SET default_transaction_isolation to SELECT 1', () => {
    expect(rewriteMVCC("SET default_transaction_isolation = 'serializable'")).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('rewrites SET vacuum_cost_delay to SELECT 1', () => {
    expect(rewriteMVCC('SET vacuum_cost_delay = 10')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SET autovacuum_* to SELECT 1', () => {
    expect(rewriteMVCC('SET autovacuum_naptime = 60')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('strips storage params from CREATE TABLE', () => {
    const r = rewriteMVCC('CREATE TABLE t (a int) WITH (fillfactor = 90)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('fillfactor');
  });

  it('removes the entire WITH clause when only storage params remain', () => {
    const r = rewriteMVCC('CREATE TABLE t (a int) WITH (fillfactor = 90)');
    expect(r.sql).not.toContain('WITH');
  });

  it('preserves non-storage WITH options', () => {
    const r = rewriteMVCC('CREATE TABLE t (a int) WITH (oids = false)');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toContain('oids');
  });

  it('treats boolean-style WITH option (no =) as non-storage', () => {
    const r = rewriteMVCC('CREATE TABLE t (a int) WITH (OIDS)');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toContain('OIDS');
  });

  it('strips unlisted autovacuum_* params via startsWith', () => {
    const r = rewriteMVCC('CREATE TABLE t (a int) WITH (autovacuum_foo = 1)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('autovacuum_foo');
  });

  it('removes entire WITH clause when all options are storage params', () => {
    const r = rewriteMVCC('CREATE TABLE t (a int) WITH (fillfactor = 90, toast_tuple_target = 128)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('WITH');
  });

  it('preserves quoted commas inside WITH option values', () => {
    const r = rewriteMVCC("CREATE TABLE t (a int) WITH (fillfactor = 90, comment = 'a,b')");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("comment = 'a,b'");
  });

  it('leaves CREATE TABLE unchanged when no storage params', () => {
    const r = rewriteMVCC('CREATE TABLE t (a int)');
    expect(r).toEqual({ sql: 'CREATE TABLE t (a int)', rewritten: false });
  });

  it('rewrites pg_current_snapshot()', () => {
    expect(rewriteMVCC('SELECT pg_current_snapshot()')).toEqual({
      sql: "SELECT '0:0:' AS snapshot",
      rewritten: true,
    });
  });

  it('rewrites pg_snapshot_xmin(pg_current_snapshot())', () => {
    expect(rewriteMVCC('SELECT pg_snapshot_xmin(pg_current_snapshot())')).toEqual({
      sql: 'SELECT 0 AS xmin',
      rewritten: true,
    });
  });

  it('rewrites SELECT * FROM pg_stat_all_tables to mock', () => {
    const r = rewriteMVCC('SELECT * FROM pg_stat_all_tables');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('0 AS relid');
  });

  it('rewrites SELECT count(*) FROM pg_stat_all_tables to 0', () => {
    expect(rewriteMVCC('SELECT count(*) FROM pg_stat_all_tables')).toEqual({
      sql: 'SELECT 0 AS count',
      rewritten: true,
    });
  });

  it('wraps arbitrary pg_stat_all_tables references in a subquery', () => {
    const r = rewriteMVCC('SELECT relname FROM pg_stat_all_tables WHERE relname = \'x\'');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('AS pg_stat_all_tables');
  });

  it('rewrites pg_stat_database to mock', () => {
    const r = rewriteMVCC('SELECT * FROM pg_stat_database');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('AS datid');
  });

  it('rewrites pg_stat_activity to mock', () => {
    const r = rewriteMVCC('SELECT * FROM pg_stat_activity');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('AS pid');
  });

  it('rewrites known SHOW parameters to mock values', () => {
    expect(rewriteMVCC('SHOW default_transaction_isolation')).toEqual({
      sql: "SELECT 'read committed' AS default_transaction_isolation",
      rewritten: true,
    });
    expect(rewriteMVCC('SHOW vacuum_cost_delay')).toEqual({
      sql: "SELECT '0' AS vacuum_cost_delay",
      rewritten: true,
    });
    expect(rewriteMVCC('SHOW autovacuum')).toEqual({
      sql: "SELECT 'on' AS autovacuum",
      rewritten: true,
    });
  });

  it('rewrites SHOW transaction_isolation', () => {
    expect(rewriteMVCC('SHOW transaction_isolation')).toEqual({
      sql: "SELECT 'read committed' AS transaction_isolation",
      rewritten: true,
    });
  });

  it('rewrites qualified SHOW (schema-qualified) params', () => {
    expect(rewriteMVCC('SHOW pg_catalog.default_transaction_isolation')).toEqual({
      sql: "SELECT 'read committed' AS pg_catalog.default_transaction_isolation",
      rewritten: true,
    });
  });

  it('rewrites unknown autovacuum_* SHOW to default 50', () => {
    expect(rewriteMVCC('SHOW autovacuum_unknown_param')).toEqual({
      sql: "SELECT '50' AS autovacuum_unknown_param",
      rewritten: true,
    });
  });

  it('passes through non-MVCC SHOW', () => {
    const r = rewriteMVCC('SHOW search_path');
    expect(r).toEqual({ sql: 'SHOW search_path', rewritten: false });
  });

  it('passes through ordinary SQL', () => {
    const sql = 'SELECT * FROM users WHERE id = 1';
    expect(rewriteMVCC(sql)).toEqual({ sql, rewritten: false });
  });
});

describe('detectMvcc', () => {
  it('detects MVCC-transformable statements', () => {
    expect(detectMvcc('CREATE TABLE t (a int)')).toBe(true);
    expect(detectMvcc('SELECT * FROM t')).toBe(true);
    expect(detectMvcc('INSERT INTO t VALUES (1)')).toBe(true);
    expect(detectMvcc('UPDATE t SET a = 1')).toBe(true);
    expect(detectMvcc('DELETE FROM t')).toBe(true);
    expect(detectMvcc('VACUUM')).toBe(true);
  });

  it('ignores leading whitespace', () => {
    expect(detectMvcc('   SELECT 1')).toBe(true);
  });

  it('does not detect non-MVCC statements', () => {
    expect(detectMvcc('DROP TABLE t')).toBe(false);
    expect(detectMvcc('ALTER TABLE t ADD COLUMN a')).toBe(false);
    expect(detectMvcc('BEGIN')).toBe(false);
  });
});

describe('rewriteCreateTable', () => {
  it('adds MVCC columns and index to a plain CREATE TABLE', () => {
    const out = rewriteCreateTable('CREATE TABLE t (a int)');
    expect(out).toContain('__xmin INTEGER DEFAULT 0');
    expect(out).toContain('__xmax INTEGER DEFAULT 0');
    expect(out).toContain('__ctid INTEGER');
    expect(out).toContain('CREATE INDEX IF NOT EXISTS idx_t__mvcc');
  });

  it('skips system/internal tables', () => {
    const sql = 'CREATE TABLE __foo (a int)';
    expect(rewriteCreateTable(sql)).toBe(sql);
    const sql2 = 'CREATE TABLE pg_catalog.x (a int)';
    expect(rewriteCreateTable(sql2)).toBe(sql2);
  });

  it('skips VIRTUAL TABLE', () => {
    const sql = 'CREATE VIRTUAL TABLE t USING fts5(a)';
    expect(rewriteCreateTable(sql)).toBe(sql);
  });

  it('skips when no closing paren', () => {
    const sql = 'CREATE TABLE t (a int';
    expect(rewriteCreateTable(sql)).toBe(sql);
  });

  it('skips when __xmin already present', () => {
    const sql = 'CREATE TABLE t (a int, __xmin INTEGER)';
    expect(rewriteCreateTable(sql)).toBe(sql);
  });

  it('uses fallback table name when no table name found', () => {
    const out = rewriteCreateTable('CREATE TABLE (a int)');
    expect(out).toContain('idx_t__mvcc');
  });
});

describe('wrapSelectWithMvcc', () => {
  it('returns unchanged for SELECT without FROM', () => {
    const sql = 'SELECT 1';
    expect(wrapSelectWithMvcc(sql, ctx())).toBe(sql);
  });

  it('returns unchanged for system table FROM', () => {
    const sql = 'SELECT * FROM __sys';
    expect(wrapSelectWithMvcc(sql, ctx())).toBe(sql);
  });

  it('returns unchanged when already wrapped', () => {
    const sql = 'SELECT * FROM t WHERE __xmin > 0';
    expect(wrapSelectWithMvcc(sql, ctx())).toBe(sql);
  });

  it('returns unchanged for CREATE TABLE AS SELECT', () => {
    const sql = 'CREATE TABLE t AS SELECT * FROM s';
    expect(wrapSelectWithMvcc(sql, ctx())).toBe(sql);
  });

  it('injects auto-commit filter when currentXid is 0', () => {
    const sql = 'SELECT * FROM t';
    const out = wrapSelectWithMvcc(sql, ctx({ currentXid: 0 }));
    expect(out).toContain('(__xmin > 0 AND __xmax = 0)');
  });

  it('injects snapshot filter inside a transaction', () => {
    const sql = 'SELECT * FROM t';
    const out = wrapSelectWithMvcc(sql, ctx());
    expect(out).toContain('__xmin <= 200');
    expect(out).toContain('__xmax = 100');
  });

  it('injects filter into an existing WHERE clause', () => {
    const sql = 'SELECT * FROM t WHERE a = 1';
    const out = wrapSelectWithMvcc(sql, ctx({ currentXid: 0 }));
    expect(out).toContain('WHERE');
    expect(out).toContain('(__xmin > 0 AND __xmax = 0)');
    expect(out).toContain('a = 1');
  });

  it('injects filter before GROUP BY (no WHERE)', () => {
    const out = wrapSelectWithMvcc('SELECT a FROM t GROUP BY a', ctx({ currentXid: 0 }));
    expect(out).toContain('WHERE (__xmin > 0 AND __xmax = 0)');
    expect(out).toContain('GROUP BY a');
  });

  it('injects filter before ORDER BY (no WHERE)', () => {
    const out = wrapSelectWithMvcc('SELECT a FROM t ORDER BY a', ctx({ currentXid: 0 }));
    expect(out).toContain('WHERE (__xmin > 0 AND __xmax = 0)');
    expect(out).toContain('ORDER BY a');
  });

  it('injects filter into UNION leg', () => {
    const out = wrapSelectWithMvcc('SELECT a FROM t UNION SELECT b FROM u', ctx({ currentXid: 0 }));
    expect(out).toContain('WHERE (__xmin > 0 AND __xmax = 0)');
  });

  it('wraps CTE (WITH) outer SELECT', () => {
    const out = wrapSelectWithMvcc('WITH x AS (SELECT 1) SELECT * FROM t', ctx({ currentXid: 0 }));
    expect(out).toContain('WHERE (__xmin > 0 AND __xmax = 0)');
  });

  it('preserves SQLite ? placeholders through AST injection', () => {
    const out = wrapSelectWithMvcc('SELECT * FROM t WHERE a = ?', ctx({ currentXid: 0 }));
    expect(out).toContain('a = ?');
    expect(out).toContain('(__xmin > 0 AND __xmax = 0)');
  });

  it('falls back to regex when WHERE is incomplete (parse error)', () => {
    const out = wrapSelectWithMvcc('SELECT * FROM t WHERE', ctx({ currentXid: 0 }));
    expect(out).toContain('__xmax = 0');
  });

  it('does not double-close a regex-fallback WHERE ending in )', () => {
    const out = wrapSelectWithMvcc('SELECT * FROM t WHERE a = 1)', ctx({ currentXid: 0 }));
    expect(out).toContain('AND (a = 1)');
    expect(out).not.toContain('a = 1))');
  });
});

describe('rewriteInsertWithMvcc', () => {
  it('skips system tables', () => {
    const sql = 'INSERT INTO __t (a) VALUES (1)';
    expect(rewriteInsertWithMvcc(sql, ctx())).toBe(sql);
  });

  it('skips non-matching INSERT', () => {
    const sql = 'INSERT t (a) VALUES (1)';
    expect(rewriteInsertWithMvcc(sql, ctx())).toBe(sql);
  });

  it('skips when __xmin already present', () => {
    const sql = 'INSERT INTO t (__xmin, a) VALUES (1, 2)';
    expect(rewriteInsertWithMvcc(sql, ctx())).toBe(sql);
  });

  it('prepends MVCC columns for INSERT with explicit column list (VALUES)', () => {
    const sql = 'INSERT INTO t (a, b) VALUES (1, 2)';
    const out = rewriteInsertWithMvcc(sql, ctx());
    expect(out).toContain('__xmin, __xmax, __ctid, a, b');
    expect(out).toContain('(100, 0, NULL, 1, 2)');
  });

  it('prepends MVCC columns for INSERT ... SELECT with explicit columns', () => {
    const sql = 'INSERT INTO t (a, b) SELECT x, y FROM s';
    const out = rewriteInsertWithMvcc(sql, ctx());
    expect(out).toContain('__xmin, __xmax, __ctid, a, b');
    expect(out).toContain('SELECT 100 AS __xmin, 0 AS __xmax, NULL AS __ctid');
  });

  it('adds MVCC columns for INSERT without column list (VALUES)', () => {
    const sql = 'INSERT INTO t VALUES (1, 2)';
    const out = rewriteInsertWithMvcc(sql, ctx());
    expect(out).toContain('(__xmin, __xmax, __ctid)');
    expect(out).toContain('(100, 0, NULL, 1, 2)');
  });

  it('adds MVCC columns for INSERT without column list (SELECT)', () => {
    const sql = 'INSERT INTO t SELECT x FROM s';
    const out = rewriteInsertWithMvcc(sql, ctx());
    expect(out).toContain('(__xmin, __xmax, __ctid)');
    expect(out).toContain('SELECT 100 AS __xmin');
  });

  it('returns unchanged for INSERT ... DEFAULT VALUES without cols', () => {
    const sql = 'INSERT INTO t DEFAULT VALUES';
    expect(rewriteInsertWithMvcc(sql, ctx())).toBe(sql);
  });

  it('handles INSERT with column list and DEFAULT VALUES (no VALUES/SELECT)', () => {
    const sql = 'INSERT INTO t (a) DEFAULT VALUES';
    expect(rewriteInsertWithMvcc(sql, ctx())).toBe(sql);
  });

  it('returns unchanged for INSERT with nested parens in VALUES (no column list)', () => {
    // valuesIdx path: no column list, VALUES present → should process values
    const out = rewriteInsertWithMvcc('INSERT INTO t VALUES (1)', ctx());
    expect(out).toContain('(__xmin, __xmax, __ctid)');
  });

  it('handles empty WITH clause (no options)', () => {
    const r = rewriteMVCC('CREATE TABLE t (a int) WITH ()');
    expect(r.rewritten).toBe(false);
  });
});

describe('rewriteUpdateWithMvcc', () => {
  it('skips system tables', () => {
    const sql = 'UPDATE __t SET a = 1';
    expect(rewriteUpdateWithMvcc(sql, ctx())).toBe(sql);
  });

  it('skips when already has __xmax', () => {
    const sql = 'UPDATE t SET a = 1 WHERE __xmax = 0';
    expect(rewriteUpdateWithMvcc(sql, ctx())).toBe(sql);
  });

  it('appends WHERE when no existing WHERE', () => {
    const sql = 'UPDATE t SET a = 1';
    const out = rewriteUpdateWithMvcc(sql, ctx());
    expect(out).toBe('UPDATE t SET a = 1 WHERE __xmin > 0 AND __xmax = 0');
  });

  it('wraps existing WHERE clause', () => {
    const sql = 'UPDATE t SET a = 1 WHERE b = 2';
    const out = rewriteUpdateWithMvcc(sql, ctx());
    expect(out).toContain('(__xmin > 0 AND __xmax = 0) AND (');
    expect(out).toContain('b = 2');
  });

  it('does not double-close a WHERE clause already ending in )', () => {
    const sql = 'UPDATE t SET a = 1 WHERE (b = 2)';
    const out = rewriteUpdateWithMvcc(sql, ctx());
    expect(out).toContain('(__xmin > 0 AND __xmax = 0) AND ((b = 2)');
    expect(out).not.toContain('(b = 2))');
  });
});

describe('rewriteDeleteWithMvcc', () => {
  it('skips system tables', () => {
    const sql = 'DELETE FROM __t WHERE a = 1';
    expect(rewriteDeleteWithMvcc(sql, ctx())).toBe(sql);
  });

  it('skips non-matching DELETE', () => {
    const sql = 'DELETE t';
    expect(rewriteDeleteWithMvcc(sql, ctx())).toBe(sql);
  });

  it('rewrites DELETE to soft-delete UPDATE with WHERE', () => {
    const sql = 'DELETE FROM t WHERE a = 1';
    const out = rewriteDeleteWithMvcc(sql, ctx());
    expect(out).toContain('UPDATE t SET __xmax = 100');
    expect(out).toContain('__xmin > 0 AND __xmax = 0 AND (a = 1)');
  });

  it('rewrites DELETE without WHERE using 1=1', () => {
    const sql = 'DELETE FROM t';
    const out = rewriteDeleteWithMvcc(sql, ctx());
    expect(out).toContain('(1=1)');
  });
});

describe('rewriteVacuumWithMvcc', () => {
  it('rewrites VACUUM on a table', () => {
    const out = rewriteVacuumWithMvcc('VACUUM t', ctx());
    expect(out).toContain('DELETE FROM t WHERE __xmax != 0 AND __xmax < 99');
  });

  it('rewrites VACUUM FULL with a table', () => {
    const out = rewriteVacuumWithMvcc('VACUUM FULL t', ctx());
    expect(out).toContain('DELETE FROM t');
    expect(out).toContain('; VACUUM');
  });

  it('rewrites VACUUM on all tables to placeholder', () => {
    const out = rewriteVacuumWithMvcc('VACUUM', ctx());
    expect(out).toContain('DELETE FROM sqlite_master WHERE 1=0');
  });
});

describe('rewriteMvccStatic', () => {
  it('rewrites CREATE TABLE', () => {
    const out = rewriteMvccStatic('CREATE TABLE t (a int)');
    expect(out).toContain('__xmin');
  });

  it('passes through non-CREATE-TABLE statements', () => {
    const sql = 'SELECT * FROM t';
    expect(rewriteMvccStatic(sql)).toBe(sql);
  });
});

describe('rewriteMvccContext', () => {
  it('routes INSERT', () => {
    const out = rewriteMvccContext('INSERT INTO t (a) VALUES (1)', ctx());
    expect(out).toContain('__xmin');
  });

  it('routes UPDATE', () => {
    const out = rewriteMvccContext('UPDATE t SET a = 1', ctx());
    expect(out).toContain('__xmin > 0');
  });

  it('routes DELETE', () => {
    const out = rewriteMvccContext('DELETE FROM t WHERE a = 1', ctx());
    expect(out).toContain('__xmax = 100');
  });

  it('routes VACUUM', () => {
    const out = rewriteMvccContext('VACUUM t', ctx());
    expect(out).toContain('DELETE FROM t');
  });

  it('wraps SELECT with FROM', () => {
    const out = rewriteMvccContext('SELECT * FROM t', ctx({ currentXid: 0 }));
    expect(out).toContain('__xmax = 0');
  });

  it('does not wrap SELECT without FROM', () => {
    const sql = 'SELECT 1';
    expect(rewriteMvccContext(sql, ctx())).toBe(sql);
  });

  it('passes through non-MVCC statements', () => {
    const sql = 'DROP TABLE t';
    expect(rewriteMvccContext(sql, ctx())).toBe(sql);
  });
});

describe('rewriteMvccBatch', () => {
  it('splits and rewrites multiple statements with context', () => {
    const out = rewriteMvccBatch(
      'CREATE TABLE t (a int); SELECT * FROM t; DELETE FROM t WHERE a = 1',
      ctx(),
    );
    expect(out).toContain('__xmin');
    expect(out).toContain('__xmax = 100');
  });

  it('rewrites with static-only when ctx is null', () => {
    const out = rewriteMvccBatch('CREATE TABLE t (a int); SELECT * FROM t', null);
    expect(out).toContain('__xmin');
    // SELECT is left alone without context (no visibility wrap)
    expect(out).not.toContain('__xmax = 0');
  });

  it('skips empty statements', () => {
    const out = rewriteMvccBatch(';;;', null);
    expect(out).toBe('');
  });
});

describe('detectMVCCVisible / rewriteMVCCVisible (stubs)', () => {
  it('detectMVCCVisible always returns false', () => {
    expect(detectMVCCVisible('SELECT * FROM t')).toBe(false);
    expect(detectMVCCVisible('')).toBe(false);
  });

  it('rewriteMVCCVisible returns input unchanged', () => {
    const sql = 'SELECT * FROM t';
    expect(rewriteMVCCVisible(sql, {}, 1, 'read committed')).toEqual({
      rewritten: false,
      sql,
    });
  });
});
