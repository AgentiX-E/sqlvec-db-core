import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SequenceManager, DEFAULT_PLACEHOLDER } from '../query/SequenceManager';

/**
 * SequenceManager — PostgreSQL SEQUENCE and IDENTITY column management.
 *
 * These tests run against a real better-sqlite3 database so sequence state
 * transitions (last_value advance, cycling, boundary errors) are verified
 * end-to-end rather than against mocks.
 */

let db: Database.Database;
let sm: SequenceManager;

beforeEach(() => {
  db = new Database(':memory:');
  sm = new SequenceManager(db);
});

describe('createSequence', () => {
  it('creates a sequence with defaults', () => {
    const def = sm.createSequence('CREATE SEQUENCE s1');
    expect(def.name).toBe('s1');
    expect(def.increment).toBe(1);
    expect(def.minValue).toBe(1);
    expect(def.maxValue).toBe(2 ** 63 - 1);
    expect(def.startValue).toBe(1);
    expect(def.isCycling).toBe(false);
    // initial last_value = start - increment = 0, so first nextval is 1
    expect(def.lastValue).toBe(0);
  });

  it('creates a sequence with full options', () => {
    const def = sm.createSequence(
      'CREATE SEQUENCE s2 INCREMENT BY 5 MINVALUE 10 MAXVALUE 1000 START WITH 20 CACHE 7 CYCLE',
    );
    expect(def.increment).toBe(5);
    expect(def.minValue).toBe(10);
    expect(def.maxValue).toBe(1000);
    expect(def.startValue).toBe(20);
    expect(def.cacheSize).toBe(7);
    expect(def.isCycling).toBe(true);
    expect(def.lastValue).toBe(15); // 20 - 5
  });

  it('parses INCREMENT without BY', () => {
    const def = sm.createSequence('CREATE SEQUENCE s3 INCREMENT 3');
    expect(def.increment).toBe(3);
  });

  it('parses NO MINVALUE / NO MAXVALUE for a positive increment', () => {
    const def = sm.createSequence('CREATE SEQUENCE s4 NO MINVALUE NO MAXVALUE');
    expect(def.minValue).toBe(1);
    expect(def.maxValue).toBe(2 ** 63 - 1);
  });

  it('parses NO MINVALUE for a negative increment', () => {
    const def = sm.createSequence('CREATE SEQUENCE s5 INCREMENT -1 NO MINVALUE');
    expect(def.minValue).toBe(-(2 ** 63));
  });

  it('parses NO MAXVALUE for a negative increment (max defaults to -1)', () => {
    const def = sm.createSequence('CREATE SEQUENCE s5b INCREMENT -1 NO MAXVALUE');
    expect(def.maxValue).toBe(-1);
  });

  it('parses explicit MINVALUE/MAXVALUE for a negative increment', () => {
    const def = sm.createSequence('CREATE SEQUENCE s5c INCREMENT -1 MINVALUE -100 MAXVALUE 100');
    expect(def.minValue).toBe(-100);
    expect(def.maxValue).toBe(100);
  });

  it('strips quotes from the sequence name', () => {
    const def = sm.createSequence('CREATE SEQUENCE "myschema"."s6"');
    expect(def.name).toBe('myschema.s6');
  });

  it('supports IF NOT EXISTS (idempotent)', () => {
    sm.createSequence('CREATE SEQUENCE s7');
    const again = sm.createSequence('CREATE SEQUENCE IF NOT EXISTS s7');
    expect(again.name).toBe('s7');
  });

  it('throws when the sequence already exists without IF NOT EXISTS', () => {
    sm.createSequence('CREATE SEQUENCE s8');
    expect(() => sm.createSequence('CREATE SEQUENCE s8')).toThrow(/already exists/);
  });

  it('throws for an invalid statement', () => {
    expect(() => sm.createSequence('NOT A SEQUENCE')).toThrow(/Invalid CREATE SEQUENCE/);
  });
});

describe('dropSequence', () => {
  it('drops an existing sequence and returns true', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    expect(sm.dropSequence('DROP SEQUENCE s1')).toBe(true);
    expect(sm.getSequenceDef('s1')).toBeNull();
  });

  it('supports IF EXISTS and returns false when missing', () => {
    expect(sm.dropSequence('DROP SEQUENCE IF EXISTS nope')).toBe(false);
  });

  it('throws when dropping a missing sequence without IF EXISTS', () => {
    expect(() => sm.dropSequence('DROP SEQUENCE nope')).toThrow(/does not exist/);
  });

  it('throws for an invalid statement', () => {
    expect(() => sm.dropSequence('DROP TABLE t')).toThrow(/Invalid DROP SEQUENCE/);
  });
});

