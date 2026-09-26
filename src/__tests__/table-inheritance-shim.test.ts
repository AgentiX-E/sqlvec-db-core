import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  detectInherits,
  extractInheritsTables,
  initInheritanceMeta,
  registerInheritance,
  unregisterInheritance,
  getParentTable,
  isChildTable,
  getParentTables,
  getChildTables,
  getAllDescendants,
  resolveInheritance,
  getTableColumns,
  buildCreateTableWithParentColumns,
  rewriteCreateTableInherits,
  rewriteSelectForInheritance,
  rewriteSelectOnly,
  detectAlterInherit,
  handleAlterInherit,
  addMissingParentColumns,
  getCheckConstraints,
  getPgInheritsRows,
  INHERITANCE_META_TABLE,
} from '../query/TableInheritanceShim';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

describe('detectInherits', () => {
  it('returns false for non-string or empty input', () => {
    expect(detectInherits('' as any)).toBe(false);
    expect(detectInherits(undefined as any)).toBe(false);
  });

  it('returns false for a CREATE TABLE without INHERITS', () => {
    expect(detectInherits('CREATE TABLE t (a INT)')).toBe(false);
  });

  it('returns true for CREATE TABLE ... INHERITS', () => {
    expect(detectInherits('CREATE TABLE child (age INT) INHERITS (parent)')).toBe(true);
  });

  it('returns false when INHERITS appears but not after CREATE TABLE', () => {
    expect(detectInherits('SELECT * FROM INHERITS (x)')).toBe(false);
  });
});

describe('extractInheritsTables', () => {
  it('extracts child and single parent', () => {
    const r = extractInheritsTables('CREATE TABLE child (age INT) INHERITS (parent)');
    expect(r).toEqual({ childTable: 'child', parentTables: ['parent'] });
  });

  it('extracts multiple parents', () => {
    const r = extractInheritsTables('CREATE TABLE child (age INT) INHERITS (p1, p2, p3)');
    expect(r).toEqual({ childTable: 'child', parentTables: ['p1', 'p2', 'p3'] });
  });

  it('extracts quoted table names (including spaces)', () => {
    const r = extractInheritsTables('CREATE TABLE "Child Table" (age INT) INHERITS ("Parent Table")');
    expect(r).toEqual({ childTable: 'Child Table', parentTables: ['Parent Table'] });
  });

  it('handles doubled double-quotes inside a quoted identifier', () => {
    const r = extractInheritsTables('CREATE TABLE c (age INT) INHERITS ("a""b")');
    expect(r).toEqual({ childTable: 'c', parentTables: ['a"b'] });
  });

  it('does not let a `)` inside a DEFAULT string close the column block early', () => {
    const r = extractInheritsTables("CREATE TABLE c (name TEXT DEFAULT ')') INHERITS (parent)");
    expect(r).toEqual({ childTable: 'c', parentTables: ['parent'] });
  });

  it('handles IF NOT EXISTS', () => {
    const r = extractInheritsTables('CREATE TABLE IF NOT EXISTS child (age INT) INHERITS (parent)');
    expect(r).toEqual({ childTable: 'child', parentTables: ['parent'] });
  });

  it('returns null for unbalanced parens', () => {
    expect(extractInheritsTables('CREATE TABLE child (age INT INHERITS (parent)')).toBeNull();
  });

  it('returns null for non-CREATE-TABLE input', () => {
    expect(extractInheritsTables('SELECT * FROM t')).toBeNull();
  });

  it('returns null when INHERITS appears inside the column block instead of after it', () => {
    // detectInherits sees `INHERITS (`, but the clause is not after the
    // closing paren of the column block → extraction fails cleanly.
    expect(extractInheritsTables('CREATE TABLE child (a TEXT, INHERITS (p))')).toBeNull();
  });

  it('returns null when preamble does not match (no column paren)', () => {
    expect(extractInheritsTables('CREATE TABLE child INHERITS (parent)')).toBeNull();
  });

  it('returns null when INHERITS clause is missing', () => {
    expect(extractInheritsTables('CREATE TABLE child (age INT)')).toBeNull();
  });
});

