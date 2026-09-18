/**
 * Unit tests for the SQL injection guard.
 *
 * Two complementary properties are verified:
 *  1. Detection — known injection patterns are flagged with the correct id.
 *  2. No false positives — legitimate PostgreSQL/SQLite SQL passes through.
 *
 * This dual focus is critical: a guard that over-blocks breaks valid queries,
 * while one that under-blocks defeats the security boundary.
 */
import { describe, it, expect } from 'vitest';
import {
  SQLInjectionGuard,
  checkInjection,
  type InjectionCheckResult,
} from '../security/SQLInjectionGuard';

describe('checkInjection — detection', () => {
  it('detects union-based injection', () => {
    const r = checkInjection("SELECT * FROM users UNION SELECT password FROM admin");
    expect(r.blocked).toBe(true);
    expect(r.pattern).toBe('union-based-injection');
  });

  it('detects UNION ALL SELECT', () => {
    const r = checkInjection('SELECT a FROM t UNION ALL SELECT b FROM s');
    expect(r.blocked).toBe(true);
    expect(r.pattern).toBe('union-based-injection');
  });

  it('detects stacked queries', () => {
    const r = checkInjection("SELECT * FROM users; DROP TABLE users");
    expect(r.blocked).toBe(true);
    expect(r.pattern).toBe('stacked-query-injection');
  });

  it('detects comment truncation (-- and #)', () => {
    expect(checkInjection("SELECT * FROM users WHERE name = 'x' --").blocked).toBe(true);
    expect(checkInjection("SELECT * FROM users WHERE name = 'x' #hash").blocked).toBe(true);
    expect(checkInjection("SELECT * FROM t /* comment */").blocked).toBe(true);
  });

  it('detects tautologies', () => {
    expect(checkInjection("SELECT * FROM users WHERE id = 1 OR 1=1").blocked).toBe(true);
    expect(checkInjection("SELECT * FROM users WHERE name = 'x' OR '1'='1'").blocked).toBe(true);
  });

  it('detects time-based injection', () => {
    expect(checkInjection('SELECT * FROM t WHERE x = 1; SLEEP(5)').blocked).toBe(true);
    expect(checkInjection('SELECT pg_sleep(10)').blocked).toBe(true);
    expect(checkInjection('SELECT BENCHMARK(1000000, MD5(1))').blocked).toBe(true);
  });

  it('detects error-based injection', () => {
    expect(checkInjection("SELECT EXTRACTVALUE(1, 'a')").blocked).toBe(true);
    expect(checkInjection("SELECT UPDATEXML(1, 'a', 'b')").blocked).toBe(true);
  });

  it('reports the reason for a blocked query', () => {
    const r = checkInjection("SELECT * FROM t; DROP TABLE t") as InjectionCheckResult & { reason: string };
    expect(r.reason).toContain('Stacked');
  });
});

describe('checkInjection — no false positives', () => {
  it('allows plain SELECT / INSERT / UPDATE / DELETE', () => {
    expect(checkInjection('SELECT * FROM users').blocked).toBe(false);
    expect(checkInjection('SELECT id, name FROM users WHERE id = 42').blocked).toBe(false);
    expect(checkInjection('INSERT INTO t (a) VALUES (1)').blocked).toBe(false);
    expect(checkInjection('UPDATE t SET a = 1 WHERE id = 2').blocked).toBe(false);
    expect(checkInjection('DELETE FROM t WHERE id = 3').blocked).toBe(false);
  });

  it('allows DDL and DCL statements', () => {
    expect(checkInjection('CREATE TABLE t (id INTEGER)').blocked).toBe(false);
    expect(checkInjection('ALTER TABLE t ADD COLUMN c TEXT').blocked).toBe(false);
    expect(checkInjection('DROP TABLE t').blocked).toBe(false);
    expect(checkInjection('GRANT SELECT ON t TO u').blocked).toBe(false);
  });

  it('allows empty / non-string input', () => {
    expect(checkInjection('').blocked).toBe(false);
    expect(checkInjection('   ').blocked).toBe(false);
    // @ts-expect-error defensive branch
    expect(checkInjection(null).blocked).toBe(false);
  });

  it('does not flag a single statement without a stacked verb', () => {
    expect(checkInjection('SELECT * FROM t;').blocked).toBe(false);
    expect(checkInjection('SELECT 1; SELECT 2').blocked).toBe(true); // still two SELECTs
  });
});

describe('SQLInjectionGuard facade', () => {
  it('check() delegates to checkInjection', () => {
    const r = SQLInjectionGuard.check('SELECT * FROM t UNION SELECT x FROM y');
    expect(r.blocked).toBe(true);
    expect(r.pattern).toBe('union-based-injection');
  });

  it('getInstance() returns an instance', () => {
    expect(SQLInjectionGuard.getInstance()).toBeInstanceOf(SQLInjectionGuard);
  });
});