describe('nextVal / currVal / setVal', () => {
  it('advances a sequence by the increment', () => {
    sm.createSequence('CREATE SEQUENCE s1 START WITH 1');
    expect(sm.nextVal('s1')).toBe(1);
    expect(sm.nextVal('s1')).toBe(2);
    expect(sm.currVal('s1')).toBe(2);
  });

  it('resolves a regclass-qualified name', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    expect(sm.nextVal("'s1'::regclass")).toBe(1);
  });

  it('throws when the sequence does not exist', () => {
    expect(() => sm.nextVal('nope')).toThrow(/does not exist/);
    expect(() => sm.currVal('nope')).toThrow(/does not exist/);
    expect(() => sm.setVal('nope', 1)).toThrow(/does not exist/);
  });

  it('setVal with isCalled=true sets last_value so next nextval is value+inc', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    sm.setVal('s1', 100, true);
    expect(sm.nextVal('s1')).toBe(101);
  });

  it('setVal with isCalled=false sets last_value so next nextval is value', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    sm.setVal('s1', 100, false);
    expect(sm.nextVal('s1')).toBe(100);
  });

  it('reaches maximum and throws for a non-cycling sequence', () => {
    sm.createSequence('CREATE SEQUENCE s1 START WITH 1 MAXVALUE 2');
    expect(sm.nextVal('s1')).toBe(1);
    expect(sm.nextVal('s1')).toBe(2);
    expect(() => sm.nextVal('s1')).toThrow(/maximum/);
  });

  it('cycles back to minValue for a cycling sequence at max', () => {
    sm.createSequence('CREATE SEQUENCE s1 START WITH 1 MAXVALUE 2 MINVALUE 1 CYCLE');
    expect(sm.nextVal('s1')).toBe(1);
    expect(sm.nextVal('s1')).toBe(2);
    expect(sm.nextVal('s1')).toBe(1); // wraps
  });

  it('handles a negative increment (decrementing) sequence', () => {
    sm.createSequence('CREATE SEQUENCE s1 INCREMENT -1 START WITH 10 MINVALUE 1');
    expect(sm.nextVal('s1')).toBe(10);
    expect(sm.nextVal('s1')).toBe(9);
  });

  it('throws at minimum for a non-cycling negative sequence', () => {
    sm.createSequence('CREATE SEQUENCE s1 INCREMENT -1 START WITH 2 MINVALUE 1');
    expect(sm.nextVal('s1')).toBe(2);
    expect(sm.nextVal('s1')).toBe(1);
    expect(() => sm.nextVal('s1')).toThrow(/minimum/);
  });

  it('wraps to maxValue for a cycling negative sequence at min', () => {
    sm.createSequence('CREATE SEQUENCE s1 INCREMENT -1 START WITH 2 MINVALUE 1 MAXVALUE 5 CYCLE');
    expect(sm.nextVal('s1')).toBe(2);
    expect(sm.nextVal('s1')).toBe(1);
    expect(sm.nextVal('s1')).toBe(5); // wraps to max
  });
});

