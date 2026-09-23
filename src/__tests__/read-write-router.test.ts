/**
 * ReadWriteRouter — read/write SQL classification and routing tests.
 *
 * Exercises every classification branch (read/write/unknown), the
 * string/comment/identifier literal masking that prevents keywords inside
 * literals from being misclassified, the routing logic (replica vs primary,
 * transaction forcing), replica health checking (including caching and
 * failure), and read-only replica auto-detection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReadWriteRouter } from '../query/ReadWriteRouter';

function fakeDb() {
  return {
    prepare: vi.fn(),
    exec: vi.fn(),
  };
}

describe('ReadWriteRouter.classifyQuery', () => {
  let router: ReadWriteRouter;

  beforeEach(() => {
    router = new ReadWriteRouter(fakeDb());
  });

  describe('read statements', () => {
    it('classifies a plain SELECT as read', () => {
      expect(router.classifyQuery('SELECT * FROM users')).toBe('read');
    });

    it('classifies SELECT with joins and where as read', () => {
      expect(router.classifyQuery('SELECT a.id FROM a JOIN b ON a.id=b.id WHERE b.x=1')).toBe('read');
    });

    it('classifies EXPLAIN as read', () => {
      expect(router.classifyQuery('EXPLAIN SELECT 1')).toBe('read');
      expect(router.classifyQuery('EXPLAIN ANALYZE SELECT 1')).toBe('read');
    });

    it('classifies DESCRIBE as read', () => {
      expect(router.classifyQuery('DESCRIBE users')).toBe('read');
    });

    it('classifies a read-only CTE (WITH ... SELECT) as read', () => {
      expect(router.classifyQuery('WITH x AS (SELECT * FROM a) SELECT * FROM x')).toBe('read');
    });

    it('classifies COPY ... TO as read', () => {
      expect(router.classifyQuery('COPY users TO STDOUT')).toBe('read');
      expect(router.classifyQuery('COPY users (a,b) TO STDOUT')).toBe('read');
    });
  });

  describe('write statements', () => {
    it.each(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])(
      'classifies %s as write',
      (kw) => {
        expect(router.classifyQuery(`${kw} INTO t VALUES (1)`)).toBe('write');
      },
    );

    it.each([
      'CREATE TABLE t (id INT)',
      'ALTER TABLE t ADD c INT',
      'DROP TABLE t',
      'TRUNCATE t',
      'COMMENT ON TABLE t IS \'x\'',
      'RENAME TABLE t TO t2',
      'GRANT SELECT ON t TO u',
      'REVOKE SELECT ON t FROM u',
      'ANALYZE t',
      'VACUUM',
      'REINDEX TABLE t',
      'CLUSTER t',
    ])('classifies DDL %s as write', (sql) => {
      expect(router.classifyQuery(sql)).toBe('write');
    });

    it('classifies CALL / DO / DECLARE as write', () => {
      expect(router.classifyQuery('CALL myproc()')).toBe('write');
      expect(router.classifyQuery('DO $$ BEGIN NULL; END $$')).toBe('write');
      expect(router.classifyQuery('DECLARE x int')).toBe('write');
    });

    it('classifies SELECT ... FOR UPDATE as write', () => {
      expect(router.classifyQuery('SELECT * FROM t FOR UPDATE')).toBe('write');
      expect(router.classifyQuery('SELECT * FROM t FOR SHARE')).toBe('write');
      expect(router.classifyQuery('SELECT * FROM t FOR NO KEY UPDATE')).toBe('write');
      expect(router.classifyQuery('SELECT * FROM t FOR KEY SHARE')).toBe('write');
    });

    it('classifies SELECT ... INTO (creating a table) as write', () => {
      expect(router.classifyQuery('SELECT * INTO new_table FROM users')).toBe('write');
      expect(router.classifyQuery('SELECT id INTO TEMP TABLE tmp FROM users')).toBe('write');
    });

    it('classifies a modifying CTE (WITH ... INSERT) as write', () => {
      expect(router.classifyQuery('WITH x AS (INSERT INTO a VALUES (1) RETURNING *) SELECT * FROM x')).toBe('write');
      expect(router.classifyQuery('WITH x AS (UPDATE a SET v=2 RETURNING *) SELECT * FROM x')).toBe('write');
      expect(router.classifyQuery('WITH x AS (DELETE FROM a RETURNING *) SELECT * FROM x')).toBe('write');
    });

    it('classifies COPY ... FROM as write', () => {
      expect(router.classifyQuery('COPY users FROM STDIN')).toBe('write');
      expect(router.classifyQuery('COPY users FROM \'/tmp/x.csv\'')).toBe('write');
    });

    it('classifies LOCK TABLE as write', () => {
      expect(router.classifyQuery('LOCK TABLE users')).toBe('write');
    });
  });

  describe('unknown statements', () => {
    it.each([
      'SET search_path TO public',
      'SHOW search_path',
      'BEGIN',
      'COMMIT',
      'ROLLBACK',
      'SAVEPOINT s1',
      'RELEASE s1',
      'PREPARE p AS SELECT 1',
      'EXECUTE p',
      'DEALLOCATE p',
      'LISTEN chan',
      'NOTIFY chan',
      'UNLISTEN chan',
      'DISCARD ALL',
      'LOAD \'ext\'',
      'CHECKPOINT',
    ])('classifies %s as unknown', (sql) => {
      expect(router.classifyQuery(sql)).toBe('unknown');
    });

    it('classifies empty / non-string as unknown', () => {
      expect(router.classifyQuery('')).toBe('unknown');
      expect(router.classifyQuery(undefined as any)).toBe('unknown');
      expect(router.classifyQuery(null as any)).toBe('unknown');
      expect(router.classifyQuery(42 as any)).toBe('unknown');
    });
  });

  describe('literal masking (keywords inside strings/comments must be ignored)', () => {
    it('ignores a keyword inside a single-quoted string', () => {
      expect(router.classifyQuery("SELECT * FROM t WHERE note = 'INSERT INTO x'")).toBe('read');
    });

    it('ignores a keyword inside a double-quoted identifier', () => {
      expect(router.classifyQuery('SELECT * FROM note_tbl WHERE x = "INSERT INTO y"')).toBe('read');
    });

    it('ignores a keyword inside a dollar-quoted string', () => {
      expect(router.classifyQuery('SELECT $$ INSERT INTO fake $$ AS body')).toBe('read');
      expect(router.classifyQuery('SELECT $tag$ DELETE FROM fake $tag$')).toBe('read');
    });

    it('ignores a modifying keyword inside a CTE string literal', () => {
      expect(router.classifyQuery("WITH x AS (SELECT 'INSERT' AS s) SELECT s FROM x")).toBe('read');
    });

    it('ignores a line comment before a SELECT', () => {
      expect(router.classifyQuery('-- INSERT INTO fake\nSELECT 1')).toBe('read');
    });

    it('ignores a block comment before a SELECT', () => {
      expect(router.classifyQuery('/* INSERT INTO fake */ SELECT 1')).toBe('read');
    });

    it('ignores an inline line comment with a write keyword', () => {
      expect(router.classifyQuery('SELECT * FROM users -- comment with INSERT here\n WHERE id=1')).toBe('read');
    });

    it('handles E\'...\' backslash-escaped quotes', () => {
      expect(router.classifyQuery("SELECT E'foo\\'bar' FROM t")).toBe('read');
    });

    it('handles doubled double-quotes inside an identifier', () => {
      expect(router.classifyQuery('SELECT "weird""name" FROM t')).toBe('read');
    });

    it('does not misread WITHOUT as a WITH CTE', () => {
      expect(router.classifyQuery('WITHOUT ROWID')).toBe('unknown');
    });

    it('handles a doubled single quote (escaped quote) inside a string', () => {
      expect(router.classifyQuery("SELECT 'it''s INSERT INTO fake' AS s")).toBe('read');
    });

    it('handles an unterminated single-quoted string', () => {
      expect(router.classifyQuery("SELECT 'INSERT INTO fake")).toBe('read');
    });

    it('handles an unterminated block comment', () => {
      expect(router.classifyQuery('/* INSERT INTO fake')).toBe('unknown');
    });

    it('handles an unterminated dollar-quoted string', () => {
      expect(router.classifyQuery('SELECT $$ INSERT INTO fake')).toBe('read');
    });

    it('handles a dollar sign that is not a dollar-quote (e.g. a parameter)', () => {
      expect(router.classifyQuery('SELECT $1 AS x')).toBe('read');
    });

    it('classifies a query that is only a comment as unknown', () => {
      expect(router.classifyQuery('-- just a comment')).toBe('unknown');
      expect(router.classifyQuery('/* just a comment */')).toBe('unknown');
    });
  });
});

