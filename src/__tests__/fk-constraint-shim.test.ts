import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectPgFkExt,
  rewritePgFkExt,
  ensureMetaTable,
  addFkDef,
  removeFkDefs,
  getFkDefs,
  getReferencingFkDefs,
  onInsert,
  onDelete,
  onUpdate,
  loadFromDB,
} from '../query/FkConstraintShim';
import type { FkDef } from '../query/FkConstraintShim';

const baseDef: FkDef = {
  name: 'fk_child_parent',
  table: 'child',
  columns: ['parent_id'],
  refTable: 'parent',
  refColumns: ['id'],
  onDelete: 'NO ACTION',
  onUpdate: 'NO ACTION',
};

describe('detectPgFkExt', () => {
  it('returns false for empty or non-string input', () => {
    expect(detectPgFkExt('')).toBe(false);
    expect(detectPgFkExt(null as unknown as string)).toBe(false);
    expect(detectPgFkExt(42 as unknown as string)).toBe(false);
  });

  it('detects MATCH FULL/PARTIAL/SIMPLE', () => {
    expect(detectPgFkExt('REFERENCES t (b) MATCH FULL')).toBe(true);
    expect(detectPgFkExt('REFERENCES t (b) MATCH PARTIAL')).toBe(true);
    expect(detectPgFkExt('REFERENCES t (b) MATCH SIMPLE')).toBe(true);
  });

  it('detects DEFERRABLE and NOT DEFERRABLE', () => {
    expect(detectPgFkExt('REFERENCES t (b) DEFERRABLE')).toBe(true);
    expect(detectPgFkExt('REFERENCES t (b) NOT DEFERRABLE')).toBe(true);
  });

  it('detects INITIALLY DEFERRED/IMMEDIATE', () => {
    expect(detectPgFkExt('REFERENCES t (b) INITIALLY DEFERRED')).toBe(true);
    expect(detectPgFkExt('REFERENCES t (b) INITIALLY IMMEDIATE')).toBe(true);
  });

  it('returns false for a plain FK without PG extensions', () => {
    expect(detectPgFkExt('FOREIGN KEY (a) REFERENCES t (b)')).toBe(false);
  });

  it('does not detect extension keywords inside a string literal', () => {
    expect(detectPgFkExt("SELECT 'MATCH FULL DEFERRABLE' FROM t")).toBe(false);
    expect(detectPgFkExt("CREATE TABLE t (a TEXT DEFAULT 'DEFERRABLE')")).toBe(false);
  });

  it('does not detect extension keywords inside a comment', () => {
    expect(detectPgFkExt('-- MATCH FULL\nSELECT 1')).toBe(false);
  });
});

describe('rewritePgFkExt', () => {
  it('returns unchanged for empty/non-string input', () => {
    expect(rewritePgFkExt('')).toEqual({ sql: '', rewritten: false });
    expect(rewritePgFkExt(null as unknown as string)).toEqual({ sql: null, rewritten: false });
  });

  it('returns unchanged when no PG extension present', () => {
    expect(rewritePgFkExt('FOREIGN KEY (a) REFERENCES t (b)')).toEqual({
      sql: 'FOREIGN KEY (a) REFERENCES t (b)',
      rewritten: false,
    });
  });

  it('strips MATCH clause', () => {
    expect(rewritePgFkExt('REFERENCES t (b) MATCH FULL')).toEqual({
      sql: 'REFERENCES t (b)',
      rewritten: true,
    });
  });

  it('strips DEFERRABLE / NOT DEFERRABLE', () => {
    expect(rewritePgFkExt('REFERENCES t (b) DEFERRABLE')).toEqual({
      sql: 'REFERENCES t (b)',
      rewritten: true,
    });
    expect(rewritePgFkExt('REFERENCES t (b) NOT DEFERRABLE')).toEqual({
      sql: 'REFERENCES t (b)',
      rewritten: true,
    });
  });

  it('strips INITIALLY clause', () => {
    expect(rewritePgFkExt('REFERENCES t (b) INITIALLY IMMEDIATE')).toEqual({
      sql: 'REFERENCES t (b)',
      rewritten: true,
    });
  });

  it('strips multiple stacked extensions', () => {
    expect(rewritePgFkExt('REFERENCES t (b) MATCH FULL DEFERRABLE INITIALLY DEFERRED')).toEqual({
      sql: 'REFERENCES t (b)',
      rewritten: true,
    });
  });

  it('does not touch extension keywords inside a string literal', () => {
    expect(rewritePgFkExt("INSERT INTO t VALUES ('MATCH FULL DEFERRABLE')")).toEqual({
      sql: "INSERT INTO t VALUES ('MATCH FULL DEFERRABLE')",
      rewritten: false,
    });
    expect(rewritePgFkExt("CREATE TABLE t (a TEXT DEFAULT 'DEFERRABLE')")).toEqual({
      sql: "CREATE TABLE t (a TEXT DEFAULT 'DEFERRABLE')",
      rewritten: false,
    });
  });

  it('does not touch a comment mentioning an extension', () => {
    expect(rewritePgFkExt('-- MATCH FULL\nSELECT 1')).toEqual({
      sql: '-- MATCH FULL\nSELECT 1',
      rewritten: false,
    });
  });
});