describe('alterSequence', () => {
  it('changes increment', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    const def = sm.alterSequence('ALTER SEQUENCE s1 INCREMENT BY 3');
    expect(def.increment).toBe(3);
  });

  it('changes min/max and cache', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    const def = sm.alterSequence('ALTER SEQUENCE s1 MINVALUE 5 MAXVALUE 500 CACHE 10');
    expect(def.minValue).toBe(5);
    expect(def.maxValue).toBe(500);
    expect(def.cacheSize).toBe(10);
  });

  it('applies NO MINVALUE / NO MAXVALUE', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    const def = sm.alterSequence('ALTER SEQUENCE s1 NO MINVALUE NO MAXVALUE');
    expect(def.minValue).toBe(1);
    expect(def.maxValue).toBe(2 ** 63 - 1);
  });

  it('restarts without a value (reset to start)', () => {
    sm.createSequence('CREATE SEQUENCE s1 START WITH 10');
    sm.nextVal('s1'); // advance
    sm.nextVal('s1');
    const def = sm.alterSequence('ALTER SEQUENCE s1 RESTART');
    expect(sm.nextVal('s1')).toBe(10); // back to start
    expect(def.startValue).toBe(10);
  });

  it('restarts with a value', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    sm.alterSequence('ALTER SEQUENCE s1 RESTART WITH 50');
    expect(sm.nextVal('s1')).toBe(50);
  });

  it('enables and disables cycling', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    expect(sm.alterSequence('ALTER SEQUENCE s1 CYCLE').isCycling).toBe(true);
    expect(sm.alterSequence('ALTER SEQUENCE s1 NO CYCLE').isCycling).toBe(false);
  });

  it('throws for an invalid statement', () => {
    expect(() => sm.alterSequence('ALTER TABLE t x')).toThrow(/Invalid ALTER SEQUENCE/);
  });

  it('applies NO MINVALUE / NO MAXVALUE to a negative-increment sequence', () => {
    sm.createSequence('CREATE SEQUENCE s1 INCREMENT -1');
    const def = sm.alterSequence('ALTER SEQUENCE s1 NO MINVALUE NO MAXVALUE');
    expect(def.minValue).toBe(-(2 ** 63));
    expect(def.maxValue).toBe(-1);
  });

  it('applies negative MINVALUE / MAXVALUE via ALTER', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    const def = sm.alterSequence('ALTER SEQUENCE s1 MINVALUE -500 MAXVALUE -5');
    expect(def.minValue).toBe(-500);
    expect(def.maxValue).toBe(-5);
  });

  it('restarts with a negative value', () => {
    sm.createSequence('CREATE SEQUENCE s1');
    sm.alterSequence('ALTER SEQUENCE s1 RESTART WITH -10');
    expect(sm.nextVal('s1')).toBe(-10);
  });

  it('is a no-op when there are no recognisable options (returns current def)', () => {
    sm.createSequence('CREATE SEQUENCE s1 INCREMENT 2');
    const def = sm.alterSequence('ALTER SEQUENCE s1');
    expect(def.increment).toBe(2); // unchanged
  });
});

describe('listSequences', () => {
  it('returns all sequences sorted by name', () => {
    sm.createSequence('CREATE SEQUENCE b');
    sm.createSequence('CREATE SEQUENCE a');
    const names = sm.listSequences().map((s) => s.name);
    expect(names).toEqual(['a', 'b']);
  });

  it('returns an empty list initially', () => {
    expect(sm.listSequences()).toEqual([]);
  });
});

describe('parseIdentityColumn', () => {
  it('parses GENERATED ALWAYS AS IDENTITY', () => {
    const info = sm.parseIdentityColumn('INTEGER GENERATED ALWAYS AS IDENTITY');
    expect(info).toEqual({ always: true, sequenceOptions: undefined });
  });

  it('parses GENERATED BY DEFAULT AS IDENTITY with options', () => {
    const info = sm.parseIdentityColumn('BIGINT GENERATED BY DEFAULT AS IDENTITY (START WITH 100 INCREMENT BY 5)');
    expect(info!.always).toBe(false);
    expect(info!.sequenceOptions).toBe('START WITH 100 INCREMENT BY 5');
  });

  it('returns null for a non-identity column', () => {
    expect(sm.parseIdentityColumn('INTEGER')).toBeNull();
  });
});

describe('identity sequence lifecycle', () => {
  it('builds a lowercase sequence name from table and column', () => {
    expect(SequenceManager.buildIdentitySequenceName('Users', 'ID')).toBe('users_id_seq');
  });

  it('creates an identity sequence and registers metadata', () => {
    const seqName = sm.createIdentitySequence('users', 'id', { always: true });
    expect(seqName).toBe('users_id_seq');
    const info = sm.getIdentityColumnInfo('users', 'id')!;
    expect(info).toBeDefined();
    expect(info.sequenceName).toBe('users_id_seq');
    expect(info.always).toBe(true);
  });

  it('createIdentitySequence is idempotent for an existing column', () => {
    sm.createIdentitySequence('users', 'id', { always: true });
    const again = sm.createIdentitySequence('users', 'id', { always: false });
    expect(again).toBe('users_id_seq');
    expect(sm.getIdentityColumnInfo('users', 'id')!.always).toBe(true);
  });

  it('passes sequence options through to the underlying sequence', () => {
    const seqName = sm.createIdentitySequence('users', 'id', {
      always: true,
      sequenceOptions: 'START WITH 100 INCREMENT BY 5',
    });
    expect(seqName).toBe('users_id_seq');
    expect(sm.nextIdentityVal('users', 'id')).toBe(100);
    expect(sm.nextIdentityVal('users', 'id')).toBe(105);
  });

  it('lists identity columns for a table', () => {
    sm.createIdentitySequence('users', 'id', { always: true });
    sm.createIdentitySequence('users', 'email', { always: false });
    const cols = sm.listIdentityColumns('users');
    expect(cols.map((c) => c.columnName)).toEqual(['email', 'id']);
  });

  it('nextIdentityVal advances the identity sequence', () => {
    sm.createIdentitySequence('users', 'id', { always: true });
    expect(sm.nextIdentityVal('users', 'id')).toBe(1);
    expect(sm.nextIdentityVal('users', 'id')).toBe(2);
  });

  it('drops an identity sequence and metadata', () => {
    sm.createIdentitySequence('users', 'id', { always: true });
    expect(sm.dropIdentitySequence('users', 'id')).toBe(true);
    expect(sm.getIdentityColumnInfo('users', 'id')).toBeNull();
    expect(sm.getSequenceDef('users_id_seq')).toBeNull();
  });

  it('dropIdentitySequence returns false when no identity column', () => {
    expect(sm.dropIdentitySequence('users', 'nope')).toBe(false);
  });
});

