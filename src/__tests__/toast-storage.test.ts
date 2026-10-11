import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ToastStorage } from '../storage/ToastStorage';

// @mongodb-js/zstd is an optional dependency and is NOT installed, so the
// dynamic import rejects and ToastStorage falls back to storing uncompressed.
// These tests exercise the non-zstd (fallback) path with real better-sqlite3.

describe('ToastStorage — small inline values (no zstd)', () => {
  let db: Database.Database;
  let toast: ToastStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    toast = new ToastStorage(db);
  });

  it('stores null as null', async () => {
    expect(await toast.store(null)).toBe(null);
    expect(await toast.store(undefined as any)).toBe(null);
  });

  it('stores a small string inline (unchanged)', async () => {
    expect(await toast.store('hello')).toBe('hello');
  });

  it('stores a small Buffer inline as base64', async () => {
    expect(await toast.store(Buffer.from('abc'))).toBe('YWJj');
  });

  it('stores an empty string inline', async () => {
    expect(await toast.store('')).toBe('');
  });

  it('stores an empty buffer inline', async () => {
    expect(await toast.store(Buffer.alloc(0))).toBe('');
  });
});

describe('ToastStorage — large values (chunk + TOAST pointer, no zstd)', () => {
  let db: Database.Database;
  let toast: ToastStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    toast = new ToastStorage(db);
  });

  it('stores a large string (>8KB) as a TOAST pointer', async () => {
    const res = await toast.store('x'.repeat(10000));
    expect(typeof res).toBe('string');
    expect(res!.startsWith('__TOAST:')).toBe(true);
    expect(res!.split(':')[4]).toBe('text');
  });

  it('round-trips a large string via retrieve', async () => {
    const big = 'y'.repeat(20000);
    const ptr = (await toast.store(big))!;
    expect(await toast.retrieve(ptr)).toBe(big);
  });

  it('round-trips a large Buffer (binary) via retrieve', async () => {
    const big = Buffer.alloc(20000, 7);
    const ptr = (await toast.store(big))!;
    expect(ptr.split(':')[4]).toBe('binary');

    const got = (await toast.retrieve(ptr)) as Buffer;
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got.equals(big)).toBe(true);
  });

  it('chunks values larger than 64KB into multiple chunks', async () => {
    const big = 'z'.repeat(200000);
    const ptr = (await toast.store(big))!;
    const numChunks = parseInt(ptr.split(':')[3], 10);
    expect(numChunks).toBeGreaterThan(1);

    const oid = ptr.split(':')[1];
    const rows = db.prepare('SELECT COUNT(*) AS c FROM __toast WHERE oid = ?').get(oid) as { c: number };
    expect(rows.c).toBe(numChunks);

    expect(await toast.retrieve(ptr)).toBe(big);
  });

  it('retrieves an inline (non-TOAST) pointer unchanged', async () => {
    expect(await toast.retrieve('plain text')).toBe('plain text');
    expect(await toast.retrieve('')).toBe('');
  });

  it('returns null for a null/undefined pointer', async () => {
    expect(await toast.retrieve(null)).toBe(null);
    expect(await toast.retrieve(undefined as any)).toBe(null);
  });

  it('returns null for a dangling pointer whose OID no longer exists', async () => {
    const big = 'dangling'.repeat(2000);
    const ptr = (await toast.store(big))!;
    const oid = ptr.split(':')[1];
    // Simulate GC removing the referenced chunks.
    db.prepare('DELETE FROM __toast WHERE oid = ?').run(oid);

    expect(await toast.retrieve(ptr)).toBe(null);
  });

  it('returns null for a pointer with an unknown OID', async () => {
    expect(await toast.retrieve('__TOAST:toast_nonexistent:100:1:text')).toBe(null);
  });

  it('returns the pointer unchanged for a malformed TOAST pointer (<4 parts)', async () => {
    expect(await toast.retrieve('__TOAST:onlythree')).toBe('__TOAST:onlythree');
  });

  it('defaults dataType to text when the pointer omits the 5th part', async () => {
    // pointer with exactly 4 parts → dataType falls back to 'text'
    const big = 'w'.repeat(9000);
    const full = (await toast.store(big))!;
    const parts = full.split(':');
    const fourPart = parts.slice(0, 4).join(':'); // "__TOAST:oid:len:numChunks"
    const got = await toast.retrieve(fourPart);
    expect(got).toBe(big);
  });
});

describe('ToastStorage — deleteOrphans GC (no zstd)', () => {
  it('returns 0 when no TOAST entries exist', () => {
    const db = new Database(':memory:');
    const toast = new ToastStorage(db);
    expect(toast.deleteOrphans()).toBe(0);
  });

  it('deletes orphaned OIDs and keeps referenced ones', async () => {
    const db = new Database(':memory:');
    const toast = new ToastStorage(db);
    db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT)');

    const keep = (await toast.store('a'.repeat(10000)))!;
    const drop = (await toast.store('b'.repeat(10000)))!;
    db.prepare('INSERT INTO docs (body) VALUES (?)').run(keep);

    expect(toast.deleteOrphans()).toBe(1);

    const keepOid = keep.split(':')[1];
    const dropOid = drop.split(':')[1];
    expect(db.prepare('SELECT COUNT(*) AS c FROM __toast WHERE oid = ?').get(keepOid)).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM __toast WHERE oid = ?').get(dropOid)).toMatchObject({ c: 0 });
  });

  it('deletes all OIDs when none are referenced', async () => {
    const db = new Database(':memory:');
    const toast = new ToastStorage(db);
    db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT)');
    await toast.store('c'.repeat(10000));
    await toast.store('d'.repeat(10000));
    expect(toast.deleteOrphans()).toBe(2);
  });

  it('keeps OIDs referenced in non-primary text columns', async () => {
    const db = new Database(':memory:');
    const toast = new ToastStorage(db);
    db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, note TEXT, extra VARCHAR)');
    const p1 = (await toast.store('e'.repeat(10000)))!;
    db.prepare('INSERT INTO docs (note, extra) VALUES (?, ?)').run('small', p1);
    expect(toast.deleteOrphans()).toBe(0);
  });

  it('scans only text columns and non-TOAST values are ignored', async () => {
    const db = new Database(':memory:');
    const toast = new ToastStorage(db);
    db.exec('CREATE TABLE t (id INTEGER, num REAL, body TEXT)');
    const p1 = (await toast.store('f'.repeat(10000)))!;
    db.prepare('INSERT INTO t (num, body) VALUES (1.5, ?)').run('not a toast pointer');
    expect(toast.deleteOrphans()).toBe(1);
  });

  it('skips tables with no text columns', async () => {
    const db = new Database(':memory:');
    const toast = new ToastStorage(db);
    db.exec('CREATE TABLE nums (id INTEGER, val REAL)');
    db.prepare('INSERT INTO nums (val) VALUES (1), (2)').run();
    await toast.store('g'.repeat(10000));
    expect(toast.deleteOrphans()).toBe(1);
  });
});