describe('ensureMetaTable', () => {
  it('executes the DDL via queryFn', async () => {
    const executed: string[] = [];
    await ensureMetaTable(async (sql) => {
      executed.push(sql);
    });
    expect(executed.some((s) => s.includes('CREATE TABLE IF NOT EXISTS __foreign_keys'))).toBe(true);
  });

  it('rethrows errors from queryFn', async () => {
    await expect(
      ensureMetaTable(async () => {
        throw new Error('ddl failed');
      }),
    ).rejects.toThrow('ddl failed');
  });
});

describe('registry (addFkDef / removeFkDefs / getFkDefs / getReferencingFkDefs)', () => {
  beforeEach(async () => {
    await removeFkDefs('child');
    await removeFkDefs('other');
  });

  it('returns empty when no FK registered', () => {
    expect(getFkDefs('child')).toEqual([]);
  });

  it('registers and returns FKs (case-insensitive)', () => {
    addFkDef(baseDef);
    expect(getFkDefs('CHILD')).toHaveLength(1);
    expect(getFkDefs('child')[0].name).toBe('fk_child_parent');
  });

  it('isolates FKs by table', () => {
    addFkDef(baseDef);
    addFkDef({ ...baseDef, name: 'fk_other', table: 'other' });
    expect(getFkDefs('child')).toHaveLength(1);
    expect(getFkDefs('other')).toHaveLength(1);
  });

  it('removes all FKs for a table (in-memory)', async () => {
    addFkDef(baseDef);
    addFkDef({ ...baseDef, name: 'fk_child2', table: 'child' });
    await removeFkDefs('child');
    expect(getFkDefs('child')).toEqual([]);
  });

  it('finds FKs referencing a table', () => {
    addFkDef(baseDef);
    expect(getReferencingFkDefs('parent')).toHaveLength(1);
    expect(getReferencingFkDefs('PARENT')).toHaveLength(1);
    expect(getReferencingFkDefs('unrelated')).toHaveLength(0);
  });

  it('addFkDef persists via queryFn and escapes quotes', async () => {
    const executed: string[] = [];
    await addFkDef(
      { ...baseDef, name: "O'Brien", table: 'child' },
      async (sql) => {
        executed.push(sql);
        return { rows: [] };
      },
    );
    const insert = executed.find((s) => s.includes('INSERT OR REPLACE'));
    expect(insert).toBeDefined();
    expect(insert).toContain("'O''Brien'");
  });

  it('removeFkDefs persists DELETE via queryFn', async () => {
    addFkDef(baseDef);
    const executed: string[] = [];
    await removeFkDefs('child', async (sql) => {
      executed.push(sql);
      return { rows: [] };
    });
    expect(executed.some((s) => s.includes('DELETE FROM __foreign_keys'))).toBe(true);
  });
});

