/**
 * Unit tests for QueryRouter's module-level SQL classification/detection
 * helpers. These are pure regex matchers and batch-eligibility predicates,
 * so they are exercised exhaustively over boundary inputs (case-insensitivity,
 * leading whitespace, keyword substrings, and non-string inputs) rather than
 * through the heavyweight execute() path.
 */
import { describe, it, expect } from 'vitest';
import {
  generateMsgId,
  detectTransactionBegin,
  detectDDLStatement,
  detectPartitionTarget,
  detectFTSOperator,
  detectSequenceNextval,
  detectAdvisoryLockFunc,
  detectPgCronSchedule,
  detectPgStatBgwriter,
  detectPgStatReplication,
  detectPgBlockingPids,
  detectPgWaitSampling,
  detectPgPrewarm,
  detectBackslashQuoteSet,
  detectForeignTableQuery,
  detectSetConstraints,
  detectEncryptionInsert,
  isBatchableInsert,
} from '../query/QueryRouter';

describe('generateMsgId', () => {
  it('produces a non-empty string', () => {
    expect(generateMsgId()).toBeTruthy();
  });
  it('produces unique values across calls', () => {
    const ids = new Set([generateMsgId(), generateMsgId(), generateMsgId()]);
    expect(ids.size).toBe(3);
  });
});

describe('detectTransactionBegin', () => {
  it.each(['BEGIN', 'begin', '  BEGIN', 'BEGIN TRANSACTION', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'SET TRANSACTION'])(
    'matches %s',
    (sql) => expect(detectTransactionBegin(sql)).toBe(true),
  );
  it.each(['BEGINNING', 'SELECT BEGIN', 'END', 'COMMIT'])('does not match %s', (sql) =>
    expect(detectTransactionBegin(sql)).toBe(false),
  );
  it('matches BEGIN followed by a semicolon/comment', () => {
    expect(detectTransactionBegin('BEGIN;--not a new word')).toBe(true);
  });
});

describe('detectDDLStatement', () => {
  it.each([
    'CREATE TABLE t (id int)',
    'ALTER TABLE t ADD c int',
    'DROP TABLE t',
    'TRUNCATE t',
    'COMMENT ON TABLE t IS \'x\'',
    'GRANT SELECT ON t TO u',
    'REVOKE SELECT ON t FROM u',
    'RENAME TABLE t TO t2',
    'SECURITY LABEL ON TABLE t IS \'x\'',
  ])('matches %s', (sql) => expect(detectDDLStatement(sql)).toBe(true));
  it.each(['SELECT 1', 'INSERT INTO t VALUES (1)', 'UPDATE t SET a=1', 'DELETE FROM t'])(
    'does not match %s',
    (sql) => expect(detectDDLStatement(sql)).toBe(false),
  );
});

describe('detectPartitionTarget', () => {
  it('matches INSERT INTO', () => expect(detectPartitionTarget('INSERT INTO t VALUES (1)')).toBe(true));
  it('matches SELECT ... FROM', () => expect(detectPartitionTarget('SELECT * FROM t')).toBe(true));
  it('does not match SELECT without FROM', () => expect(detectPartitionTarget('SELECT 1')).toBe(false));
});

describe('detectFTSOperator', () => {
  it.each([
    'to_tsvector(\'english\', col)',
    'SELECT to_tsquery(\'foo\')',
    'plainto_tsquery(\'foo bar\')',
    'ts_rank(v, q)',
    "WHERE col @@ to_tsquery('foo')",
  ])('matches %s', (sql) => expect(detectFTSOperator(sql)).toBe(true));
  it('does not match plain select', () => expect(detectFTSOperator('SELECT * FROM t')).toBe(false));
});

describe('detectSequenceNextval', () => {
  it.each(['nextval(\'seq\')', 'currval(\'seq\')', 'setval(\'seq\', 1)'])('matches %s', (sql) =>
    expect(detectSequenceNextval(sql)).toBe(true),
  );
  it('does not match unrelated', () => expect(detectSequenceNextval('SELECT 1')).toBe(false));
});