describe('meta table management', () => {
  it('initialises the meta table', () => {
    initInheritanceMeta(db);
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(INHERITANCE_META_TABLE);
    expect(row).toBeTruthy();
  });

  it('register + getParentTable', () => {
    registerInheritance(db, 'child', 'parent');
    expect(getParentTable(db, 'child')).toBe('parent');
    expect(getParentTable(db, 'nonexistent')).toBeNull();
  });

  it('isChildTable', () => {
    registerInheritance(db, 'child', 'parent');
    expect(isChildTable(db, 'child')).toBe(true);
    expect(isChildTable(db, 'parent')).toBe(false);
  });

  it('multiple parents ordered by seqno', () => {
    registerInheritance(db, 'child', 'p2', 2);
    registerInheritance(db, 'child', 'p1', 1);
    expect(getParentTables(db, 'child')).toEqual(['p1', 'p2']);
  });

  it('getChildTables', () => {
    registerInheritance(db, 'c1', 'parent');
    registerInheritance(db, 'c2', 'parent');
    expect(getChildTables(db, 'parent')).toEqual(['c1', 'c2']);
  });

  it('unregister specific parent vs all parents', () => {
    registerInheritance(db, 'child', 'p1');
    registerInheritance(db, 'child', 'p2');
    expect(unregisterInheritance(db, 'child', 'p1')).toBe(true);
    expect(getParentTables(db, 'child')).toEqual(['p2']);
    expect(unregisterInheritance(db, 'child')).toBe(true);
    expect(getParentTables(db, 'child')).toEqual([]);
    expect(unregisterInheritance(db, 'child')).toBe(false);
  });

  it('is case-insensitive', () => {
    registerInheritance(db, 'Child', 'Parent');
    expect(getParentTable(db, 'CHILD')).toBe('parent');
    expect(getChildTables(db, 'PARENT')).toEqual(['child']);
  });
});

describe('descendant resolution', () => {
  it('resolves a multi-level hierarchy', () => {
    registerInheritance(db, 'child', 'parent');
    registerInheritance(db, 'grandchild', 'child');
    expect(getAllDescendants(db, 'parent')).toEqual(['child', 'grandchild']);
    expect(resolveInheritance(db, 'parent')).toEqual(['parent', 'child', 'grandchild']);
    expect(resolveInheritance(db, 'grandchild')).toEqual(['grandchild']);
  });

  it('does not loop on cyclic references', () => {
    registerInheritance(db, 'a', 'b');
    registerInheritance(db, 'b', 'a');
    const descendants = getAllDescendants(db, 'a');
    expect(descendants.length).toBeLessThanOrEqual(2);
    expect(new Set(descendants).size).toBe(descendants.length);
  });
});

describe('getTableColumns', () => {
  it('returns empty array for null db', () => {
    expect(getTableColumns(null as any, 't')).toEqual([]);
  });

  it('reads real columns', () => {
    db.exec(`CREATE TABLE t (id INTEGER NOT NULL, name TEXT DEFAULT 'x')`);
    const cols = getTableColumns(db, 't');
    expect(cols).toHaveLength(2);
    expect(cols[0]).toEqual({ name: 'id', type: 'INTEGER', notnull: true, dflt_value: null });
    expect(cols[1].name).toBe('name');
    expect(cols[1].dflt_value).toBe("'x'");
  });

  it('escapes single quotes in table name', () => {
    db.exec(`CREATE TABLE "weird'name" (a INT)`);
    expect(getTableColumns(db, "weird'name")).toHaveLength(1);
  });

  it('defaults a typeless column to TEXT', () => {
    db.exec(`CREATE TABLE t (a)`);
    const cols = getTableColumns(db, 't');
    expect(cols[0].type).toBe('TEXT');
  });
});

