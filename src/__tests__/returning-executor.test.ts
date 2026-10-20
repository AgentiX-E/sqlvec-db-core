/**
 * returning-executor.test.ts — Coverage tests for ReturningExecutor
 * (PostgreSQL RETURNING clause handling for SQLite).
 */

import { describe, it, expect } from 'vitest';
import {
  isSimpleReturning,
  stripPGSchemaQualifiers,
  stripReturningClause,
  extractReturningClause,
  isDmlStatement,
  shouldUseNativeReturning,
} from '../query/ReturningExecutor';

describe('isSimpleReturning', () => {
  it('returns false for empty/whitespace', () => {
    expect(isSimpleReturning('')).toBe(false);
    expect(isSimpleReturning('   ')).toBe(false);
  });

  it('returns true for wildcard *', () => {
    expect(isSimpleReturning('*')).toBe(true);
  });

  it('returns true for simple column list', () => {
    expect(isSimpleReturning('id')).toBe(true);
    expect(isSimpleReturning('id, name')).toBe(true);
    expect(isSimpleReturning('id AS alias, name')).toBe(true);
  });

  it('returns false for function call', () => {
    expect(isSimpleReturning('COUNT(*)')).toBe(false);
    expect(isSimpleReturning('UPPER(col)')).toBe(false);
  });

  it('returns false for operator expression', () => {
    expect(isSimpleReturning('col1 + 1')).toBe(false);
    expect(isSimpleReturning("col1 || ', ' || col2")).toBe(false);
  });
});

describe('stripPGSchemaQualifiers', () => {
  it('returns null for non-string/empty', () => {
    expect(stripPGSchemaQualifiers(undefined as unknown as string)).toBeNull();
    expect(stripPGSchemaQualifiers('')).toBeNull();
  });

  it('strips 3-part schema.table.column', () => {
    expect(stripPGSchemaQualifiers('"public"."User"."id"')).toBe('"id"');
  });

  it('strips schema.table when schema is known', () => {
    expect(stripPGSchemaQualifiers('"public"."User"')).toBe('"User"');
    expect(stripPGSchemaQualifiers('"pg_catalog"."t"')).toBe('"t"');
  });

  it('keeps table.column when first part is not a known schema', () => {
    expect(stripPGSchemaQualifiers('"User"."id"')).toBeNull();
  });

  it('returns null when no schema qualifiers present', () => {
    expect(stripPGSchemaQualifiers('SELECT * FROM t')).toBeNull();
  });
});

describe('stripReturningClause', () => {
  it('returns unchanged when no RETURNING', () => {
    expect(stripReturningClause('INSERT INTO t (name) VALUES ("x")')).toBe(
      'INSERT INTO t (name) VALUES ("x")',
    );
  });

  it('strips RETURNING clause', () => {
    expect(stripReturningClause("INSERT INTO t (name) VALUES ('x') RETURNING *")).toBe(
      "INSERT INTO t (name) VALUES ('x')",
    );
  });

  it('strips RETURNING clause with trailing semicolon', () => {
    expect(stripReturningClause("INSERT INTO t (name) VALUES ('x') RETURNING id;")).toBe(
      "INSERT INTO t (name) VALUES ('x')",
    );
  });
});

describe('extractReturningClause', () => {
  it('returns null when no RETURNING', () => {
    expect(extractReturningClause('INSERT INTO t VALUES (1)')).toBeNull();
  });

  it('extracts RETURNING content', () => {
    expect(extractReturningClause("INSERT INTO t VALUES (1) RETURNING *")).toBe('*');
    expect(extractReturningClause("INSERT INTO t VALUES (1) RETURNING id, name AS n")).toBe(
      'id, name AS n',
    );
  });

  it('strips trailing semicolon from extracted content', () => {
    expect(extractReturningClause('INSERT INTO t VALUES (1) RETURNING id;')).toBe('id');
  });

  it('returns null for empty RETURNING content', () => {
    expect(extractReturningClause('INSERT INTO t VALUES (1) RETURNING;')).toBeNull();
  });
});

describe('isDmlStatement', () => {
  it('returns false for empty string', () => {
    expect(isDmlStatement('')).toBe(false);
    expect(isDmlStatement('   ')).toBe(false);
  });

  it('detects INSERT INTO', () => {
    expect(isDmlStatement('INSERT INTO t VALUES (1)')).toBe(true);
  });

  it('detects UPDATE', () => {
    expect(isDmlStatement('UPDATE t SET c = 1')).toBe(true);
  });

  it('detects DELETE FROM', () => {
    expect(isDmlStatement('DELETE FROM t')).toBe(true);
  });

  it('detects DML in WITH CTE', () => {
    expect(isDmlStatement('WITH c AS (SELECT 1) INSERT INTO t VALUES (1)')).toBe(true);
    expect(isDmlStatement('WITH RECURSIVE c AS (SELECT 1) UPDATE t SET c = 1')).toBe(true);
    expect(isDmlStatement('WITH c AS (SELECT 1) DELETE FROM t')).toBe(true);
  });

  it('returns false for non-DML', () => {
    expect(isDmlStatement('SELECT 1')).toBe(false);
  });

  it('returns false for CTE with non-DML body', () => {
    expect(isDmlStatement('WITH c AS (SELECT 1) SELECT 2')).toBe(false);
  });
});

describe('shouldUseNativeReturning', () => {
  it('returns false when no RETURNING', () => {
    expect(shouldUseNativeReturning('INSERT INTO t VALUES (1)')).toBe(false);
  });

  it('returns false for CTE with RETURNING', () => {
    expect(
      shouldUseNativeReturning('WITH c AS (SELECT 1) INSERT INTO t VALUES (1) RETURNING *'),
    ).toBe(false);
  });

  it('returns false for DML with subquery', () => {
    expect(
      shouldUseNativeReturning('INSERT INTO t VALUES ((SELECT 1)) RETURNING *'),
    ).toBe(false);
  });

  it('returns false for complex (function) RETURNING', () => {
    expect(shouldUseNativeReturning("INSERT INTO t VALUES (1) RETURNING COUNT(*)")).toBe(
      false,
    );
  });

  it('returns true for simple RETURNING', () => {
    expect(shouldUseNativeReturning('INSERT INTO t VALUES (1) RETURNING *')).toBe(true);
    expect(shouldUseNativeReturning('UPDATE t SET c = 1 RETURNING id')).toBe(true);
    expect(shouldUseNativeReturning('DELETE FROM t WHERE id = 1 RETURNING id, name')).toBe(
      true,
    );
  });
});
