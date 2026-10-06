import { describe, it, expect } from 'vitest';
import { OperatorClassShim } from '../query/OperatorClassShim';

function fresh(): OperatorClassShim {
  return new OperatorClassShim();
}

describe('OperatorClassShim.detect', () => {
  it('detects CREATE OPERATOR CLASS', () => {
    expect(
      OperatorClassShim.detect('CREATE OPERATOR CLASS idx_btree FOR TYPE int4 USING btree AS ...'),
    ).toBe('create_opclass');
  });

  it('detects CREATE OPERATOR FAMILY', () => {
    expect(
      OperatorClassShim.detect('CREATE OPERATOR FAMILY integer_ops USING btree;'),
    ).toBe('create_opfamily');
  });

  it('detects DROP OPERATOR CLASS', () => {
    expect(OperatorClassShim.detect('DROP OPERATOR CLASS idx_btree USING btree;')).toBe(
      'drop_opclass',
    );
  });

  it('detects DROP OPERATOR FAMILY', () => {
    expect(OperatorClassShim.detect('DROP OPERATOR FAMILY integer_ops USING btree;')).toBe(
      'drop_opfamily',
    );
  });

  it('rejects non-operator DDL', () => {
    expect(OperatorClassShim.detect('CREATE TABLE t (id int)')).toBe(false);
    expect(OperatorClassShim.detect('SELECT 1')).toBe(false);
  });

  it('rejects empty, blank, and non-string input', () => {
    expect(OperatorClassShim.detect('')).toBe(false);
    expect(OperatorClassShim.detect('   ')).toBe(false);
    expect(OperatorClassShim.detect(123 as unknown as string)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(
      OperatorClassShim.detect('create operator class x for type int4 using btree as ...'),
    ).toBe('create_opclass');
  });

  it('walks through all regexes and returns false for a prefix-only match', () => {
    // Prefix matches but no full regex matches, exercising the fallthrough to
    // the final `return false`.
    expect(OperatorClassShim.detect('CREATE OPERATOR CLASS name_without_full_body')).toBe(false);
    expect(OperatorClassShim.detect('DROP OPERATOR CLASS')).toBe(false);
    expect(OperatorClassShim.detect('DROP OPERATOR FAMILY')).toBe(false);
  });
});

describe('OperatorClassShim create/drop handlers', () => {
  it('creates and returns an operator class (SELECT 1 rewrite)', () => {
    const s = fresh();
    const r = s.handleCreateOperatorClass(
      'CREATE OPERATOR CLASS idx_btree FOR TYPE int4 USING btree AS OPERATOR 1 <',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
    expect(s.getAllOpclasses()).toHaveLength(1);
    expect(s.getAllOpclasses()[0].opclassName).toBe('idx_btree');
    expect(s.getAllOpclasses()[0].typeName).toBe('int4');
    expect(s.getAllOpclasses()[0].indexMethod).toBe('btree');
  });

  it('rejects a duplicate operator class', () => {
    const s = fresh();
    s.handleCreateOperatorClass('CREATE OPERATOR CLASS c FOR TYPE int4 USING btree AS OPERATOR 1 <');
    const r = s.handleCreateOperatorClass('CREATE OPERATOR CLASS c FOR TYPE int4 USING btree AS OPERATOR 1 <');
    expect(r.rewritten).toBe(true);
    expect(r.error).toContain('already exists');
    expect(s.getAllOpclasses()).toHaveLength(1);
  });

  it('rejects malformed CREATE OPERATOR CLASS', () => {
    const s = fresh();
    const r = s.handleCreateOperatorClass('CREATE OPERATOR CLASS broken');
    expect(r.rewritten).toBe(false);
    expect(r.error).toContain('Invalid CREATE OPERATOR CLASS');
  });

  it('rejects malformed DROP OPERATOR CLASS', () => {
    const s = fresh();
    const r = s.handleDropOperatorClass('DROP OPERATOR CLASS');
    expect(r.rewritten).toBe(false);
    expect(r.error).toContain('Invalid DROP OPERATOR CLASS');
  });

  it('creates an operator family', () => {
    const s = fresh();
    const r = s.handleCreateOperatorFamily('CREATE OPERATOR FAMILY integer_ops USING btree;');
    expect(r.rewritten).toBe(true);
    expect(s.getAllOpfamilies()).toHaveLength(1);
  });

  it('rejects a duplicate operator family', () => {
    const s = fresh();
    s.handleCreateOperatorFamily('CREATE OPERATOR FAMILY f USING btree;');
    const r = s.handleCreateOperatorFamily('CREATE OPERATOR FAMILY f USING btree;');
    expect(r.error).toContain('already exists');
    expect(r.rewritten).toBe(true);
  });

  it('rejects malformed CREATE OPERATOR FAMILY', () => {
    const s = fresh();
    const r = s.handleCreateOperatorFamily('CREATE OPERATOR FAMILY');
    expect(r.rewritten).toBe(false);
  });

  it('drops an existing operator class', () => {
    const s = fresh();
    s.handleCreateOperatorClass('CREATE OPERATOR CLASS c FOR TYPE int4 USING btree AS OPERATOR 1 <');
    const r = s.handleDropOperatorClass('DROP OPERATOR CLASS c USING btree;');
    expect(r.rewritten).toBe(true);
    expect(s.getAllOpclasses()).toHaveLength(0);
  });

  it('reports dropping a non-existent operator class', () => {
    const s = fresh();
    const r = s.handleDropOperatorClass('DROP OPERATOR CLASS c USING btree;');
    expect(r.error).toContain('does not exist');
  });

  it('drops an existing operator family', () => {
    const s = fresh();
    s.handleCreateOperatorFamily('CREATE OPERATOR FAMILY f USING btree;');
    const r = s.handleDropOperatorFamily('DROP OPERATOR FAMILY f USING btree;');
    expect(r.rewritten).toBe(true);
    expect(s.getAllOpfamilies()).toHaveLength(0);
  });

  it('reports dropping a non-existent operator family', () => {
    const s = fresh();
    const r = s.handleDropOperatorFamily('DROP OPERATOR FAMILY f USING btree;');
    expect(r.error).toContain('does not exist');
  });

  it('rejects malformed DROP OPERATOR FAMILY', () => {
    const s = fresh();
    const r = s.handleDropOperatorFamily('DROP OPERATOR FAMILY');
    expect(r.rewritten).toBe(false);
  });
});

describe('OperatorClassShim.process', () => {
  it('dispatches create_opclass', () => {
    const s = fresh();
    const r = s.process('CREATE OPERATOR CLASS c FOR TYPE int4 USING btree AS OPERATOR 1 <');
    expect(r.rewritten).toBe(true);
    expect(s.getAllOpclasses()).toHaveLength(1);
  });

  it('dispatches create_opfamily', () => {
    const s = fresh();
    s.process('CREATE OPERATOR FAMILY f USING btree;');
    expect(s.getAllOpfamilies()).toHaveLength(1);
  });

  it('dispatches drop_opclass', () => {
    const s = fresh();
    s.process('CREATE OPERATOR CLASS c FOR TYPE int4 USING btree AS OPERATOR 1 <');
    s.process('DROP OPERATOR CLASS c USING btree;');
    expect(s.getAllOpclasses()).toHaveLength(0);
  });

  it('dispatches drop_opfamily', () => {
    const s = fresh();
    s.process('CREATE OPERATOR FAMILY f USING btree;');
    s.process('DROP OPERATOR FAMILY f USING btree;');
    expect(s.getAllOpfamilies()).toHaveLength(0);
  });

  it('returns unchanged SQL for non-DDL input', () => {
    const s = fresh();
    const r = s.process('SELECT * FROM t');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT * FROM t');
  });
});

describe('OperatorClassShim persistence', () => {
  it('ensureTables invokes exec with intact `this` binding', () => {
    const ddl: string[] = [];
    const db = {
      exec: function (sql: string) {
        // Replicates better-sqlite3's dependency on the receiver.
        if (this === undefined || this !== db) throw new Error('this lost');
        ddl.push(sql);
      },
    };
    const s = fresh();
    s.setDb(db);
    expect(ddl.length).toBe(2);
    expect(ddl[0]).toContain('_sqlvec_opclasses');
    expect(ddl[1]).toContain('_sqlvec_opfamilies');
  });

  it('falls back to execute when exec is absent', () => {
    const ddl: string[] = [];
    const db = {
      execute: function (sql: string) {
        if (this !== db) throw new Error('this lost');
        ddl.push(sql);
      },
    };
    const s = fresh();
    s.setDb(db);
    expect(ddl.length).toBe(2);
  });

  it('does not crash when db has neither exec nor execute', () => {
    const s = fresh();
    s.setDb({} as any);
    expect(s.getAllOpclasses()).toHaveLength(0);
  });

  it('skips table creation on a second setDb (tableInitialized guard)', () => {
    let execCalls = 0;
    const db = {
      exec: () => {
        execCalls++;
      },
    };
    const s = fresh();
    s.setDb(db);
    s.setDb(db);
    expect(execCalls).toBe(2); // two tables on first call, none on second
  });

  it('persists a created opclass via prepare/run', () => {
    const runs: unknown[][] = [];
    const db = {
      exec: () => {},
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => {
          runs.push(args);
        },
      }),
    };
    const s = fresh();
    s.setDb(db);
    s.handleCreateOperatorClass('CREATE OPERATOR CLASS c FOR TYPE int4 USING btree AS OPERATOR 1 <');
    expect(runs.length).toBe(1);
    expect(runs[0][0]).toBe('c');
    expect(runs[0][1]).toBe('int4');
  });

  it('persists and removes an opfamily via prepare/run when db is set', () => {
    const writes: { sql: string; args: unknown[] }[] = [];
    const db = {
      exec: () => {},
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => {
          writes.push({ sql, args });
        },
      }),
    };
    const s = fresh();
    s.setDb(db);
    s.handleCreateOperatorFamily('CREATE OPERATOR FAMILY f USING btree;');
    s.handleDropOperatorFamily('DROP OPERATOR FAMILY f USING btree;');
    const insert = writes.find((w) => w.sql.toUpperCase().includes('INSERT'));
    const del = writes.find((w) => w.sql.toUpperCase().includes('DELETE'));
    expect(insert).toBeDefined();
    expect(insert!.args[0]).toBe('f');
    expect(del).toBeDefined();
    expect(del!.args[0]).toBe('f');
  });

  it('survives a throwing exec (logs warning)', () => {
    const db = {
      exec: () => {
        throw new Error('boom');
      },
    };
    const s = fresh();
    expect(() => s.setDb(db)).not.toThrow();
  });

  it('loadFromDb reads opclasses and opfamilies', () => {
    const famDb = {
      exec: () => {},
      prepare: (sql: string) => ({
        all: () =>
          sql.includes('_sqlvec_opfamilies')
            ? [{ opfamily_name: 'f', index_method: 'btree', owner: 'pg', created_at: 2000 }]
            : [{ opclass_name: 'c', type_name: 'int4', index_method: 'btree', owner: 'pg', created_at: 1000 }],
      }),
    };
    const s2 = fresh();
    s2.setDb(famDb);
    s2.loadFromDb();
    expect(s2.getAllOpclasses()).toHaveLength(1);
    expect(s2.getAllOpclasses()[0].opclassName).toBe('c');
    expect(s2.getAllOpfamilies()).toHaveLength(1);
    expect(s2.getAllOpfamilies()[0].opfamilyName).toBe('f');
  });

  it('loadFromDb no-ops when db is unset', () => {
    const s = fresh();
    expect(() => s.loadFromDb()).not.toThrow();
  });

  it('loadFromDb no-ops when db has no prepare', () => {
    const s = fresh();
    s.setDb({ exec: () => {} } as any);
    expect(() => s.loadFromDb()).not.toThrow();
  });

  it('loadFromDb survives a throwing prepare', () => {
    const db = {
      exec: () => {},
      prepare: () => {
        throw new Error('no table');
      },
    };
    const s = fresh();
    s.setDb(db);
    expect(() => s.loadFromDb()).not.toThrow();
  });

  it('loadFromDb skips duplicate keys already present in memory', () => {
    const db = {
      exec: () => {},
      prepare: (sql: string) => ({
        all: () =>
          sql.includes('_sqlvec_opfamilies')
            ? [{ opfamily_name: 'f', index_method: 'btree', owner: 'pg', created_at: 2000 }]
            : [{ opclass_name: 'c', type_name: 'int4', index_method: 'btree', owner: 'pg', created_at: 1000 }],
      }),
    };
    const s = fresh();
    // Pre-populate the exact keys that loadFromDb will also read.
    s.handleCreateOperatorClass('CREATE OPERATOR CLASS c FOR TYPE int4 USING btree AS OPERATOR 1 <');
    s.handleCreateOperatorFamily('CREATE OPERATOR FAMILY f USING btree;');
    // Now load — the in-memory entries have the same keys, so `has(key)` is true
    // and the dedupe guard skips re-insertion.
    s.setDb(db);
    s.loadFromDb();
    expect(s.getAllOpclasses()).toHaveLength(1);
    expect(s.getAllOpfamilies()).toHaveLength(1);
  });

  it('survives a throwing prepare during persist/remove (logs warnings)', () => {
    const throwingDb = {
      exec: () => {},
      prepare: () => {
        throw new Error('prepare failed');
      },
    };
    const s = fresh();
    s.setDb(throwingDb);
    // persistOpclass catch
    expect(() =>
      s.handleCreateOperatorClass('CREATE OPERATOR CLASS c FOR TYPE int4 USING btree AS OPERATOR 1 <'),
    ).not.toThrow();
    // persistOpfamily catch
    expect(() => s.handleCreateOperatorFamily('CREATE OPERATOR FAMILY f USING btree;')).not.toThrow();

    // removePersistedOpclass / removePersistedOpfamily catch — need in-memory
    // entries first so the drop path reaches the remove helpers.
    const s2 = fresh();
    const okDb = {
      exec: () => {},
      prepare: (sql: string) => ({
        run: () => {},
        all: () => [],
      }),
    };
    s2.setDb(okDb);
    s2.handleCreateOperatorClass('CREATE OPERATOR CLASS c FOR TYPE int4 USING btree AS OPERATOR 1 <');
    s2.handleCreateOperatorFamily('CREATE OPERATOR FAMILY f USING btree;');
    // Swap in a throwing db via a subclass-like mutation is not possible; instead
    // re-point db to throw on prepare for the drop path.
    (s2 as any).db = throwingDb;
    expect(() => s2.handleDropOperatorClass('DROP OPERATOR CLASS c USING btree;')).not.toThrow();
    expect(() => s2.handleDropOperatorFamily('DROP OPERATOR FAMILY f USING btree;')).not.toThrow();
  });

  it('removePersisted drops the row on drop', () => {
    const deleted: unknown[][] = [];
    const db = {
      exec: () => {},
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => {
          if (String(sql).toUpperCase().includes('DELETE')) deleted.push(args);
        },
      }),
    };
    const s = fresh();
    s.setDb(db);
    s.handleCreateOperatorClass('CREATE OPERATOR CLASS c FOR TYPE int4 USING btree AS OPERATOR 1 <');
    s.handleDropOperatorClass('DROP OPERATOR CLASS c USING btree;');
    expect(deleted.length).toBe(1);
    expect(deleted[0][0]).toBe('c');
  });
});

describe('OperatorClassShim singleton', () => {
  it('getInstance returns the same instance across calls', () => {
    expect(OperatorClassShim.getInstance()).toBe(OperatorClassShim.getInstance());
  });
});