describe('buildCreateTableWithParentColumns', () => {
  it('merges parent columns under child columns', () => {
    db.exec(`CREATE TABLE parent (id INT, name TEXT)`);
    const sql = buildCreateTableWithParentColumns(
      db,
      'child',
      [{ name: 'name', type: 'TEXT', notnull: true, dflt_value: null }],
      ['parent'],
    );
    expect(sql).toBe('CREATE TABLE "child" ("id" INTEGER, "name" TEXT NOT NULL)');
  });

  it('child column overrides parent column of same name', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    const sql = buildCreateTableWithParentColumns(
      db,
      'child',
      [{ name: 'id', type: 'TEXT', notnull: false, dflt_value: null }],
      ['parent'],
    );
    expect(sql).toBe('CREATE TABLE "child" ("id" TEXT)');
  });

  it('propagates DEFAULT value', () => {
    db.exec(`CREATE TABLE parent (id INT DEFAULT 0)`);
    const sql = buildCreateTableWithParentColumns(db, 'child', [], ['parent']);
    expect(sql).toContain('DEFAULT 0');
  });

  it('keeps only the first occurrence when multiple parents share a column', () => {
    db.exec(`CREATE TABLE p1 (id INT)`);
    db.exec(`CREATE TABLE p2 (id TEXT)`);
    const sql = buildCreateTableWithParentColumns(db, 'child', [], ['p1', 'p2']);
    // id appears only once (from p1, INTEGER)
    expect(sql.match(/\"id\"/g)).toHaveLength(1);
    expect(sql).toContain('"id" INTEGER');
  });
});

describe('rewriteCreateTableInherits', () => {
  it('strips INHERITS when no db', () => {
    const r = rewriteCreateTableInherits('CREATE TABLE child (age INT) INHERITS (parent)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE TABLE child (age INT)');
    expect(r.childTable).toBe('child');
    expect(r.parentTables).toEqual(['parent']);
  });

  it('returns unchanged when no INHERITS', () => {
    const r = rewriteCreateTableInherits('CREATE TABLE t (a INT)');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('CREATE TABLE t (a INT)');
  });

  it('merges parent columns when db provided', () => {
    db.exec(`CREATE TABLE parent (id INT, name TEXT)`);
    const r = rewriteCreateTableInherits('CREATE TABLE child (age INT) INHERITS (parent)', db);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('"id"');
    expect(r.sql).toContain('"name"');
    expect(r.sql).toContain('"age"');
  });
});

describe('rewriteSelectForInheritance', () => {
  it('returns unchanged when no db or empty', () => {
    expect(rewriteSelectForInheritance('SELECT * FROM parent', null as any)).toBe('SELECT * FROM parent');
    expect(rewriteSelectForInheritance('', db)).toBe('');
  });

  it('returns unchanged when table has no children', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    expect(rewriteSelectForInheritance('SELECT * FROM parent', db)).toBe('SELECT * FROM parent');
  });

  it('expands children via UNION ALL', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    db.exec(`CREATE TABLE child (id INT)`);
    registerInheritance(db, 'child', 'parent');
    const r = rewriteSelectForInheritance('SELECT * FROM parent', db);
    expect(r).toContain('UNION ALL');
    expect(r).toContain('FROM "parent"');
    expect(r).toContain('FROM "child"');
  });

  it('does not expand children when ONLY modifier present', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    db.exec(`CREATE TABLE child (id INT)`);
    registerInheritance(db, 'child', 'parent');
    expect(rewriteSelectForInheritance('SELECT * FROM ONLY parent', db)).toBe('SELECT * FROM ONLY parent');
  });

  it('does not mistake a `FROM` inside a string literal for a real FROM clause', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    db.exec(`CREATE TABLE child (id INT)`);
    registerInheritance(db, 'child', 'parent');
    expect(rewriteSelectForInheritance("SELECT 'FROM parent' AS x FROM other", db)).toBe(
      "SELECT 'FROM parent' AS x FROM other",
    );
  });

  it('preserves alias and trailing clauses', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    db.exec(`CREATE TABLE child (id INT)`);
    registerInheritance(db, 'child', 'parent');
    const r = rewriteSelectForInheritance("SELECT * FROM parent AS p WHERE x = 'FROM child'", db);
    expect(r).toContain('AS p');
    expect(r).toContain("WHERE x = 'FROM child'");
  });

  it('does not rewrite a subquery inner FROM when the outer table has no children', () => {
    db.exec(`CREATE TABLE inner (id INT)`);
    db.exec(`CREATE TABLE sub (id INT)`);
    expect(rewriteSelectForInheritance('SELECT * FROM (SELECT * FROM inner) AS sub', db)).toBe(
      'SELECT * FROM (SELECT * FROM inner) AS sub',
    );
  });
});

describe('rewriteSelectOnly', () => {
  it('returns unchanged for empty', () => {
    expect(rewriteSelectOnly('')).toBe('');
  });

  it('strips ONLY', () => {
    expect(rewriteSelectOnly('SELECT * FROM ONLY parent')).toBe('SELECT * FROM parent');
  });

  it('returns unchanged when no ONLY', () => {
    expect(rewriteSelectOnly('SELECT * FROM parent')).toBe('SELECT * FROM parent');
  });
});