describe('ReadWriteRouter.route', () => {
  let primary: any;
  let replica: any;
  let router: ReadWriteRouter;

  beforeEach(() => {
    primary = fakeDb();
    replica = fakeDb();
    router = new ReadWriteRouter(primary, replica);
  });

  it('routes a read query to the healthy replica', () => {
    (replica.prepare as any).mockReturnValue({ get: () => ({ ok: 1 }) });
    const result = router.route('SELECT * FROM t');
    expect(result.db).toBe(replica);
    expect(result.isReadOnly).toBe(true);
  });

  it('routes a write query to primary', () => {
    const result = router.route('INSERT INTO t VALUES (1)');
    expect(result.db).toBe(primary);
    expect(result.isReadOnly).toBe(false);
  });

  it('routes an unknown query to primary', () => {
    const result = router.route('SET x = 1');
    expect(result.db).toBe(primary);
  });

  it('routes everything to primary when in a transaction', () => {
    (replica.prepare as any).mockReturnValue({ get: () => ({ ok: 1 }) });
    const result = router.route('SELECT * FROM t', true);
    expect(result.db).toBe(primary);
    expect(result.isReadOnly).toBe(false);
  });

  it('falls back to primary when no replica is configured', () => {
    const r2 = new ReadWriteRouter(primary);
    const result = r2.route('SELECT * FROM t');
    expect(result.db).toBe(primary);
  });

  it('falls back to primary when the replica is unhealthy', () => {
    (replica.prepare as any).mockReturnValue({ get: () => ({ ok: 0 }) });
    const result = router.route('SELECT * FROM t');
    expect(result.db).toBe(primary);
  });
});