describe('validateIdentityInsert', () => {
  it('allows a null value for GENERATED ALWAYS', () => {
    expect(() => sm.validateIdentityInsert({ always: true }, null)).not.toThrow();
  });

  it('allows DEFAULT placeholder for GENERATED ALWAYS', () => {
    expect(() => sm.validateIdentityInsert({ always: true }, DEFAULT_PLACEHOLDER)).not.toThrow();
  });

  it('throws for an explicit value on GENERATED ALWAYS', () => {
    expect(() => sm.validateIdentityInsert({ always: true }, 5)).toThrow(/GENERATED ALWAYS/);
  });

  it('allows any value for GENERATED BY DEFAULT', () => {
    expect(() => sm.validateIdentityInsert({ always: false }, 5)).not.toThrow();
  });
});

describe('parseInsertOverriding', () => {
  it('parses OVERRIDING SYSTEM VALUE after the column list', () => {
    const r = sm.parseInsertOverriding('INSERT INTO t (id) OVERRIDING SYSTEM VALUE VALUES (5)');
    expect(r.kind).toBe('SYSTEM');
    expect(r.overridden).toBe(true);
    expect(r.cleanSql).toBe('INSERT INTO t (id) VALUES (5)');
  });

  it('parses OVERRIDING USER VALUE after the table name', () => {
    const r = sm.parseInsertOverriding('INSERT INTO t OVERRIDING USER VALUE (id) VALUES (5)');
    expect(r.kind).toBe('USER');
    expect(r.overridden).toBe(true);
  });

  it('parses OVERRIDING at the end', () => {
    const r = sm.parseInsertOverriding('INSERT INTO t (id) VALUES (5) OVERRIDING SYSTEM VALUE');
    expect(r.kind).toBe('SYSTEM');
    expect(r.overridden).toBe(true);
  });

  it('returns NONE for a plain INSERT', () => {
    const r = sm.parseInsertOverriding('INSERT INTO t (id) VALUES (5)');
    expect(r.kind).toBe('NONE');
    expect(r.overridden).toBe(false);
    expect(r.cleanSql).toBe('INSERT INTO t (id) VALUES (5)');
  });
});