describe('detectAlterInherit / handleAlterInherit', () => {
  it('detects INHERIT and NO INHERIT', () => {
    expect(detectAlterInherit('ALTER TABLE child INHERIT parent')).toBe(true);
    expect(detectAlterInherit('ALTER TABLE child NO INHERIT parent')).toBe(true);
    expect(detectAlterInherit('SELECT 1')).toBe(false);
  });

  it('parses action without db', () => {
    const r = handleAlterInherit('ALTER TABLE child INHERIT parent', null as any);
    expect(r.action).toBe('INHERIT');
    expect(r.childTable).toBe('child');
    expect(r.parentTable).toBe('parent');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBeNull();
  });

  it('registers inheritance on INHERIT with db', () => {
    db.exec(`CREATE TABLE parent (id INT, name TEXT)`);
    db.exec(`CREATE TABLE child (id INT)`);
    const r = handleAlterInherit('ALTER TABLE child INHERIT parent', db);
    expect(r.action).toBe('INHERIT');
    expect(isChildTable(db, 'child')).toBe(true);
    // parent column `name` should have been added to child
    const cols = getTableColumns(db, 'child');
    expect(cols.map(c => c.name)).toContain('name');
  });

  it('unregisters inheritance on NO INHERIT with db', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    db.exec(`CREATE TABLE child (id INT)`);
    registerInheritance(db, 'child', 'parent');
    const r = handleAlterInherit('ALTER TABLE child NO INHERIT parent', db);
    expect(r.action).toBe('NO INHERIT');
    expect(isChildTable(db, 'child')).toBe(false);
  });

  it('handles quoted table names in ALTER', () => {
    db.exec(`CREATE TABLE "parent" (id INT)`);
    db.exec(`CREATE TABLE "child" (id INT)`);
    const r = handleAlterInherit('ALTER TABLE "child" INHERIT "parent"', db);
    expect(r.action).toBe('INHERIT');
    expect(r.childTable).toBe('child');
    expect(r.parentTable).toBe('parent');
  });

  it('returns unchanged for non-alter-inherit', () => {
    const r = handleAlterInherit('SELECT 1', db);
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });
});

describe('addMissingParentColumns', () => {
  it('adds only missing columns', () => {
    db.exec(`CREATE TABLE parent (id INT, name TEXT, age INT)`);
    db.exec(`CREATE TABLE child (id INT)`);
    addMissingParentColumns(db, 'child', 'parent');
    const cols = getTableColumns(db, 'child');
    expect(cols.map(c => c.name).sort()).toEqual(['age', 'id', 'name']);
  });
});

describe('getCheckConstraints', () => {
  it('parses simple CHECK constraints', () => {
    db.exec(`CREATE TABLE t (a INT CHECK (a > 0), b TEXT CHECK (b IS NOT NULL))`);
    expect(getCheckConstraints(db, 't')).toEqual(['a > 0', 'b IS NOT NULL']);
  });

  it('returns empty for missing table', () => {
    expect(getCheckConstraints(db, 'nope')).toEqual([]);
  });
});

describe('getPgInheritsRows', () => {
  it('returns inhrelid/inhparent/inhseqno rows', () => {
    registerInheritance(db, 'child', 'parent', 1);
    const rows = getPgInheritsRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inhseqno: 1 });
    expect(rows[0].inhrelid).toBeGreaterThan(0);
    expect(rows[0].inhparent).toBeGreaterThan(0);
  });

  it('filters by tableName', () => {
    registerInheritance(db, 'child', 'parent', 0);
    registerInheritance(db, 'unrelated', 'other', 0);
    const rows = getPgInheritsRows(db, 'child');
    expect(rows).toHaveLength(1);
  });

  it('returns empty for null db', () => {
    expect(getPgInheritsRows(null as any)).toEqual([]);
  });
});

describe('null-db guards', () => {
  it('initInheritanceMeta no-ops on null db', () => {
    expect(() => initInheritanceMeta(null as any)).not.toThrow();
  });

  it('registerInheritance no-ops on null db', () => {
    expect(() => registerInheritance(null as any, 'c', 'p')).not.toThrow();
  });

  it('unregisterInheritance returns false on null db', () => {
    expect(unregisterInheritance(null as any, 'c')).toBe(false);
  });

  it('getParentTable returns null on null db', () => {
    expect(getParentTable(null as any, 'c')).toBeNull();
  });

  it('getParentTables returns [] on null db', () => {
    expect(getParentTables(null as any, 'c')).toEqual([]);
  });

  it('getChildTables returns [] on null db', () => {
    expect(getChildTables(null as any, 'c')).toEqual([]);
  });

  it('addMissingParentColumns no-ops on null db', () => {
    expect(() => addMissingParentColumns(null as any, 'c', 'p')).not.toThrow();
  });

  it('getCheckConstraints returns [] on null db', () => {
    expect(getCheckConstraints(null as any, 'c')).toEqual([]);
  });
});

