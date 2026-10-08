import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectGiST,
  analyzeGiSTStrategy,
  detectGeometryType,
  rewriteGiST,
  rewriteGiSTDropIndex,
  rewriteGiSTQuery,
  buildRTreeIndexSql,
  buildRTreeTriggerSql,
  buildRTreePopulateSql,
  buildRTreeSpatialWhere,
  buildRTreeDropSql,
  buildGiSTFallbackTableSql,
  buildGiSTFallbackInsertSql,
  checkSpatialiteSupport,
  registerRTreeIndex,
  unregisterRTreeIndex,
  clearRTreeRegistry,
  clearGeometryFormats,
  setGeometryFormat,
  getGeometryFormat,
  isDistanceOperator,
  rewriteKnnOrderBy,
  GiSTIndexRuntime,
} from '../index/GiSTIndexShim';

beforeEach(() => {
  clearRTreeRegistry();
  clearGeometryFormats();
});

describe('GiSTIndexShim', () => {
  describe('detectGiST', () => {
    it('detects USING GIST', () => {
      expect(detectGiST('CREATE INDEX i ON t USING GIST (c)')).toBe(true);
    });
    it('is case-insensitive', () => {
      expect(detectGiST('CREATE INDEX i ON t using gist (c)')).toBe(true);
    });
    it('ignores non-GiST', () => {
      expect(detectGiST('CREATE INDEX i ON t USING btree (c)')).toBe(false);
    });
  });

  describe('analyzeGiSTStrategy', () => {
    it('classifies fts via to_tsvector', () => {
      expect(analyzeGiSTStrategy("CREATE INDEX ON t USING GIST (to_tsvector('english', body))")).toBe('fts');
    });
    it('classifies fts via to_tsquery', () => {
      expect(analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (to_tsquery(foo))')).toBe('fts');
    });
    it('classifies range via _range suffix', () => {
      expect(analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (valid_range)')).toBe('range');
    });
    it('classifies range via int4range constructor', () => {
      expect(analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (int4range(a,b))')).toBe('range');
    });
    it('classifies spatial via geom column', () => {
      expect(analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (geom)')).toBe('spatial');
    });
    it('classifies spatial via ST_ function', () => {
      expect(analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (ST_Intersects(g, x))')).toBe('spatial');
    });
    it('classifies spatial via geometry column name', () => {
      expect(analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (point_coord)')).toBe('spatial');
    });
    it('falls back to unknown for plain columns', () => {
      expect(analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (foo)')).toBe('unknown');
    });
    it('falls back to unknown when no expression', () => {
      expect(analyzeGiSTStrategy('CREATE INDEX ON t USING GIST')).toBe('unknown');
    });
    it('falls back to unknown for unbalanced parens', () => {
      expect(analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (unbalanced')).toBe('unknown');
    });
  });

  describe('detectGeometryType', () => {
    it('detects point/box/circle/polygon', () => {
      expect(detectGeometryType('point_col')).toBe('point');
      expect(detectGeometryType('bounding_box')).toBe('box');
      expect(detectGeometryType('circle_geom')).toBe('circle');
      expect(detectGeometryType('polygon_shape')).toBe('polygon');
    });
    it('returns unknown otherwise', () => {
      expect(detectGeometryType('foo')).toBe('unknown');
    });
  });

  describe('rewriteGiST', () => {
    it('passes through non-GiST DDL', () => {
      const r = rewriteGiST('CREATE INDEX i ON t USING btree (c)');
      expect(r.rewritten).toBe(false);
      expect(r.strategy).toBe('unknown');
    });

    it('rewrites fts to a comment', () => {
      const r = rewriteGiST("CREATE INDEX idx ON docs USING GIST (to_tsvector('english', body))");
      expect(r.rewritten).toBe(true);
      expect(r.strategy).toBe('fts');
      expect(r.sql).toContain('FTS5 virtual table');
    });

    it('rewrites range by stripping USING GIST', () => {
      const r = rewriteGiST('CREATE INDEX idx ON t USING GIST (valid_range)');
      expect(r.rewritten).toBe(true);
      expect(r.strategy).toBe('range');
      expect(r.sql).not.toContain('USING GIST');
      expect(r.sql).toBe('CREATE INDEX idx ON t (valid_range)');
    });

    it('rewrites spatial to B-tree + R*Tree + triggers', () => {
      const r = rewriteGiST('CREATE INDEX idx ON locations USING GIST (coord)');
      expect(r.strategy).toBe('spatial');
      expect(r.rtreeTable).toBe('__rtree_idx');
      expect(r.sql).toContain('CREATE INDEX idx ON locations (coord)');
      expect(r.sql).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS __rtree_idx USING rtree');
      expect(r.sql).toContain('__trg_rtree_insert_idx');
      expect(r.sql).toContain('INSERT OR IGNORE INTO __rtree_idx');
      expect(r.queryRewrite?.rtreeTable).toBe('__rtree_idx');
    });

    it('preserves a schema-qualified table in spatial rewrite', () => {
      const r = rewriteGiST('CREATE INDEX idx ON schema.locations USING GIST (coord)');
      expect(r.queryRewrite?.parentTable).toBe('schema.locations');
      expect(r.sql).toContain('ON schema.locations');
    });

    it('strips GIST when spatial names cannot be extracted', () => {
      const r = rewriteGiST('CREATE UNIQUE INDEX USING GIST (coord)');
      expect(r.rewritten).toBe(true);
      expect(r.sql).not.toContain('USING GIST');
    });

    it('rewrites unknown strategy by stripping GIST', () => {
      const r = rewriteGiST('CREATE INDEX idx ON t USING GIST (foo)');
      expect(r.strategy).toBe('unknown');
      expect(r.sql).toBe('CREATE INDEX idx ON t (foo)');
    });

    it('handles DROP INDEX with R-tree cleanup', () => {
      const r = rewriteGiST('DROP INDEX idx');
      expect(r.rewritten).toBe(true);
      expect(r.dropSql).toContain('DROP TABLE IF EXISTS __rtree_idx');
    });

    it('passes through DROP INDEX without a name', () => {
      const r = rewriteGiST('DROP INDEX');
      expect(r.rewritten).toBe(false);
    });
  });

  describe('rewriteGiSTDropIndex', () => {
    it('rewrites a drop with R-tree cleanup', () => {
      const r = rewriteGiSTDropIndex('DROP INDEX idx_locations_coord');
      expect(r.rewritten).toBe(true);
      expect(r.strategy).toBe('spatial');
      expect(r.sql).toContain('DROP INDEX idx_locations_coord');
      expect(r.sql).toContain('DROP TABLE IF EXISTS __rtree_idx_locations_coord');
    });
    it('passes through non-DROP', () => {
      const r = rewriteGiSTDropIndex('SELECT 1');
      expect(r.rewritten).toBe(false);
    });
  });

  describe('R-tree SQL builders', () => {
    it('builds rtree DDL for N dimensions', () => {
      const sql = buildRTreeIndexSql('idx', 3);
      expect(sql[0]).toContain('min_d1 REAL, max_d1 REAL, min_d2 REAL, max_d2 REAL, min_d3 REAL, max_d3 REAL');
    });
    it('builds insert/delete/update triggers', () => {
      const t = buildRTreeTriggerSql('locations', 'coord', 'idx', 'point', 2);
      expect(t).toHaveLength(3);
      expect(t[0]).toContain('__trg_rtree_insert_idx');
      expect(t[1]).toContain('DELETE FROM __rtree_idx WHERE id = OLD.rowid');
      expect(t[2]).toContain('__trg_rtree_update_idx');
    });
    it('builds point_wkt trigger extraction', () => {
      setGeometryFormat('locations', 'coord', 'point_wkt');
      const t = buildRTreeTriggerSql('locations', 'coord', 'idx', 'point', 2);
      expect(t[0]).toContain('RTRIM');
    });
    it('builds point_xy_comma trigger extraction', () => {
      setGeometryFormat('locations', 'coord', 'point_xy_comma');
      const t = buildRTreeTriggerSql('locations', 'coord', 'idx', 'point', 2);
      expect(t[0]).toContain("INSTR(NEW.coord, ',')");
    });
    it('builds box_wkt trigger extraction (box geometry uses min/max per dim)', () => {
      setGeometryFormat('locations', 'coord', 'box_wkt');
      const t = buildRTreeTriggerSql('locations', 'coord', 'idx', 'box', 2);
      // box geometry emits min/max differing per dimension, not min==max
      expect(t[0]).toContain('LTRIM');
    });
    it('builds box_wkt trigger extraction for non-box geometry', () => {
      setGeometryFormat('locations', 'coord', 'box_wkt');
      const t = buildRTreeTriggerSql('locations', 'coord', 'idx', 'point', 2);
      // non-box geometry with box_wkt format uses the first corner as a point
      expect(t[0]).toContain('SUBSTR');
      expect(t[0]).not.toContain('LTRIM');
    });
    it('builds populate SQL for each format', () => {
      expect(buildRTreePopulateSql('locations', 'coord', 'idx', 'point', 2)).toContain('locations.coord');
      setGeometryFormat('locations', 'coord', 'point_wkt');
      expect(buildRTreePopulateSql('locations', 'coord', 'idx', 'point', 2)).toContain('RTRIM');
      setGeometryFormat('locations', 'coord', 'point_xy_comma');
      expect(buildRTreePopulateSql('locations', 'coord', 'idx', 'point', 2)).toContain("','");
      setGeometryFormat('locations', 'coord', 'box_wkt');
      expect(buildRTreePopulateSql('locations', 'coord', 'idx', 'box', 2)).toContain('LTRIM');
    });
    it('builds drop cleanup SQL', () => {
      const d = buildRTreeDropSql('idx');
      expect(d).toHaveLength(4);
      expect(d[3]).toBe('DROP TABLE IF EXISTS __rtree_idx');
    });
    it('builds fallback table + insert SQL', () => {
      expect(buildGiSTFallbackTableSql('idx', 'col')).toContain('__gist_idx');
      expect(buildGiSTFallbackInsertSql('idx', 't', 'col')).toContain('INSERT INTO __gist_idx');
    });
  });

  describe('geometry formats', () => {
    it('defaults to point_xy and registers custom formats', () => {
      expect(getGeometryFormat('t', 'c')).toBe('point_xy');
      setGeometryFormat('t', 'c', 'point_wkt');
      expect(getGeometryFormat('t', 'c')).toBe('point_wkt');
      clearGeometryFormats();
      expect(getGeometryFormat('t', 'c')).toBe('point_xy');
    });
  });

  describe('checkSpatialiteSupport', () => {
    it('reports no db provided', () => {
      const r = checkSpatialiteSupport();
      expect(r.spatialiteAvailable).toBe(false);
      expect(r.rtreeAvailable).toBe(true);
      expect(r.reason).toBe('No database instance provided');
    });
    it('reports rtree success and spatialite failure', () => {
      const db = {
        exec: (sql: string) => {
          if (sql.includes('load_extension')) throw new Error('not authorized');
        },
      };
      const r = checkSpatialiteSupport(db);
      expect(r.rtreeAvailable).toBe(true);
      expect(r.spatialiteAvailable).toBe(false);
      expect(r.reason).toContain('mod_spatialite');
    });
    it('reports rtree failure', () => {
      const db = {
        exec: (sql: string) => {
          if (sql.includes('rtree')) throw new Error('no rtree');
        },
      };
      const r = checkSpatialiteSupport(db);
      expect(r.rtreeAvailable).toBe(false);
      expect(r.reason).toContain('R*Tree');
    });
  });

  describe('buildRTreeSpatialWhere', () => {
    it('builds within / overlaps / same / contains predicates', () => {
      expect(buildRTreeSpatialWhere('__rtree', 't', '<@', [0, 0, 100, 100])).toContain('min_d1 >= 0');
      expect(buildRTreeSpatialWhere('__rtree', 't', '&&', [0, 0, 100, 100])).toContain('max_d1 >= 0');
      expect(buildRTreeSpatialWhere('__rtree', 't', '~=', [5, 5, 5, 5])).toContain('min_d1 = 5');
      expect(buildRTreeSpatialWhere('__rtree', 't', '@>', [0, 0, 100, 100])).toContain('max_d1 >= 100');
      expect(buildRTreeSpatialWhere('__rtree', 't', '~', [0, 0, 100, 100])).toContain('max_d1 >= 100');
    });
    it('returns empty for unknown op', () => {
      expect(buildRTreeSpatialWhere('__rtree', 't', '??', [0, 0, 1, 1])).toBe('');
    });
  });

  describe('rewriteGiSTQuery', () => {
    it('skips non SELECT/UPDATE/DELETE', () => {
      const r = rewriteGiSTQuery('INSERT INTO t VALUES (1)');
      expect(r.rewritten).toBe(false);
    });

    it('rewrites a box within predicate', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON t USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      const r = rewriteGiSTQuery('SELECT * FROM t WHERE coord <@ box(0,0,100,100)');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('EXISTS (SELECT 1 FROM __rtree_idx');
      expect(r.rtreeTables).toContain('__rtree_idx');
    });

    it('rewrites an alias-qualified predicate', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON locations USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      const r = rewriteGiSTQuery('SELECT * FROM locations l WHERE l.coord && box(0,0,10,10)');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('l.rowid');
    });

    it('rewrites a point equality predicate', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON t USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      const r = rewriteGiSTQuery('SELECT * FROM t WHERE coord ~= point(5,5)');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('min_d1 = 5');
    });

    it('rewrites an alias-qualified point predicate', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON t USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      const r = rewriteGiSTQuery('SELECT * FROM t tt WHERE tt.coord ~= point(5,5)');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('tt.rowid');
    });

    it('leaves a point predicate without a registered index unchanged', () => {
      const r = rewriteGiSTQuery('SELECT * FROM t WHERE coord ~= point(5,5)');
      expect(r.rewritten).toBe(false);
    });

    it('leaves a query without registered index unchanged', () => {
      const r = rewriteGiSTQuery('SELECT * FROM t WHERE coord <@ box(0,0,1,1)');
      expect(r.rewritten).toBe(false);
    });

    it('handles multiple spatial predicates', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON t USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      const r = rewriteGiSTQuery('SELECT * FROM t WHERE coord <@ box(0,0,100,100) AND coord && box(5,5,10,10)');
      expect(r.rewritten).toBe(true);
      expect((r.sql.match(/EXISTS \(SELECT 1/g) || []).length).toBe(2);
    });

    it('handles multiple point predicates', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON t USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      const r = rewriteGiSTQuery('SELECT * FROM t WHERE coord ~= point(1,1) OR coord ~= point(2,2)');
      expect(r.rewritten).toBe(true);
      expect((r.sql.match(/EXISTS \(SELECT 1/g) || []).length).toBe(2);
    });
  });

  describe('registry management', () => {
    it('registers and unregisters by column and qualified name', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON locations USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      const r = rewriteGiSTQuery('SELECT * FROM locations WHERE coord <@ box(0,0,1,1)');
      expect(r.rewritten).toBe(true);
      unregisterRTreeIndex('coord', 'locations');
      const r2 = rewriteGiSTQuery('SELECT * FROM locations WHERE coord <@ box(0,0,1,1)');
      expect(r2.rewritten).toBe(false);
    });

    it('unregisters by column name only', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON locations USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      unregisterRTreeIndex('coord'); // no parentTable
      const r = rewriteGiSTQuery('SELECT * FROM locations WHERE coord <@ box(0,0,1,1)');
      expect(r.rewritten).toBe(false);
    });
  });

  describe('isDistanceOperator + rewriteKnnOrderBy', () => {
    it('detects the distance operator', () => {
      expect(isDistanceOperator('ORDER BY geom <-> POINT(10,20)')).toBe(true);
      expect(isDistanceOperator('SELECT 1')).toBe(false);
      expect(isDistanceOperator('')).toBe(false);
      expect(isDistanceOperator(123 as any)).toBe(false);
    });

    it('rewrites KNN order by', () => {
      const r = rewriteKnnOrderBy('SELECT * FROM t ORDER BY geom <-> POINT(10,20) LIMIT 5');
      expect(r.rewritten).toBe(true);
      expect(r.distanceColumn).toBe('geom');
      expect(r.pointX).toBe(10);
      expect(r.pointY).toBe(20);
      expect(r.limit).toBe(5);
      expect(r.sql).toContain('SQRT');
    });

    it('defaults limit to 10 when absent', () => {
      const r = rewriteKnnOrderBy('SELECT * FROM t ORDER BY geom <-> POINT(1,2)');
      expect(r.limit).toBe(10);
      expect(r.sql).toContain('LIMIT 10');
    });

    it('returns unrewritten for no distance op or malformed', () => {
      expect(rewriteKnnOrderBy('SELECT 1').rewritten).toBe(false);
      expect(rewriteKnnOrderBy('').rewritten).toBe(false);
      expect(rewriteKnnOrderBy('ORDER BY geom <-> POINT(x,y)').rewritten).toBe(false);
    });
  });

  describe('GiSTIndexRuntime (spatial)', () => {
    it('indexes points and searches overlap', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, '1 2');
      rt.insert(2, '50 60');
      expect(rt.search('&&', 'BOX(0 0,20 20)')).toEqual([1]);
      expect(rt.search('<@', 'BOX(0 0,100 100)').sort()).toEqual([1, 2]);
      expect(rt.search('~=', '1 2')).toEqual([1]);
      expect(rt.getSize()).toBe(2);
    });

    it('supports POINT wkt and comma formats', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, 'POINT(10 20)');
      rt.insert(2, 'POINT(30,40)');
      // `~=` requires an exact value match, so the query value string matters.
      expect(rt.search('~=', 'POINT(10 20)')).toEqual([1]);
      expect(rt.search('~=', 'POINT(30,40)')).toEqual([2]);
    });

    it('supports range values as 1D segments', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, '[1,10)');
      rt.insert(2, '[5,15)');
      expect(rt.search('&&', '[2,6)').sort()).toEqual([1, 2]);
    });

    it('removes entries', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, '1 2');
      rt.remove(1, '1 2');
      expect(rt.getSize()).toBe(0);
      expect(rt.search('~=', '1 2')).toEqual([]);
    });

    it('clears all state', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, '1 2');
      rt.clear();
      expect(rt.getSize()).toBe(0);
    });
  });

  describe('GiSTIndexRuntime (simple)', () => {
    it('uses fallback map', () => {
      const rt = new GiSTIndexRuntime('simple');
      rt.insert(1, 'foo');
      rt.insert(2, 'bar');
      expect(rt.search('=', 'foo')).toEqual([1]);
      expect(rt.search('@>', 'foo')).toEqual([1]);
      expect(rt.search('~=', 'bar')).toEqual([2]);
      rt.remove(1, 'foo');
      expect(rt.search('=', 'foo')).toEqual([]);
    });
  });

  describe('GiSTIndexRuntime (range)', () => {
    it('searches ranges', () => {
      const rt = new GiSTIndexRuntime('range');
      rt.insert(1, '[1,10)');
      rt.insert(2, '[5,15)');
      expect(rt.search('&&', '[2,6)').sort()).toEqual([1, 2]);
      expect(rt.search('@>', '[2,3)')).toEqual([1]);
    });

    it('supports numrange and int4range and plain numeric encodings', () => {
      const rt = new GiSTIndexRuntime('range');
      rt.insert(1, 'numrange(1,10)');
      rt.insert(2, 'int4range(5,15)');
      rt.insert(3, '7');
      expect(rt.search('&&', 'numrange(2,6)').sort()).toEqual([1, 2]);
      expect(rt.search('~=', '7')).toEqual([3]);
    });

    it('supports contained-by <@', () => {
      const rt = new GiSTIndexRuntime('range');
      rt.insert(1, '[1,5)');
      rt.insert(2, '[1,20)');
      expect(rt.search('<@', '[0,30)').sort()).toEqual([1, 2]);
      expect(rt.search('<@', '[0,10)')).toEqual([1]);
    });

    it('falls back when value is not bbox-parseable', () => {
      const rt = new GiSTIndexRuntime('range');
      rt.insert(1, 'foo');
      expect(rt.search('=', 'foo')).toEqual([1]);
      expect(rt.search('~=', 'foo')).toEqual([1]);
    });
  });

  describe('GiSTIndexRuntime (spatial advanced)', () => {
    it('supports comma-separated and BOX bbox values', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, '5,6');
      rt.insert(2, 'BOX(0 0,10 10)');
      expect(rt.search('~=', '5,6')).toEqual([1]);
      expect(rt.search('&&', 'BOX(0 0,5 5)').sort()).toEqual([2]);
    });

    it('supports contains @> for a polygon bbox containing a box', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, 'BOX(0 0,100 100)');
      rt.insert(2, 'BOX(0 0,5 5)');
      expect(rt.search('@>', 'BOX(0 0,10 10)')).toEqual([1]);
    });

    it('handles malformed numeric input gracefully via fallback', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, '-'); // parseFloat('-') is NaN → not bbox → fallback
      rt.insert(2, '.');
      expect(rt.search('=', '-')).toEqual([1]);
      expect(rt.search('=', '.')).toEqual([2]);
      expect(rt.getSize()).toBe(2);
    });

    it('treats punctuation-only POINT/BOX/range as non-bbox', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, 'POINT(- .)');
      rt.insert(2, 'BOX(- .,. -)');
      rt.insert(3, '[-,.)');
      rt.insert(4, 'numrange(-,.)');
      rt.insert(5, 'POINT(-,.)');
      rt.insert(6, '- .');
      rt.insert(7, '-,.');
      // none parsed as numeric bbox, all fall back
      expect(rt.getSize()).toBe(7);
      expect(rt.search('=', 'POINT(- .)')).toEqual([1]);
    });

    it('supports remove with null value and equality search default', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, 'foo'); // fallback
      rt.remove(1, null); // remove by rowid from fallback
      expect(rt.getSize()).toBe(0);
      expect(rt.search('=', 'foo')).toEqual([]);
    });

    it('no-ops remove with null value when rowid absent', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, '1 2');
      rt.remove(99, null);
      expect(rt.getSize()).toBe(1);
    });

    it('keeps a shared fallback entry when removing one of several rows by null', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, 'foo'); // fallback
      rt.insert(2, 'foo');
      rt.remove(1, null); // remove rowid 1 from fallback, rowid 2 remains
      expect(rt.getSize()).toBe(1);
      expect(rt.search('=', 'foo')).toEqual([2]);
    });

    it('ignores null/undefined values on insert', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, null);
      rt.insert(2, undefined);
      expect(rt.getSize()).toBe(0);
    });

    it('returns empty for unknown operator', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, '1 2');
      expect(rt.search('??' as any, '1 2')).toEqual([]);
    });

    it('supports the = operator for exact point match', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, '1 2');
      rt.insert(2, '3 4');
      expect(rt.search('=', '1 2')).toEqual([1]);
    });

    it('removes a non-bbox fallback value and decrements size', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, 'foo'); // fallback
      rt.remove(1, 'foo'); // non-bbox → _removeFallback
      expect(rt.getSize()).toBe(0);
    });

    it('no-ops removing a value not in the fallback map', () => {
      const rt = new GiSTIndexRuntime('spatial');
      rt.insert(1, '1 2'); // bbox, not fallback
      rt.remove(1, 'bogus'); // non-bbox → _removeFallback, but key absent
      expect(rt.getSize()).toBe(1);
    });

    it('deduplicates fallback values on insert', () => {
      const rt = new GiSTIndexRuntime('simple');
      rt.insert(1, 'dup');
      rt.insert(2, 'dup');
      expect(rt.search('=', 'dup').sort()).toEqual([1, 2]);
      expect(rt.getSize()).toBe(2);
    });

    it('keeps a shared fallback value when one row is removed', () => {
      const rt = new GiSTIndexRuntime('simple');
      rt.insert(1, 'dup');
      rt.insert(2, 'dup');
      rt.remove(1, 'dup');
      expect(rt.search('=', 'dup')).toEqual([2]);
      expect(rt.getSize()).toBe(1);
    });

    it('supports && and <@ on the simple fallback map', () => {
      const rt = new GiSTIndexRuntime('simple');
      rt.insert(1, 'foo');
      rt.insert(2, 'bar');
      expect(rt.search('&&', 'foo')).toEqual([1]); // fallback && returns same-value rows
      expect(rt.search('<@', 'bar')).toEqual([2]);
    });

    it('simple type unknown operator returns empty', () => {
      const rt = new GiSTIndexRuntime('simple');
      rt.insert(1, 'foo');
      expect(rt.search('??' as any, 'foo')).toEqual([]);
    });
  });

  describe('rewriteKnnOrderBy with R-tree filter', () => {
    it('adds an R-tree prefilter with a WHERE clause', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON t USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      const r = rewriteKnnOrderBy('SELECT * FROM t WHERE coord IS NOT NULL ORDER BY coord <-> POINT(10,20) LIMIT 5');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('EXISTS (SELECT 1 FROM __rtree_idx');
    });

    it('adds an R-tree prefilter with GROUP BY / HAVING', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON t USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      const r = rewriteKnnOrderBy('SELECT * FROM t GROUP BY coord HAVING count(*) > 1 ORDER BY coord <-> POINT(1,2)');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('WHERE 1=1');
    });

    it('adds a WHERE prefixed R-tree filter when no WHERE exists', () => {
      const qr = rewriteGiST('CREATE INDEX idx ON t USING GIST (coord)').queryRewrite;
      registerRTreeIndex(qr);
      const r = rewriteKnnOrderBy('SELECT * FROM t ORDER BY coord <-> POINT(1,2) LIMIT 3');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('WHERE 1=1');
    });
  });
});