describe('rewriteIdentityInsert', () => {
  it('returns the SQL unchanged when there are no identity columns', () => {
    const sql = 'INSERT INTO t (name) VALUES (1)';
    expect(sm.rewriteIdentityInsert(sql, 't')).toEqual({ sql, identityValues: new Map() });
  });

  it('generates a nextval for a DEFAULT on GENERATED ALWAYS', () => {
    sm.createIdentitySequence('users', 'id', { always: true });
    const { sql, identityValues } = sm.rewriteIdentityInsert(
      'INSERT INTO users (id, name) VALUES (DEFAULT, \'Alice\')',
      'users',
    );
    expect(identityValues.get('id')).toBe(1);
    expect(sql).toContain('1');
  });

  it('throws for an explicit value on GENERATED ALWAYS without OVERRIDING', () => {
    sm.createIdentitySequence('users', 'id', { always: true });
    expect(() =>
      sm.rewriteIdentityInsert("INSERT INTO users (id) VALUES (5)", 'users'),
    ).toThrow(/GENERATED ALWAYS/);
  });

  it('allows an explicit value with OVERRIDING SYSTEM VALUE', () => {
    sm.createIdentitySequence('users', 'id', { always: true });
    const { sql, identityValues } = sm.rewriteIdentityInsert(
      'INSERT INTO users (id) OVERRIDING SYSTEM VALUE VALUES (42)',
      'users',
    );
    expect(identityValues.get('id')).toBe(42);
    expect(sql).toContain('42');
  });

  it('generates nextval for DEFAULT on GENERATED BY DEFAULT', () => {
    sm.createIdentitySequence('users', 'id', { always: false });
    const { identityValues } = sm.rewriteIdentityInsert(
      "INSERT INTO users (id, name) VALUES (DEFAULT, 'Bob')",
      'users',
    );
    expect(identityValues.get('id')).toBe(1);
  });

  it('allows an explicit value on GENERATED BY DEFAULT', () => {
    sm.createIdentitySequence('users', 'id', { always: false });
    const { sql, identityValues } = sm.rewriteIdentityInsert(
      'INSERT INTO users (id) VALUES (99)',
      'users',
    );
    expect(identityValues.get('id')).toBe(99);
    expect(sql).toContain('99');
  });

  it('ignores user value with OVERRIDING USER VALUE on GENERATED BY DEFAULT', () => {
    sm.createIdentitySequence('users', 'id', { always: false });
    const { identityValues } = sm.rewriteIdentityInsert(
      'INSERT INTO users (id) OVERRIDING USER VALUE VALUES (99)',
      'users',
    );
    // nextval generated, user value 99 ignored
    expect(identityValues.get('id')).toBe(1);
  });

  it('returns the SQL unchanged when there is no column list / VALUES', () => {
    sm.createIdentitySequence('users', 'id', { always: true });
    const { sql, identityValues } = sm.rewriteIdentityInsert(
      'INSERT INTO users SELECT * FROM other',
      'users',
    );
    expect(sql).toContain('SELECT * FROM other');
    expect(identityValues.size).toBe(0);
  });
});

describe('alterIdentityColumn', () => {
  beforeEach(() => {
    sm.createIdentitySequence('users', 'id', { always: true });
  });

  it('throws for a non-identity column', () => {
    expect(() => sm.alterIdentityColumn('users', 'nope', 'RESTART')).toThrow(/not an identity column/);
  });

  it('changes GENERATED strategy', () => {
    const info = sm.alterIdentityColumn('users', 'id', 'SET GENERATED BY DEFAULT');
    expect(info.always).toBe(false);
  });

  it('sets GENERATED ALWAYS strategy (the true branch)', () => {
    sm.createIdentitySequence('users', 'id2', { always: false });
    const info = sm.alterIdentityColumn('users', 'id2', 'SET GENERATED ALWAYS');
    expect(info.always).toBe(true);
  });

  it('restarts the identity sequence', () => {
    sm.nextIdentityVal('users', 'id'); // advance to 1
    sm.nextIdentityVal('users', 'id'); // advance to 2
    sm.alterIdentityColumn('users', 'id', 'RESTART WITH 100');
    expect(sm.nextIdentityVal('users', 'id')).toBe(100);
  });

  it('restarts without a value', () => {
    sm.nextIdentityVal('users', 'id');
    sm.nextIdentityVal('users', 'id');
    sm.alterIdentityColumn('users', 'id', 'RESTART');
    expect(sm.nextIdentityVal('users', 'id')).toBe(1);
  });

  it('applies SET INCREMENT / MAXVALUE / MINVALUE / CACHE / CYCLE', () => {
    sm.alterIdentityColumn('users', 'id', 'SET INCREMENT BY 10');
    sm.alterIdentityColumn('users', 'id', 'SET MAXVALUE 5000');
    sm.alterIdentityColumn('users', 'id', 'SET NO MAXVALUE');
    sm.alterIdentityColumn('users', 'id', 'SET MINVALUE 5');
    sm.alterIdentityColumn('users', 'id', 'SET NO MINVALUE');
    sm.alterIdentityColumn('users', 'id', 'SET CACHE 3');
    sm.alterIdentityColumn('users', 'id', 'SET CYCLE');
    sm.alterIdentityColumn('users', 'id', 'SET NO CYCLE');
    expect(sm.getIdentityColumnInfo('users', 'id')).toBeDefined();
  });

  it('applies SET START WITH', () => {
    sm.alterIdentityColumn('users', 'id', 'SET START WITH 200');
    expect(sm.nextIdentityVal('users', 'id')).toBe(200);
  });

  it('throws for an unsupported action', () => {
    expect(() => sm.alterIdentityColumn('users', 'id', 'BOGUS ACTION')).toThrow(/Unsupported ALTER IDENTITY/);
  });
});
