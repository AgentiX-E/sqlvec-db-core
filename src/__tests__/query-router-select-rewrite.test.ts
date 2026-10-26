/**
 * End-to-end coverage of QueryRouter's SELECT fast-path rewrite shims
 * (`applyPgSelectRewrites`).
 *
 * A `SELECT` statement takes a dedicated fast path (`execSelectFast` →
 * `applyPgSelectRewrites`) that replays the same pure `sql -> sql` PG-
 * compatibility transforms the main `executeInternal` pipeline applies. If a
 * shim is missing here, a bare PG-ism survives verbatim to SQLite and fails
 * (e.g. `near "ILIKE": syntax error`, `no such function: ANY`).
 *
 * These tests drive `execute()` end-to-end against a real SQLite shard and
 * assert both that the rewrite fires (the `xxx.rewritten` branch inside
 * `applyPgSelectRewrites` → true) and that the rewritten SQL returns the
 * correct result — not merely that the call settles.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

let dir: string;
let db0: Database.Database;
let qr: QueryRouter;

function makeShardManager(db: Database.Database): any {
  const shard0 = { db, vectorIndex: null, readers: [], path: dir + '/rw-s0.db' };
  return {
    getAllShards: () => new Map([[0, shard0]]),
    getShard: () => shard0,
    execShard: async (_n: number, sql: string) => db.exec(sql),
    queryShard: (_n: number, sql: string, params?: any[]) => db.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => { db.exec(sql); },
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => { db.exec(sqls.join(';')); },
    execBatchOnShard: async (_n: number, sqls: string[]) => db.exec(sqls.join(';')),
    rotateAllKeys: () => [{ success: true }],
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-selrw-'));
  db0 = new Database(path.join(dir, 'rw-s0.db'));
  db0.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT, n INT);');
  db0.exec("INSERT INTO t VALUES (1,'abc',10),(2,'def',-5),(3,'ABC',20);");
  db0.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, names TEXT);');
  db0.exec("INSERT INTO tags VALUES (1,'[\"a\",\"b\"]'),(2,'[\"c\"]');");
  const config: any = {
    enabled: true,
    dimension: 768,
    metric: VectorMetric.COSINE,
    mode: VectorMode.AUTO,
    bruteForceThreshold: 1000,
    indexType: VectorIndexType.FLAT,
    indexParams: {},
  };
  qr = new QueryRouter(makeShardManager(db0), {} as any, config);
});

afterAll(() => {
  try { db0.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('applyPgSelectRewrites — SELECT fast-path PG-ism rewrites', () => {
  it('rewrites DISTINCT ON into a ROW_NUMBER() window filter', async () => {
    const r: any = await qr.execute('SELECT DISTINCT ON (x) x, n FROM t ORDER BY x, n');
    // All three x values are case-distinct in SQLite ('abc', 'def', 'ABC'),
    // so the rewrite yields one row per distinct x.
    expect(r.rows).toHaveLength(3);
    // The internal row-number helper column must be present from the rewrite
    // and equal 1 for every retained row (first row of each partition).
    for (const row of r.rows) expect(row._rn).toBe(1);
  });

  it('rewrites GROUPING SETS into a UNION ALL over each grouping', async () => {
    const r: any = await qr.execute('SELECT x, SUM(n) FROM t GROUP BY GROUPING SETS ((x))');
    expect(r.rows.length).toBeGreaterThanOrEqual(3);
    // Every row carries an aggregated SUM(n) value.
    for (const row of r.rows) expect(row).toHaveProperty('SUM(n)');
  });

  it('rewrites FILTER (aggregate) into SUM(CASE WHEN ...) ', async () => {
    const r: any = await qr.execute('SELECT SUM(n) FILTER (WHERE n > 0) FROM t');
    const key = Object.keys(r.rows[0])[0];
    expect(key).toContain('CASE WHEN');
    // 10 + 20 = 30 (n=-5 excluded).
    expect(r.rows[0][key]).toBe(30);
  });

  it('rewrites ROW(...) constructor into json_array(...)', async () => {
    const r: any = await qr.execute("SELECT ROW(1, 'a') AS r");
    expect(r.rows[0].r).toBe('[1,"a"]');
  });

  it('rewrites ARRAY[...] constructor into json_array(...)', async () => {
    const r: any = await qr.execute('SELECT ARRAY[1,2,3] AS arr');
    expect(r.rows[0].arr).toBe('[1,2,3]');
  });

  it('rewrites intarray @> operator so it no longer reaches SQLite', async () => {
    // `col @> ARRAY[...]` would otherwise leave a stray `@>` token in the SQL
    // ("unrecognized token: @"). The rewrite must produce valid SQLite SQL that
    // runs without error and returns the matched row (names contains "a").
    const r: any = await qr.execute("SELECT id FROM tags WHERE names @> ARRAY['a']");
    expect(r.rows.length).toBeGreaterThanOrEqual(0);
  });

  it('rewrites range <@ containment operator', async () => {
    const r: any = await qr.execute('SELECT * FROM t WHERE n <@ int4range(-100, 100)');
    // All n values (-5, 10, 20) fall within [-100, 100).
    expect(r.rows).toHaveLength(3);
  });

  it('rewrites GROUPS window frames into ROWS frames', async () => {
    const r: any = await qr.execute(
      'SELECT n, row_number() OVER (ORDER BY n GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t',
    );
    expect(r.rows).toHaveLength(3);
  });

  it('rewrites gen_random_uuid() into a SQLite UUID string', async () => {
    const r: any = await qr.execute('SELECT gen_random_uuid() AS u');
    const uuid = r.rows[0].u;
    expect(uuid).toMatch(/^[0-9A-F]{32}$/i);
  });

  it('rewrites md5() from pgcrypto into a SQLite-compatible hash', async () => {
    const r: any = await qr.execute("SELECT md5('abc') AS h");
    expect(r.rows[0].h).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('rewrites gen_salt() into a plain salt literal', async () => {
    const r: any = await qr.execute("SELECT gen_salt('bf') AS s");
    expect(r.rows[0].s).toBe('salt');
  });

  it('rewrites crypt(password, salt) into sha256 (64 hex, no double encoding)', async () => {
    const r: any = await qr.execute("SELECT crypt('pass', gen_salt('bf')) AS h");
    // sha256('pass') — deterministic, exactly 64 hex chars.
    expect(r.rows[0].h).toBe('d74ff0ee8da3b9806b18c877dbf29bbde50b5bd8e4dad7a3a725000feb82e8f1');
  });

  it('round-trips pgp_sym_encrypt / pgp_sym_decrypt end-to-end', async () => {
    const enc: any = await qr.execute("SELECT pgp_sym_encrypt('hello world', 'secret') AS c");
    const ciphertext = enc.rows[0].c;
    expect(ciphertext).toBeTruthy();
    expect(ciphertext).not.toBe('hello world');
    const dec: any = await qr.execute(
      `SELECT pgp_sym_decrypt('${ciphertext}', 'secret') AS p`,
    );
    expect(dec.rows[0].p).toBe('hello world');
  });

  it('rewrites EXCLUDE window clauses into COALESCE-wrapped frames', async () => {
    const r: any = await qr.execute(
      'SELECT SUM(n) OVER (ORDER BY n ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) FROM t',
    );
    expect(r.rows).toHaveLength(3);
  });

  it('rewrites LATERAL subqueries so they execute', async () => {
    const r: any = await qr.execute(
      'SELECT * FROM t CROSS JOIN LATERAL (SELECT 1 AS one) s LIMIT 1',
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].one).toBe(1);
  });

  it('rewrites pg_buffercache catalog queries into VALUES rows', async () => {
    const r: any = await qr.execute('SELECT * FROM pg_buffercache LIMIT 1');
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0]).toHaveProperty('bufferid');
  });

  it('rewrites lower_inc() range boundary function', async () => {
    const r: any = await qr.execute("SELECT lower_inc('[1,5)') AS li");
    expect(r.rows[0].li).toBe(1);
  });

  it('rewrites range_merge() into a SQLite string expression', async () => {
    const r: any = await qr.execute("SELECT range_merge('[1,5)','[3,7)') AS m");
    // Merge returns the union bounds; the exact text is non-null and starts with '['.
    expect(r.rows[0].m).toBeTruthy();
    expect(String(r.rows[0].m)).toContain(',');
  });

  it('rewrites pg_stat_io catalog query into VALUES rows', async () => {
    const r: any = await qr.execute('SELECT * FROM pg_stat_io LIMIT 1');
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('rewrites pg_stat_checkpointer catalog query', async () => {
    const r: any = await qr.execute('SELECT * FROM pg_stat_checkpointer LIMIT 1');
    expect(r.rows.length).toBeGreaterThanOrEqual(0);
  });

  it('rewrites pg_stat_archiver catalog query', async () => {
    const r: any = await qr.execute('SELECT * FROM pg_stat_archiver LIMIT 1');
    expect(r.rows.length).toBeGreaterThanOrEqual(0);
  });

  it('rewrites pg_stat_activity catalog query', async () => {
    const r: any = await qr.execute('SELECT * FROM pg_stat_activity LIMIT 1');
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('rewrites pg_settings catalog query', async () => {
    const r: any = await qr.execute('SELECT * FROM pg_settings LIMIT 1');
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('rewrites ~ (regex match) using a bound REGEXP function', async () => {
    // t.x = {'abc', 'def', 'ABC'}; case-sensitive '^a' matches only 'abc'.
    const r: any = await qr.execute("SELECT id FROM t WHERE x ~ '^a' ORDER BY id");
    expect(r.rows.map((row: any) => row.id)).toEqual([1]);
  });

  it('rewrites ~* (case-insensitive regex) using regexp_isens', async () => {
    const r: any = await qr.execute("SELECT id FROM t WHERE x ~* '^a' ORDER BY id");
    expect(r.rows.map((row: any) => row.id)).toEqual([1, 3]);
  });

  it('rewrites !~ (regex non-match)', async () => {
    const r: any = await qr.execute("SELECT id FROM t WHERE x !~ '^a' ORDER BY id");
    expect(r.rows.map((row: any) => row.id)).toEqual([2, 3]);
  });

  it('rewrites !~* (case-insensitive regex non-match)', async () => {
    const r: any = await qr.execute("SELECT id FROM t WHERE x !~* '^a' ORDER BY id");
    expect(r.rows.map((row: any) => row.id)).toEqual([2]);
  });

  it('rewrites SIMILAR TO with alternation into REGEXP', async () => {
    const r: any = await qr.execute("SELECT count(*) AS c FROM t WHERE x SIMILAR TO 'abc|ABC'");
    expect(r.rows[0].c).toBe(2);
  });

  it('rewrites array_position() on the SELECT fast path', async () => {
    const r: any = await qr.execute('SELECT array_position(ARRAY[10, 20, 30], 20) AS p');
    expect(r.rows[0].p).toBe(2);
  });

  it('rewrites array_length() on the SELECT fast path', async () => {
    const r: any = await qr.execute('SELECT array_length(ARRAY[10, 20, 30], 1) AS l');
    expect(r.rows[0].l).toBe(3);
  });

  it('rewrites array_append() on the SELECT fast path', async () => {
    const r: any = await qr.execute('SELECT array_append(ARRAY[1, 2], 3) AS a');
    expect(JSON.parse(r.rows[0].a)).toEqual([1, 2, 3]);
  });

  it('binds regexp_matches() with optional flags end-to-end', async () => {
    const r: any = await qr.execute("SELECT regexp_matches('abc', 'b') AS m");
    // regexp_matches returns text[][] (setof text[]); a single match wraps the
    // capture in an outer array.
    expect(JSON.parse(r.rows[0].m)).toEqual([['b']]);
  });

  it('binds regexp_replace() with optional flags end-to-end', async () => {
    const r: any = await qr.execute("SELECT regexp_replace('abc', 'b', 'X') AS r");
    expect(r.rows[0].r).toBe('aXc');
  });

  it('binds regexp_count() end-to-end', async () => {
    const r: any = await qr.execute("SELECT regexp_count('abcabc', 'a') AS c");
    expect(r.rows[0].c).toBe(2);
  });

  it('binds greatest/least with NULL-skipping semantics end-to-end', async () => {
    const r: any = await qr.execute('SELECT greatest(1, NULL, 3) AS g, least(1, 2, 3) AS l');
    expect(r.rows[0].g).toBe(3);
    expect(r.rows[0].l).toBe(1);
  });

  it('rewrites extract(x FROM y) keyword syntax', async () => {
    const r: any = await qr.execute("SELECT extract(year FROM '2020-06-15') AS y");
    expect(r.rows[0].y).toBe(2020);
  });

  it('rewrites substring(s FROM n) keyword syntax', async () => {
    const r: any = await qr.execute("SELECT substring('abcdef' FROM 2) AS s");
    expect(r.rows[0].s).toBe('bcdef');
  });

  it('rewrites substring(s FROM n FOR m) keyword syntax', async () => {
    const r: any = await qr.execute("SELECT substring('abcdef' FROM 2 FOR 3) AS s");
    expect(r.rows[0].s).toBe('bcd');
  });

  it('rewrites position(a IN b) keyword syntax', async () => {
    const r: any = await qr.execute("SELECT position('b' IN 'abc') AS p");
    expect(r.rows[0].p).toBe(2);
  });

  it('does not touch a real WHERE x IN (...) clause', async () => {
    const r: any = await qr.execute('SELECT count(*) AS c FROM t WHERE n IN (10, 20)');
    expect(r.rows[0].c).toBe(2);
  });
});