describe('onInsert', () => {
  beforeEach(async () => {
    await removeFkDefs('child');
    await removeFkDefs('parent');
  });

  it('passes when no FK is registered', async () => {
    await expect(
      onInsert('child', { parent_id: 1 }, async () => ({ rows: [] })),
    ).resolves.toBeUndefined();
  });

  it('passes when the referenced row exists (array result)', async () => {
    addFkDef(baseDef);
    await expect(
      onInsert('child', { parent_id: 1 }, async () => [{ 1: 1 }]),
    ).resolves.toBeUndefined();
  });

  it('passes when the referenced row exists ({ rows } result)', async () => {
    addFkDef(baseDef);
    await expect(
      onInsert('child', { parent_id: 1 }, async () => ({ rows: [{}] })),
    ).resolves.toBeUndefined();
  });

  it('throws when the referenced row is absent', async () => {
    addFkDef(baseDef);
    await expect(
      onInsert('child', { parent_id: 999 }, async () => ({ rows: [] })),
    ).rejects.toThrow(/violates foreign key constraint "fk_child_parent"/);
  });

  it('skips the check when all FK columns are NULL/undefined', async () => {
    addFkDef(baseDef);
    let called = false;
    await onInsert('child', { parent_id: null }, async () => {
      called = true;
      return { rows: [] };
    });
    expect(called).toBe(false);
  });

  it('builds IS NULL for a null column value mixed with non-null columns', () => {
    addFkDef({ ...baseDef, columns: ['a', 'b'], refColumns: ['x', 'y'] });
    const executed: string[] = [];
    return onInsert('child', { a: 1, b: null }, async (sql) => {
      executed.push(sql);
      return { rows: [{ 1: 1 }] };
    }).then(() => {
      expect(executed.some((s) => s.includes('"y" IS NULL'))).toBe(true);
    });
  });

  it('escapes single quotes in FK values', async () => {
    addFkDef({ ...baseDef, columns: ['name'], refColumns: ['name'] });
    const executed: string[] = [];
    await onInsert('child', { name: "O'Brien" }, async (sql) => {
      executed.push(sql);
      return { rows: [{ 1: 1 }] };
    });
    expect(executed.some((s) => s.includes("'O''Brien'"))).toBe(true);
  });

  it('serializes boolean as 1 and number as-is', async () => {
    addFkDef({ ...baseDef, columns: ['flag', 'n'], refColumns: ['f', 'n'] });
    const executed: string[] = [];
    await onInsert('child', { flag: true, n: 42 }, async (sql) => {
      executed.push(sql);
      return { rows: [{ 1: 1 }] };
    });
    expect(executed.some((s) => s.includes('"f" = 1'))).toBe(true);
    expect(executed.some((s) => s.includes('"n" = 42'))).toBe(true);
  });

  it('serializes false boolean as 0', async () => {
    addFkDef({ ...baseDef, columns: ['flag'], refColumns: ['f'] });
    const executed: string[] = [];
    await onInsert('child', { flag: false }, async (sql) => {
      executed.push(sql);
      return { rows: [{ 1: 1 }] };
    });
    expect(executed.some((s) => s.includes('"f" = 0'))).toBe(true);
  });

  it('falls back to the local column name when refColumns is empty', async () => {
    addFkDef({ ...baseDef, columns: ['parent_id'], refColumns: [] });
    const executed: string[] = [];
    await onInsert('child', { parent_id: 1 }, async (sql) => {
      executed.push(sql);
      return { rows: [{ 1: 1 }] };
    });
    expect(executed.some((s) => s.includes('"parent_id" = 1'))).toBe(true);
  });

  it('passes when the query returns no recognized rows', async () => {
    addFkDef(baseDef);
    await expect(
      onInsert('child', { parent_id: 1 }, async () => ({})),
    ).rejects.toThrow(/violates foreign key constraint/);
  });
});

