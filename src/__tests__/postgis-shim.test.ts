/**
 * Unit tests for the PostGIS spatial shim.
 *
 * Exercises detection (spatial DDL, known ST_ function families, case
 * insensitivity, unknown functions, non-string input) and rewriting (numeric/
 * boolean/geometry/string passthrough, make-point/geom-from-text special
 * cases, DDL no-ops, pass-through for unknown ST_ functions, trailing
 * semicolon normalization).
 */
import { describe, it, expect } from 'vitest';
import { detectPostGIS, rewritePostGIS } from '../query/PostGISShim';

describe('detectPostGIS', () => {
  it('detects spatial DDL statements', () => {
    expect(detectPostGIS('CREATE SPATIAL INDEX idx ON t(geom)')).toBe(true);
    expect(detectPostGIS('CREATE GIST INDEX idx ON t(geom)')).toBe(true);
    expect(detectPostGIS('AddGeometryColumn(...)')).toBe(true);
    expect(detectPostGIS('DropGeometryColumn(...)')).toBe(true);
    expect(detectPostGIS('Populate_Geometry_Columns(...)')).toBe(true);
  });

  it('detects numeric mock functions', () => {
    expect(detectPostGIS('SELECT ST_Distance(a, b) FROM t')).toBe(true);
    expect(detectPostGIS('SELECT ST_Area(g)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Length(g)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Perimeter(g)')).toBe(true);
    expect(detectPostGIS('SELECT ST_3DDistance(a, b)')).toBe(true);
  });

  it('detects boolean mock functions', () => {
    expect(detectPostGIS('SELECT ST_Contains(a, b)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Intersects(a, b)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Within(a, b)')).toBe(true);
    expect(detectPostGIS('SELECT ST_DWithin(a, b, 1)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Touches(a, b)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Overlaps(a, b)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Crosses(a, b)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Disjoint(a, b)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Equals(a, b)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Relate(a, b)')).toBe(true);
    expect(detectPostGIS('SELECT ST_3DIntersects(a, b)')).toBe(true);
  });

  it('detects geometry passthrough functions', () => {
    expect(detectPostGIS('SELECT ST_AsText(g)')).toBe(true);
    expect(detectPostGIS('SELECT ST_AsGeoJSON(g)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Buffer(g, 1)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Transform(g, 4326)')).toBe(true);
    expect(detectPostGIS('SELECT ST_Union(a, b)')).toBe(true);
  });

  it('detects string passthrough functions', () => {
    expect(detectPostGIS('SELECT ST_GeomFromText(wkt, 4326)')).toBe(true);
    expect(detectPostGIS('SELECT ST_MakePoint(1, 2)')).toBe(true);
    expect(detectPostGIS('SELECT ST_MakeLine(a, b)')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectPostGIS('select st_distance(a, b)')).toBe(true);
    expect(detectPostGIS('SELECT St_Contains(a, b)')).toBe(true);
  });

  it('returns false for unknown ST_ functions', () => {
    expect(detectPostGIS('SELECT ST_UnknownFunc(a)')).toBe(false);
  });

  it('returns false for non-spatial SQL', () => {
    expect(detectPostGIS('SELECT * FROM t')).toBe(false);
    expect(detectPostGIS('INSERT INTO t VALUES (1)')).toBe(false);
  });

  it('returns false for empty / non-string input', () => {
    expect(detectPostGIS('')).toBe(false);
    // @ts-expect-error defensive branch
    expect(detectPostGIS(null)).toBe(false);
    // @ts-expect-error defensive branch
    expect(detectPostGIS(undefined)).toBe(false);
  });
});

describe('rewritePostGIS', () => {
  it('returns non-string input unchanged with rewritten=false', () => {
    // @ts-expect-error defensive branch
    expect(rewritePostGIS(null)).toEqual({ sql: null, rewritten: false });
    // @ts-expect-error defensive branch
    expect(rewritePostGIS(undefined)).toEqual({ sql: undefined, rewritten: false });
    expect(rewritePostGIS('')).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites spatial DDL to SELECT 1', () => {
    const r = rewritePostGIS('CREATE SPATIAL INDEX idx ON t(geom)');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true, category: 'spatial_ddl' });
  });

  it('rewrites numeric mock functions to 0', () => {
    const r = rewritePostGIS('SELECT ST_Distance(a, b) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.category).toBe('st_distance');
    expect(r.sql).toBe('SELECT 0 FROM t;');
  });

  it('rewrites boolean mock functions to true', () => {
    const r = rewritePostGIS('SELECT ST_Contains(a, b) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT true FROM t;');
  });

  it('rewrites geometry passthrough to first argument', () => {
    const r = rewritePostGIS('SELECT ST_AsText(geom) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT geom FROM t;');
  });

  it('rewrites ST_MakePoint to empty string', () => {
    const r = rewritePostGIS('SELECT ST_MakePoint(1, 2)');
    expect(r.rewritten).toBe(true);
    expect(r.category).toBe('st_makepoint');
    expect(r.sql).toBe("SELECT '';");
  });

  it('rewrites ST_Point to empty string', () => {
    const r = rewritePostGIS('SELECT ST_Point(1, 2)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe("SELECT '';");
  });

  it('rewrites ST_GeomFromText to first (WKT) argument', () => {
    const r = rewritePostGIS("SELECT ST_GeomFromText('POINT(1 2)', 4326)");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe("SELECT 'POINT(1 2)';");
  });

  it('rewrites other string functions to first argument', () => {
    const r = rewritePostGIS('SELECT ST_MakeLine(a, b)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT a;');
  });

  it('passes through unknown ST_ functions with rewritten=false', () => {
    const r = rewritePostGIS('SELECT ST_UnknownFunc(a)');
    expect(r.rewritten).toBe(false);
  });

  it('passes through non-spatial SQL with trailing semicolon normalized', () => {
    const r = rewritePostGIS('SELECT * FROM t');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT * FROM t;');
  });

  it('normalizes trailing semicolons on rewritten output', () => {
    const r = rewritePostGIS('SELECT ST_Area(g);;');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 0;');
  });

  it('falls back to NULL when geometry first arg is empty', () => {
    const r = rewritePostGIS('SELECT ST_AsText()');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT NULL;');
  });

  it('falls back to NULL for empty ST_GeomFromText arguments', () => {
    const r = rewritePostGIS('SELECT ST_GeomFromText()');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT NULL;');
  });

  it('falls back to NULL for empty non-special string arguments', () => {
    const r = rewritePostGIS('SELECT ST_MakeLine()');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT NULL;');
  });

  it('passes through unbalanced ST_ calls (unclosed parenthesis)', () => {
    const r = rewritePostGIS('SELECT ST_Distance(a, b');
    expect(r.rewritten).toBe(false);
  });
});