describe('error-path guards', () => {
  it('getParentTable returns null when meta table unavailable', () => {
    // db with a conflicting object named `_sqlvec_inheritance` (non-table)
    expect(getParentTable(db, 'x')).toBeNull();
  });

  it('getParentTables returns [] when meta table unavailable', () => {
    expect(getParentTables(db, 'x')).toEqual([]);
  });

  it('getTableColumns returns [] for a missing table', () => {
    expect(getTableColumns(db, 'nope')).toEqual([]);
  });

  it('getCheckConstraints returns [] for a missing table', () => {
    expect(getCheckConstraints(db, 'nope')).toEqual([]);
  });

  it('unregisterInheritance returns false when meta table unavailable', () => {
    expect(unregisterInheritance(db, 'nope')).toBe(false);
  });
});

describe('rewriteCreateTableInherits guards', () => {
  it('returns rewritten:false for empty input', () => {
    expect(rewriteCreateTableInherits('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteCreateTableInherits(undefined as any)).toEqual({ sql: '', rewritten: false });
  });

  it('returns unchanged when INHERITS detected but extract fails', () => {
    // INHERITS keyword present but unbalanced parens → extract returns null
    const r = rewriteCreateTableInherits('CREATE TABLE c (a INT INHERITS (parent)');
    expect(r.rewritten).toBe(false);
  });

  it('merges parent columns when db has parent table with no child column overlap', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    const r = rewriteCreateTableInherits('CREATE TABLE child (age INT) INHERITS (parent)', db);
    expect(r.sql).toContain('"id"');
    expect(r.sql).toContain('"age"');
  });

  it('preserves child columns with nested parens and string defaults when merging', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    const r = rewriteCreateTableInherits(
      "CREATE TABLE child (a INT DEFAULT (1+2), b TEXT DEFAULT 'x,y', c INT) INHERITS (parent)",
      db,
    );
    expect(r.sql).toContain('"a"');
    expect(r.sql).toContain('"b"');
    expect(r.sql).toContain('"c"');
    expect(r.sql).toContain('"id"');
  });

  it('handles an empty child column list when db provided', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    const r = rewriteCreateTableInherits('CREATE TABLE child () INHERITS (parent)', db);
    expect(r.sql).toContain('"id"');
  });

  it('returns unchanged for an unbalanced child column block', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    const r = rewriteCreateTableInherits('CREATE TABLE child (a INT INHERITS (parent)', db);
    // extraction fails on unbalanced parens → no rewrite
    expect(r.rewritten).toBe(false);
  });

  it('skips a child column whose definition cannot be parsed', () => {
    db.exec(`CREATE TABLE parent (id INT)`);
    // `1st_col` starts with a digit, so parseSimpleColumnDef returns null;
    // the well-formed `age INT` column must still be preserved.
    const r = rewriteCreateTableInherits('CREATE TABLE child (1st_col INT, age INT) INHERITS (parent)', db);
    expect(r.sql).toContain('"age"');
    expect(r.sql).toContain('"id"');
    expect(r.sql).not.toContain('"1st_col"');
  });
});

describe('handleAlterInherit guards', () => {
  it('returns rewritten:false for empty input', () => {
    expect(handleAlterInherit('', db)).toEqual({ sql: null, rewritten: false, action: null });
  });

  it('returns parsed action when db is null', () => {
    const r = handleAlterInherit('ALTER TABLE child NO INHERIT parent', null as any);
    expect(r.action).toBe('NO INHERIT');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBeNull();
  });

  it('returns rewritten:false when detect passes but match is empty table', () => {
    // ALTER TABLE ... INHERIT with no parent extracted → warn + no action
    const r = handleAlterInherit('ALTER TABLE INHERIT', db);
    expect(r.action).toBeNull();
  });
});

describe('detectInherits / detectAlterInherit edge input', () => {
  it('detectInherits handles non-string', () => {
    expect(detectInherits('' as any)).toBe(false);
  });

  it('detectInherits requires INHERITS followed by an open paren', () => {
    expect(detectInherits('CREATE TABLE child INHERITS parent')).toBe(false);
  });

  it('detectInherits ignores INHERITS inside a string literal', () => {
    expect(detectInherits("CREATE TABLE child (note TEXT DEFAULT 'INHERITS (x)')")).toBe(false);
    expect(detectInherits("CREATE TABLE child (note TEXT DEFAULT 'has INHERITS (x) inside')")).toBe(false);
  });

  it('detectInherits is true for a well-formed CREATE TABLE INHERITS', () => {
    expect(detectInherits('CREATE TABLE child (a INT) INHERITS (parent)')).toBe(true);
  });

  it('detectAlterInherit handles non-string', () => {
    expect(detectAlterInherit('' as any)).toBe(false);
  });
});