describe('ReadWriteRouter.isReplicaHealthy', () => {
  let primary: any;
  let replica: any;
  let router: ReadWriteRouter;

  beforeEach(() => {
    primary = fakeDb();
    replica = fakeDb();
    router = new ReadWriteRouter(primary, replica);
  });

  it('returns false when there is no replica', () => {
    const r2 = new ReadWriteRouter(primary);
    expect(r2.isReplicaHealthy()).toBe(false);
  });

  it('returns true when the health query yields ok=1', () => {
    (replica.prepare as any).mockReturnValue({ get: () => ({ ok: 1 }) });
    expect(router.isReplicaHealthy()).toBe(true);
  });

  it('returns false when the health query yields an unexpected result', () => {
    (replica.prepare as any).mockReturnValue({ get: () => ({ ok: 0 }) });
    expect(router.isReplicaHealthy()).toBe(false);
  });

  it('returns false when the health query throws', () => {
    (replica.prepare as any).mockImplementation(() => {
      throw new Error('down');
    });
    expect(router.isReplicaHealthy()).toBe(false);
  });

  it('caches the health result within the check interval', () => {
    (replica.prepare as any).mockReturnValue({ get: () => ({ ok: 1 }) });
    expect(router.isReplicaHealthy()).toBe(true);
    // Change the underlying result; the cached answer should be returned.
    (replica.prepare as any).mockReturnValue({ get: () => ({ ok: 0 }) });
    expect(router.isReplicaHealthy()).toBe(true);
  });

  it('re-checks after setReplicaHealth forces a fresh check', () => {
    router.setReplicaHealth(false);
    expect(router.isReplicaHealthy()).toBe(false);
  });
});

describe('ReadWriteRouter.checkIsReplica', () => {
  it('returns false for null / non-object', () => {
    expect(ReadWriteRouter.checkIsReplica(null)).toBe(false);
    expect(ReadWriteRouter.checkIsReplica(undefined)).toBe(false);
    expect(ReadWriteRouter.checkIsReplica('x' as any)).toBe(false);
    expect(ReadWriteRouter.checkIsReplica(42 as any)).toBe(false);
  });

  it('returns true when PRAGMA query_only is 1', () => {
    const db = {
      prepare: () => ({ get: () => ({ query_only: 1 }) }),
      exec: vi.fn(),
    };
    expect(ReadWriteRouter.checkIsReplica(db)).toBe(true);
  });

  it('returns false when writes succeed (not read-only)', () => {
    const db = {
      prepare: () => ({ get: () => ({ query_only: 0 }) }),
      exec: vi.fn(),
    };
    expect(ReadWriteRouter.checkIsReplica(db)).toBe(false);
  });

  it('returns true when CREATE TEMP TABLE fails (read-only mode)', () => {
    const db = {
      prepare: () => ({ get: () => ({ query_only: 0 }) }),
      exec: vi.fn(() => {
        throw new Error('attempt to write a readonly database');
      }),
    };
    expect(ReadWriteRouter.checkIsReplica(db)).toBe(true);
  });

  it('tolerates a missing prepare method', () => {
    const db = { exec: vi.fn() };
    expect(ReadWriteRouter.checkIsReplica(db)).toBe(false);
  });
});