describe('onDelete', () => {
  beforeEach(async () => {
    await removeFkDefs('child');
    await removeFkDefs('parent');
  });

  it('does nothing when no referencing FK exists', async () => {
    let called = false;
    await onDelete('parent', { id: 1 }, async () => {
      called = true;
      return { rows: [] };
    });
    expect(called).toBe(false);
  });

  it('passes when no referencing rows exist', async () => {
    addFkDef(baseDef);
    await expect(
      onDelete('parent', { id: 1 }, async () => ({ rows: [] })),
    ).resolves.toBeUndefined();
  });

  it('throws for RESTRICT when referencing rows exist', async () => {
    addFkDef({ ...baseDef, onDelete: 'RESTRICT' });
    await expect(
      onDelete('parent', { id: 1 }, async () => ({ rows: [{}] })),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('throws for NO ACTION when referencing rows exist', async () => {
    addFkDef({ ...baseDef, onDelete: 'NO ACTION' });
    await expect(
      onDelete('parent', { id: 1 }, async () => ({ rows: [{}] })),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('applies CASCADE when referencing rows exist', async () => {
    addFkDef({ ...baseDef, onDelete: 'CASCADE' });
    const executed: string[] = [];
    await onDelete('parent', { id: 1 }, async (sql) => {
      executed.push(sql);
      return { rows: sql.startsWith('SELECT') ? [{ 1: 1 }] : [] };
    });
    expect(executed.some((s) => s.includes('DELETE FROM "child"'))).toBe(true);
  });

  it('applies SET NULL when referencing rows exist', async () => {
    addFkDef({ ...baseDef, onDelete: 'SET NULL' });
    const executed: string[] = [];
    await onDelete('parent', { id: 1 }, async (sql) => {
      executed.push(sql);
      return { rows: sql.startsWith('SELECT') ? [{ 1: 1 }] : [] };
    });
    expect(executed.some((s) => s.includes('SET "id" = NULL'))).toBe(true);
  });

  it('applies SET DEFAULT when referencing rows exist', async () => {
    addFkDef({ ...baseDef, onDelete: 'SET DEFAULT' });
    const executed: string[] = [];
    await onDelete('parent', { id: 1 }, async (sql) => {
      executed.push(sql);
      return { rows: sql.startsWith('SELECT') ? [{ 1: 1 }] : [] };
    });
    expect(executed.some((s) => s.includes('SET "id" = DEFAULT'))).toBe(true);
  });

  it('builds IS NULL when the where value is null', async () => {
    addFkDef(baseDef);
    const executed: string[] = [];
    await onDelete('parent', { id: null }, async (sql) => {
      executed.push(sql);
      return { rows: [] };
    });
    expect(executed.some((s) => s.includes('"id" IS NULL'))).toBe(true);
  });
});

describe('onUpdate', () => {
  beforeEach(async () => {
    await removeFkDefs('child');
    await removeFkDefs('parent');
  });

  it('verifies outgoing FK values exist', async () => {
    addFkDef(baseDef);
    await expect(
      onUpdate('child', { parent_id: 2 }, { parent_id: 1 }, async () => ({ rows: [{}] })),
    ).resolves.toBeUndefined();
  });

  it('throws when an outgoing FK value is missing', async () => {
    addFkDef(baseDef);
    await expect(
      onUpdate('child', { parent_id: 2 }, { parent_id: 1 }, async () => ({ rows: [] })),
    ).rejects.toThrow(/violates foreign key constraint "fk_child_parent"/);
  });

  it('skips outgoing check when all FK columns are NULL', async () => {
    addFkDef(baseDef);
    let called = false;
    await onUpdate('child', { parent_id: null }, { parent_id: 1 }, async () => {
      called = true;
      return { rows: [] };
    });
    expect(called).toBe(false);
  });

  it('applies CASCADE on incoming FK update', async () => {
    addFkDef({ ...baseDef, onUpdate: 'CASCADE' });
    const executed: string[] = [];
    await onUpdate('parent', { id: 2 }, { id: 1 }, async (sql) => {
      executed.push(sql);
      return { rows: sql.startsWith('SELECT') ? [{ 1: 1 }] : [] };
    });
    expect(executed.some((s) => s.includes('UPDATE "child" SET "id" = 2'))).toBe(true);
  });

  it('applies SET NULL on incoming FK update', async () => {
    addFkDef({ ...baseDef, onUpdate: 'SET NULL' });
    const executed: string[] = [];
    await onUpdate('parent', { id: 2 }, { id: 1 }, async (sql) => {
      executed.push(sql);
      return { rows: sql.startsWith('SELECT') ? [{ 1: 1 }] : [] };
    });
    expect(executed.some((s) => s.includes('SET "id" = NULL'))).toBe(true);
  });

  it('applies SET DEFAULT on incoming FK update', async () => {
    addFkDef({ ...baseDef, onUpdate: 'SET DEFAULT' });
    const executed: string[] = [];
    await onUpdate('parent', { id: 2 }, { id: 1 }, async (sql) => {
      executed.push(sql);
      return { rows: sql.startsWith('SELECT') ? [{ 1: 1 }] : [] };
    });
    expect(executed.some((s) => s.includes('SET "id" = DEFAULT'))).toBe(true);
  });

  it('throws RESTRICT on incoming FK update when rows reference', async () => {
    addFkDef({ ...baseDef, onUpdate: 'RESTRICT' });
    await expect(
      onUpdate('parent', { id: 2 }, { id: 1 }, async () => ({ rows: [{}] })),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('does nothing on incoming FK when no referencing rows exist', async () => {
    addFkDef({ ...baseDef, onUpdate: 'RESTRICT' });
    let updated = false;
    await onUpdate('parent', { id: 2 }, { id: 1 }, async (sql) => {
      if (sql.startsWith('UPDATE')) updated = true;
      return { rows: [] };
    });
    expect(updated).toBe(false);
  });

  it('falls back to refColumn for outgoing FK when refColumns empty', async () => {
    addFkDef({ ...baseDef, columns: ['parent_id'], refColumns: [] });
    const executed: string[] = [];
    await onUpdate('child', { parent_id: 1 }, { parent_id: 0 }, async (sql) => {
      executed.push(sql);
      return { rows: [{ 1: 1 }] };
    });
    expect(executed.some((s) => s.includes('"parent_id" = 1'))).toBe(true);
  });

  it('builds IS NULL for a null outgoing column value', async () => {
    addFkDef({ ...baseDef, columns: ['a', 'b'], refColumns: ['x', 'y'] });
    const executed: string[] = [];
    await onUpdate('child', { a: 1, b: null }, { a: 1, b: 2 }, async (sql) => {
      executed.push(sql);
      return { rows: [{ 1: 1 }] };
    });
    expect(executed.some((s) => s.includes('"y" IS NULL'))).toBe(true);
  });

  it('builds IS NULL for a null old value in incoming FK', async () => {
    addFkDef({ ...baseDef, onUpdate: 'NO ACTION' });
    const executed: string[] = [];
    await onUpdate('parent', { id: 2 }, { id: null }, async (sql) => {
      executed.push(sql);
      return { rows: [] };
    });
    expect(executed.some((s) => s.includes('"id" IS NULL'))).toBe(true);
  });
});

describe('loadFromDB', () => {
  beforeEach(async () => {
    await removeFkDefs('child');
    await removeFkDefs('other');
  });

  it('loads definitions from an array of objects', async () => {
    await loadFromDB(async (sql) => {
      if (sql.startsWith('SELECT')) {
        return [
          {
            name: 'fk1',
            table_name: 'child',
            columns_json: '["a"]',
            ref_table: 'parent',
            ref_columns_json: '["b"]',
            on_delete: 'CASCADE',
            on_update: 'set null',
          },
        ];
      }
      return undefined;
    });
    const defs = getFkDefs('child');
    expect(defs).toHaveLength(1);
    expect(defs[0].onDelete).toBe('CASCADE');
    expect(defs[0].onUpdate).toBe('SET NULL');
  });

  it('loads definitions from array-tuple rows', async () => {
    await loadFromDB(async (sql) => {
      if (sql.startsWith('SELECT')) {
        return [['fk1', 'child', '["a"]', 'parent', '["b"]', 'NO ACTION', 'NO ACTION']];
      }
      return undefined;
    });
    expect(getFkDefs('child')).toHaveLength(1);
  });

  it('loads definitions from { rows } result', async () => {
    await loadFromDB(async (sql) => {
      if (sql.startsWith('SELECT')) {
        return { rows: [{ name: 'fk1', table_name: 'child', columns_json: '["a"]', ref_table: 'parent', ref_columns_json: '["b"]', on_delete: 'NO ACTION', on_update: 'NO ACTION' }] };
      }
      return undefined;
    });
    expect(getFkDefs('child')).toHaveLength(1);
  });

  it('defaults onDelete/onUpdate to NO ACTION when omitted', async () => {
    await loadFromDB(async (sql) => {
      if (sql.startsWith('SELECT')) {
        return [['fk1', 'child', '["a"]', 'parent', '["b"]', null, null]];
      }
      return undefined;
    });
    const defs = getFkDefs('child');
    expect(defs[0].onDelete).toBe('NO ACTION');
    expect(defs[0].onUpdate).toBe('NO ACTION');
  });

  it('swallows errors from a failing query', async () => {
    await expect(
      loadFromDB(async () => {
        throw new Error('db down');
      }),
    ).resolves.toBeUndefined();
  });

  it('handles a result that is neither an array nor has rows', async () => {
    await loadFromDB(async (sql) => {
      if (sql.startsWith('SELECT')) {
        return { unexpected: 'shape' };
      }
      return undefined;
    });
    expect(getFkDefs('child')).toEqual([]);
  });

  it('defaults columns/refColumns to [] when tuple indices are missing', async () => {
    await loadFromDB(async (sql) => {
      if (sql.startsWith('SELECT')) {
        // Tuple row with name/table but missing the JSON columns at indices 2/4.
        return [['fk1', 'child', undefined, 'parent', undefined]];
      }
      return undefined;
    });
    const defs = getFkDefs('child');
    expect(defs).toHaveLength(1);
    expect(defs[0].columns).toEqual([]);
    expect(defs[0].refColumns).toEqual([]);
  });
});