describe('detectAdvisoryLockFunc', () => {
  it.each(['pg_advisory_lock(1)', 'pg_advisory_unlock(1)', 'pg_try_advisory_lock(1)', 'pg_advisory_xact_lock(1)'])(
    'matches %s',
    (sql) => expect(detectAdvisoryLockFunc(sql)).toBe(true),
  );
  it('does not match unrelated', () => expect(detectAdvisoryLockFunc('SELECT 1')).toBe(false));
});

describe('detectPgCronSchedule', () => {
  it('matches cron.schedule', () => expect(detectPgCronSchedule("cron.schedule('* * * * *', 'x')")).toBe(true));
  it('matches cron.unschedule', () => expect(detectPgCronSchedule('cron.unschedule(1)')).toBe(true));
  it('does not match unrelated', () => expect(detectPgCronSchedule('SELECT 1')).toBe(false));
});

describe('detectPgStatBgwriter / detectPgStatReplication', () => {
  it('matches pg_stat_bgwriter', () => expect(detectPgStatBgwriter('SELECT * FROM pg_stat_bgwriter')).toBe(true));
  it('matches pg_stat_replication', () => expect(detectPgStatReplication('SELECT * FROM pg_stat_replication')).toBe(true));
  it('does not cross-match', () => {
    expect(detectPgStatBgwriter('SELECT * FROM pg_stat_replication')).toBe(false);
    expect(detectPgStatReplication('SELECT * FROM pg_stat_bgwriter')).toBe(false);
  });
});

describe('detectPgBlockingPids / detectPgWaitSampling / detectPgPrewarm', () => {
  it('matches pg_blocking_pids()', () => expect(detectPgBlockingPids('pg_blocking_pids(123)')).toBe(true));
  it('matches pg_wait_sampling', () => expect(detectPgWaitSampling('SELECT * FROM pg_wait_sampling')).toBe(true));
  it('matches pg_prewarm()', () => expect(detectPgPrewarm('pg_prewarm(\'t\')')).toBe(true));
  it('does not cross-match', () => {
    expect(detectPgBlockingPids('SELECT 1')).toBe(false);
    expect(detectPgWaitSampling('SELECT 1')).toBe(false);
    expect(detectPgPrewarm('SELECT 1')).toBe(false);
  });
});

describe('detectBackslashQuoteSet', () => {
  it.each([
    'SET standard_conforming_strings = on',
    'SET standard_conforming_strings=off',
    'SET escape_string_warning = on',
  ])('matches %s', (sql) => expect(detectBackslashQuoteSet(sql)).toBe(true));
  it('does not match other SET', () => expect(detectBackslashQuoteSet('SET search_path = public')).toBe(false));
});

describe('detectForeignTableQuery', () => {
  it('matches FROM ...foreign...', () => expect(detectForeignTableQuery('SELECT * FROM foreign_tbl')).toBe(true));
  it('matches fdw_ prefix', () => expect(detectForeignTableQuery('SELECT * FROM fdw_x')).toBe(true));
  it('does not match unrelated', () => expect(detectForeignTableQuery('SELECT * FROM local_tbl')).toBe(false));
});

describe('detectSetConstraints', () => {
  it('matches SET CONSTRAINTS', () => expect(detectSetConstraints('SET CONSTRAINTS ALL DEFERRED')).toBe(true));
  it('does not match other SET', () => expect(detectSetConstraints('SET search_path = public')).toBe(false));
});

describe('detectEncryptionInsert', () => {
  it('matches INSERT', () => expect(detectEncryptionInsert('INSERT INTO t VALUES (1)')).toBe(true));
  it('does not match SELECT', () => expect(detectEncryptionInsert('SELECT 1')).toBe(false));
});

describe('isBatchableInsert', () => {
  it('returns true for a plain INSERT', () => expect(isBatchableInsert('INSERT INTO t (a) VALUES (1)')).toBe(true));
  it.each([
    ['undefined-ish empty string', ''],
    ['non-string number', 42 as any],
    ['null', null as any],
    ['undefined', undefined as any],
    ['RETURNING clause', 'INSERT INTO t VALUES (1) RETURNING id'],
    ['ON CONFLICT', 'INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING'],
    ['INSERT ... SELECT', 'INSERT INTO t SELECT * FROM s'],
  ])('returns false for %s', (_name, sql) => expect(isBatchableInsert(sql)).toBe(false));
});
