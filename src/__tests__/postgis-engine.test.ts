import { describe, it, expect } from 'vitest';
import { PostGISEngine, wktToGeoJSON, geoJSONToWKT } from '../query/PostGISEngine';

// ── WKT ⇄ GeoJSON conversion ─────────────────────────────────

describe('wktToGeoJSON', () => {
  it('parses POINT', () => {
    const g = wktToGeoJSON('POINT(1 2)');
    expect(g.type).toBe('Point');
    expect((g.coordinates as number[])).toEqual([1, 2]);
  });

  it('parses POINT with Z', () => {
    const g = wktToGeoJSON('POINT(1 2 3)');
    expect((g.coordinates as number[])).toEqual([1, 2, 3]);
  });

  it('parses LINESTRING', () => {
    const g = wktToGeoJSON('LINESTRING(0 0, 1 1, 2 2)');
    expect(g.type).toBe('LineString');
    expect((g.coordinates as number[][]).length).toBe(3);
  });

  it('parses POLYGON', () => {
    const g = wktToGeoJSON('POLYGON((0 0, 1 0, 1 1, 0 0))');
    expect(g.type).toBe('Polygon');
  });

  it('parses POLYGON with multiple rings', () => {
    const g = wktToGeoJSON('POLYGON((0 0, 4 0, 4 4, 0 0),(1 1, 2 1, 2 2, 1 1))');
    expect(g.type).toBe('Polygon');
    expect((g.coordinates as number[][][]).length).toBe(2);
  });

  it('parses MULTIPOINT', () => {
    const g = wktToGeoJSON('MULTIPOINT(0 0, 1 1)');
    expect(g.type).toBe('MultiPoint');
  });

  it('parses MULTILINESTRING', () => {
    const g = wktToGeoJSON('MULTILINESTRING((0 0, 1 1),(2 2, 3 3))');
    expect(g.type).toBe('MultiLineString');
  });

  it('parses MULTIPOLYGON', () => {
    const g = wktToGeoJSON('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)),((2 2, 3 2, 3 3, 2 2)))');
    expect(g.type).toBe('MultiPolygon');
  });

  it('parses single-member MULTIPOLYGON as MultiPolygon (not Polygon)', () => {
    const g = wktToGeoJSON('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)))');
    expect(g.type).toBe('MultiPolygon');
  });

  it('parses GEOMETRYCOLLECTION', () => {
    const g = wktToGeoJSON('GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1))');
    expect(g.type).toBe('GeometryCollection');
    expect((g as GeoJSON.GeometryCollection).geometries.length).toBe(2);
  });

  it('is case-insensitive and tolerates extra whitespace', () => {
    const g = wktToGeoJSON('  point ( 1   2 )  ');
    expect(g.type).toBe('Point');
  });

  it('throws on unsupported WKT geometry', () => {
    expect(() => wktToGeoJSON('CIRCLE(0 0 5)')).toThrowError(/Unsupported WKT/);
  });

  it('throws on empty/unknown input', () => {
    expect(() => wktToGeoJSON('')).toThrow();
  });
});

describe('geoJSONToWKT', () => {
  it('serializes Point', () => {
    expect(geoJSONToWKT({ type: 'Point', coordinates: [1, 2] })).toBe('POINT(1 2)');
  });

  it('serializes LineString', () => {
    expect(geoJSONToWKT({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }))
      .toBe('LINESTRING(0 0, 1 1)');
  });

  it('serializes Polygon', () => {
    expect(geoJSONToWKT({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }))
      .toBe('POLYGON((0 0, 1 0, 1 1, 0 0))');
  });

  it('serializes MultiPoint', () => {
    expect(geoJSONToWKT({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] }))
      .toBe('MULTIPOINT(0 0, 1 1)');
  });

  it('serializes MultiLineString', () => {
    expect(geoJSONToWKT({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] }))
      .toBe('MULTILINESTRING((0 0, 1 1))');
  });

  it('serializes MultiPolygon', () => {
    expect(geoJSONToWKT({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }))
      .toBe('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)))');
  });

  it('serializes GeometryCollection', () => {
    expect(geoJSONToWKT({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [1, 2] }],
    })).toBe('GEOMETRYCOLLECTION(POINT(1 2))');
  });

  it('throws on unsupported type', () => {
    expect(() => geoJSONToWKT({ type: 'Bogus', coordinates: [] } as unknown as GeoJSON.Geometry))
      .toThrowError(/Unsupported geometry type/);
  });
});

// ── Engine ────────────────────────────────────────────────────

describe('PostGISEngine', () => {
  const engine = new PostGISEngine();

  describe('constructor', () => {
    it('defaults SRID to 4326', () => {
      expect(engine.ST_SRID('POINT(1 2)')).toBe(4326);
    });

    it('accepts a custom default SRID', () => {
      const e = new PostGISEngine({ defaultSrid: 3857 });
      expect(e.ST_SRID('POINT(1 2)')).toBe(3857);
    });
  });

  describe('geometry constructors', () => {
    it('ST_MakePoint without Z', () => {
      expect(engine.ST_MakePoint(1, 2)).toBe('POINT(1 2)');
    });

    it('ST_MakePoint with Z', () => {
      expect(engine.ST_MakePoint(1, 2, 3)).toBe('POINT(1 2 3)');
    });

    it('ST_MakePoint ignores NaN Z', () => {
      expect(engine.ST_MakePoint(1, 2, NaN)).toBe('POINT(1 2)');
    });

    it('ST_MakeEnvelope', () => {
      expect(engine.ST_MakeEnvelope(0, 0, 1, 1))
        .toBe('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))');
    });

    it('ST_MakeEnvelope sets SRID when provided', () => {
      const wkt = engine.ST_MakeEnvelope(0, 0, 1, 1, 3857);
      expect(engine.ST_SRID(wkt)).toBe(3857);
    });

    it('ST_MakeLine from two points', () => {
      expect(engine.ST_MakeLine(['POINT(0 0)', 'POINT(1 1)'])).toBe('LINESTRING(0 0, 1 1)');
    });

    it('ST_MakeLine accepts raw coordinate pairs', () => {
      expect(engine.ST_MakeLine(['0 0', '1 1'])).toBe('LINESTRING(0 0, 1 1)');
    });

    it('ST_MakeLine flattens multipoint input', () => {
      expect(engine.ST_MakeLine(['MULTIPOINT(0 0, 1 1)'])).toBe('LINESTRING(0 0, 1 1)');
    });

    it('ST_MakeLine empty array returns LINESTRING EMPTY', () => {
      expect(engine.ST_MakeLine([])).toBe('LINESTRING EMPTY');
    });

    it('ST_MakeLine all-invalid input returns LINESTRING EMPTY', () => {
      expect(engine.ST_MakeLine(['garbage', 'nonsense'])).toBe('LINESTRING EMPTY');
    });

    it('ST_MakePolygon from a closed ring', () => {
      const wkt = engine.ST_MakePolygon('LINESTRING(0 0, 1 0, 1 1, 0 0)');
      expect(wkt).toContain('POLYGON');
    });

    it('ST_MakePolygon closes an unclosed ring', () => {
      const wkt = engine.ST_MakePolygon('LINESTRING(0 0, 1 0, 1 1)');
      expect(wkt).toContain('POLYGON');
    });

    it('ST_MakePolygon throws on non-LineString ring', () => {
      expect(() => engine.ST_MakePolygon('POINT(0 0)'))
        .toThrowError(/Only LineString/);
    });

    it('ST_Collect gathers multiple geometries', () => {
      const wkt = engine.ST_Collect('POINT(0 0)', 'POINT(1 1)');
      expect(wkt).toContain('MULTIPOINT');
    });

    it('ST_Collect homogeneous LineStrings return MULTILINESTRING', () => {
      const wkt = engine.ST_Collect('LINESTRING(0 0, 1 1)', 'LINESTRING(2 2, 3 3)');
      expect(wkt).toContain('MULTILINESTRING');
    });

    it('ST_Collect heterogeneous types return GEOMETRYCOLLECTION', () => {
      const wkt = engine.ST_Collect('POINT(0 0)', 'LINESTRING(0 0, 1 1)');
      expect(wkt).toContain('GEOMETRYCOLLECTION');
    });

    it('ST_Collect all-invalid returns GEOMETRYCOLLECTION()', () => {
      expect(engine.ST_Collect('garbage', 'nonsense')).toBe('GEOMETRYCOLLECTION()');
    });

    it('ST_Collect empty returns GEOMETRYCOLLECTION()', () => {
      expect(engine.ST_Collect()).toBe('GEOMETRYCOLLECTION()');
    });

    it('ST_Collect single geometry returns it unchanged', () => {
      expect(engine.ST_Collect('POINT(0 0)')).toBe('POINT(0 0)');
    });

    it('ST_GeomFromText returns geometry and records SRID', () => {
      const g = engine.ST_GeomFromText('POINT(1 2)', 4326);
      expect(g.type).toBe('Point');
      expect(engine.ST_SRID('POINT(1 2)')).toBe(4326);
    });

    it('ST_GeomFromGeoJSON parses GeoJSON string', () => {
      expect(engine.ST_GeomFromGeoJSON('{"type":"Point","coordinates":[1,2]}'))
        .toBe('POINT(1 2)');
    });
  });

  describe('serialization / accessors', () => {
    it('ST_AsText from GeoJSON geometry', () => {
      expect(engine.ST_AsText({ type: 'Point', coordinates: [1, 2] })).toBe('POINT(1 2)');
    });

    it('ST_AsText from WKT string', () => {
      expect(engine.ST_AsText('POINT(1 2)')).toBe('POINT(1 2)');
    });

    it('ST_AsGeoJSON returns JSON string', () => {
      expect(engine.ST_AsGeoJSON('POINT(1 2)')).toContain('"Point"');
    });

    it('ST_AsGeoJSON with precision rounds coordinates', () => {
      const json = engine.ST_AsGeoJSON('POINT(1.23456 2.98765)', 2);
      const parsed = JSON.parse(json);
      expect(parsed.coordinates[0]).toBeCloseTo(1.23);
      expect(parsed.coordinates[1]).toBeCloseTo(2.99);
    });

    it('ST_AsBinary returns uppercase hex', () => {
      const hex = engine.ST_AsBinary('POINT(1 2)');
      expect(hex).toMatch(/^[0-9A-F]+$/);
      expect(hex.length).toBeGreaterThan(0);
    });

    it('ST_AsEWKT prefixes SRID', () => {
      expect(engine.ST_AsEWKT('POINT(1 2)')).toBe('SRID=4326;POINT(1 2)');
    });
  });

  describe('measurements', () => {
    it('ST_Length returns a number for LineString', () => {
      const v = engine.ST_Length('LINESTRING(0 0, 1 1)');
      expect(v).toBeGreaterThan(0);
    });

    it('ST_Length returns 0 for a Point', () => {
      expect(engine.ST_Length('POINT(0 0)')).toBe(0);
    });

    it('ST_Length returns 0 on invalid geometry', () => {
      expect(engine.ST_Length('garbage')).toBe(0);
    });

    it('ST_Area returns a number for Polygon', () => {
      expect(engine.ST_Area('POLYGON((0 0, 1 0, 1 1, 0 0))')).toBeGreaterThan(0);
    });

    it('ST_Area returns 0 on invalid geometry', () => {
      expect(engine.ST_Area('garbage')).toBe(0);
    });

    it('ST_Perimeter delegates to ST_Length', () => {
      expect(engine.ST_Perimeter('LINESTRING(0 0, 1 1)')).toBeGreaterThan(0);
    });

    it('ST_Distance returns a number for two points', () => {
      const d = engine.ST_Distance('POINT(0 0)', 'POINT(1 1)');
      expect(d).toBeGreaterThan(0);
    });

    it('ST_Distance returns 0 on invalid geometry', () => {
      expect(engine.ST_Distance('garbage', 'POINT(0 0)')).toBe(0);
    });

    it('ST_DWithin true when close', () => {
      expect(engine.ST_DWithin('POINT(0 0)', 'POINT(0.1 0.1)', 1)).toBe(true);
    });

    it('ST_DWithin false when far', () => {
      expect(engine.ST_DWithin('POINT(0 0)', 'POINT(10 10)', 1)).toBe(false);
    });

    it('ST_HausdorffDistance returns a number', () => {
      expect(engine.ST_HausdorffDistance('LINESTRING(0 0, 1 1)', 'LINESTRING(2 2, 3 3)'))
        .toBeGreaterThan(0);
    });

    it('ST_MaxDistance returns a number', () => {
      expect(engine.ST_MaxDistance('POINT(0 0)', 'POINT(3 4)')).toBeCloseTo(5);
    });

    it('ST_3DDistance returns euclidean distance', () => {
      expect(engine.ST_3DDistance('POINT(0 0 0)', 'POINT(3 4 0)')).toBeCloseTo(5);
    });
  });

  describe('spatial relationships', () => {
    it('ST_Equals for identical geometries', () => {
      expect(engine.ST_Equals('POINT(0 0)', 'POINT(0 0)')).toBe(true);
    });

    it('ST_Equals false for different geometries', () => {
      expect(engine.ST_Equals('POINT(0 0)', 'POINT(1 1)')).toBe(false);
    });

    it('ST_Equals false on invalid geometry', () => {
      expect(engine.ST_Equals('garbage', 'POINT(0 0)')).toBe(false);
    });

    it('ST_Intersects true for overlapping polygons', () => {
      expect(engine.ST_Intersects('POLYGON((0 0, 2 0, 2 2, 0 0))', 'POLYGON((1 1, 3 1, 3 3, 1 1))')).toBe(true);
    });

    it('ST_Contains', () => {
      expect(engine.ST_Contains('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))', 'POINT(5 5)')).toBe(true);
    });

    it('ST_Within', () => {
      expect(engine.ST_Within('POINT(5 5)', 'POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))')).toBe(true);
    });

    it('ST_Touches', () => {
      expect(typeof engine.ST_Touches('POINT(0 0)', 'POINT(1 1)')).toBe('boolean');
    });

    it('ST_Crosses', () => {
      expect(typeof engine.ST_Crosses('LINESTRING(0 0, 2 2)', 'LINESTRING(0 2, 2 0)')).toBe('boolean');
    });

    it('ST_Overlaps', () => {
      expect(typeof engine.ST_Overlaps('POLYGON((0 0, 2 0, 2 2, 0 0))', 'POLYGON((1 1, 3 1, 3 3, 1 1))')).toBe('boolean');
    });

    it('ST_Disjoint is negation of ST_Intersects', () => {
      const a = 'POINT(0 0)';
      const b = 'POINT(10 10)';
      expect(engine.ST_Disjoint(a, b)).toBe(!engine.ST_Intersects(a, b));
    });

    it('ST_Covers and ST_CoveredBy symmetric', () => {
      const a = 'POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))';
      const b = 'POINT(5 5)';
      expect(engine.ST_Covers(a, b)).toBe(true);
      expect(engine.ST_CoveredBy(b, a)).toBe(true);
    });
  });

  describe('geometry processing', () => {
    it('ST_Buffer returns a polygon', () => {
      const wkt = engine.ST_Buffer('POINT(0 0)', 1);
      expect(wkt).toContain('POLYGON');
    });

    it('ST_Buffer returns original on invalid geometry', () => {
      expect(engine.ST_Buffer('garbage', 1)).toBe('garbage');
    });

    it('ST_Intersection of overlapping polygons', () => {
      const wkt = engine.ST_Intersection('POLYGON((0 0, 2 0, 2 2, 0 0))', 'POLYGON((1 1, 3 1, 3 3, 1 1))');
      expect(wkt).toContain('POLYGON');
    });

    it('ST_Intersection of disjoint returns POLYGON EMPTY', () => {
      expect(engine.ST_Intersection('POINT(0 0)', 'POINT(10 10)')).toBe('POLYGON EMPTY');
    });

    it('ST_Union returns geometry', () => {
      const wkt = engine.ST_Union('POINT(0 0)', 'POINT(1 1)');
      expect(wkt).toContain('POINT');
    });

    it('ST_Difference returns geometry', () => {
      const wkt = engine.ST_Difference('POLYGON((0 0, 10 0, 10 10, 0 0))', 'POLYGON((0 0, 5 0, 5 5, 0 0))');
      expect(wkt).toContain('POLYGON');
    });

    it('ST_SymDifference returns geometry', () => {
      const wkt = engine.ST_SymDifference('POLYGON((0 0, 2 0, 2 2, 0 0))', 'POLYGON((1 1, 3 1, 3 3, 1 1))');
      expect(wkt).toContain('POLYGON');
    });

    it('ST_Centroid returns a point', () => {
      expect(engine.ST_Centroid('POLYGON((0 0, 2 0, 2 2, 0 0))')).toContain('POINT');
    });

    it('ST_ConvexHull returns geometry', () => {
      expect(engine.ST_ConvexHull('MULTIPOINT(0 0, 1 1, 0 1)')).toContain('POLYGON');
    });

    it('ST_Envelope returns a bbox polygon', () => {
      expect(engine.ST_Envelope('LINESTRING(0 0, 1 1)'))
        .toBe('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))');
    });

    it('ST_Simplify returns geometry', () => {
      expect(engine.ST_Simplify('LINESTRING(0 0, 1 0, 2 0, 3 0)', 0.5)).toContain('LINESTRING');
    });

    it('ST_Transform records new SRID and returns geometry', () => {
      const wkt = 'POINT(1 2)';
      engine.ST_SetSRID(wkt, 4326);
      const out = engine.ST_Transform(wkt, 3857);
      expect(out).toBe(wkt);
      expect(engine.ST_SRID(wkt)).toBe(3857);
    });
  });

  describe('accessors', () => {
    it('ST_X returns longitude of a point', () => {
      expect(engine.ST_X('POINT(5 6)')).toBe(5);
    });

    it('ST_Y returns latitude of a point', () => {
      expect(engine.ST_Y('POINT(5 6)')).toBe(6);
    });

    it('ST_Z returns Z coordinate', () => {
      expect(engine.ST_Z('POINT(1 2 3)')).toBe(3);
    });

    it('ST_Z returns NaN for a 2D point (?? NaN branch)', () => {
      expect(Number.isNaN(engine.ST_Z('POINT(1 2)'))).toBe(true);
    });

    it('ST_Z returns NaN for non-point', () => {
      expect(Number.isNaN(engine.ST_Z('LINESTRING(0 0, 1 1)'))).toBe(true);
    });

    it('ST_M delegates to ST_Z', () => {
      expect(engine.ST_M('POINT(1 2 3)')).toBe(3);
    });

    it('ST_GeometryType returns ST_ prefixed name', () => {
      expect(engine.ST_GeometryType('POINT(1 2)')).toBe('ST_Point');
    });

    it('ST_GeometryType returns ST_Unknown on invalid', () => {
      expect(engine.ST_GeometryType('garbage')).toBe('ST_Unknown');
    });

    it('ST_NPoints counts points', () => {
      expect(engine.ST_NPoints('LINESTRING(0 0, 1 1, 2 2)')).toBe(3);
    });

    it('ST_NumGeometries counts constituent geometries', () => {
      expect(engine.ST_NumGeometries('MULTIPOINT(0 0, 1 1)')).toBe(2);
      expect(engine.ST_NumGeometries('POINT(0 0)')).toBe(1);
      expect(engine.ST_NumGeometries('GEOMETRYCOLLECTION(POINT(0 0), POINT(1 1))')).toBe(2);
    });

    it('ST_IsValid for valid geometry', () => {
      expect(engine.ST_IsValid('POINT(0 0)')).toBe(true);
    });

    it('ST_IsEmpty false for point, true for empty', () => {
      expect(engine.ST_IsEmpty('POINT(0 0)')).toBe(false);
    });

    it('ST_IsSimple for a point', () => {
      expect(engine.ST_IsSimple('POINT(0 0)')).toBe(true);
    });
  });

  describe('setters / SRID management', () => {
    it('ST_SetSRID sets and returns geometry', () => {
      const wkt = 'POINT(1 2)';
      expect(engine.ST_SetSRID(wkt, 3857)).toBe(wkt);
      expect(engine.ST_SRID(wkt)).toBe(3857);
    });

    it('registerSRID and getSRID', () => {
      engine.registerSRID('POINT(9 9)', 1234);
      expect(engine.getSRID('POINT(9 9)')).toBe(1234);
    });

    it('getSRID returns undefined for unknown geometry', () => {
      expect(engine.getSRID('POINT(777 777)')).toBeUndefined();
    });

    it('clearSRIDRegistry wipes registrations', () => {
      engine.registerSRID('POINT(5 5)', 111);
      engine.clearSRIDRegistry();
      expect(engine.getSRID('POINT(5 5)')).toBeUndefined();
    });
  });

  describe('legacy aliases', () => {
    it('distance/length/area aliases', () => {
      expect(engine.distance('POINT(0 0)', 'POINT(1 1)')).toBeGreaterThan(0);
      expect(engine.length('LINESTRING(0 0, 1 1)')).toBeGreaterThan(0);
      expect(engine.area('POLYGON((0 0, 1 0, 1 1, 0 0))')).toBeGreaterThan(0);
    });

    it('relationship aliases', () => {
      expect(typeof engine.intersects('POINT(0 0)', 'POINT(0 0)')).toBe('boolean');
      expect(typeof engine.contains('POLYGON((0 0, 2 0, 2 2, 0 0))', 'POINT(1 1)')).toBe('boolean');
      expect(typeof engine.within('POINT(1 1)', 'POLYGON((0 0, 2 0, 2 2, 0 0))')).toBe('boolean');
      expect(typeof engine.crosses('LINESTRING(0 0, 2 2)', 'LINESTRING(0 2, 2 0)')).toBe('boolean');
      expect(typeof engine.overlaps('POLYGON((0 0, 2 0, 2 2, 0 0))', 'POLYGON((1 1, 3 1, 3 3, 1 1))')).toBe('boolean');
      expect(typeof engine.touches('POINT(0 0)', 'POINT(1 1)')).toBe('boolean');
    });

    it('set operation aliases', () => {
      expect(engine.union('POINT(0 0)', 'POINT(1 1)')).toContain('POINT');
      expect(engine.difference('POLYGON((0 0, 10 0, 10 10, 0 0))', 'POLYGON((0 0, 5 0, 5 5, 0 0))')).toContain('POLYGON');
      expect(engine.symmetricDifference('POLYGON((0 0, 2 0, 2 2, 0 0))', 'POLYGON((1 1, 3 1, 3 3, 1 1))')).toContain('POLYGON');
    });

    it('processing aliases', () => {
      expect(engine.buffer('POINT(0 0)', 1)).toContain('POLYGON');
      expect(engine.simplify('LINESTRING(0 0, 1 0, 2 0)', 0.5)).toContain('LINESTRING');
      expect(engine.transform('POINT(0 0)', 3857)).toBe('POINT(0 0)');
    });

    it('construction aliases', () => {
      expect(engine.makePoint(1, 2)).toBe('POINT(1 2)');
      expect(engine.makeLine(['POINT(0 0)', 'POINT(1 1)'])).toBe('LINESTRING(0 0, 1 1)');
      expect(engine.collect('POINT(0 0)', 'POINT(1 1)')).toContain('MULTIPOINT');
      expect(engine.envelope('LINESTRING(0 0, 1 1)')).toContain('POLYGON');
      expect(engine.makeEnvelope(0, 0, 1, 1)).toContain('POLYGON');
    });
  });

  describe('SQL function detection and rewriting', () => {
    it('detectStCall finds ST_ function calls', () => {
      expect(PostGISEngine.detectStCall('SELECT ST_Distance(a, b) FROM t')).toBe(true);
    });

    it('detectStCall ignores non-ST SQL', () => {
      expect(PostGISEngine.detectStCall('SELECT 1')).toBe(false);
    });

    it('rewriteStCall execute mode wraps SQL', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_Distance(a, b)', 'execute'))
        .toContain('POSTGIS_EXECUTE');
    });

    it('rewriteStCall rewrite mode replaces ST_Distance', () => {
      const out = PostGISEngine.rewriteStCall('SELECT ST_Distance(a, b) FROM t', 'rewrite');
      expect(out).toContain('0.0');
    });

    it('rewriteStCall rewrite mode replaces ST_Contains', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_Contains(a, b)', 'rewrite')).toContain('1');
    });

    it('rewriteStCall rewrite mode passthrough ST_GeomFromText', () => {
      expect(PostGISEngine.rewriteStCall("SELECT ST_GeomFromText('POINT(1 2)', 4326)", 'rewrite'))
        .toContain('POINT(1 2)');
    });
  });

  describe('additional branch coverage', () => {
    it('ST_MakePoint with null Z', () => {
      expect(engine.ST_MakePoint(1, 2, undefined)).toBe('POINT(1 2)');
    });

    it('ST_X on a non-point returns center coordinate', () => {
      const v = engine.ST_X('LINESTRING(0 0, 2 2)');
      expect(v).toBeCloseTo(1);
    });

    it('ST_X returns NaN on invalid geometry', () => {
      expect(Number.isNaN(engine.ST_X('garbage'))).toBe(true);
    });

    it('ST_Y returns NaN on invalid geometry', () => {
      expect(Number.isNaN(engine.ST_Y('garbage'))).toBe(true);
    });

    it('ST_IsSimple false on invalid geometry', () => {
      expect(engine.ST_IsSimple('garbage')).toBe(false);
    });

    it('ST_IsValid false on invalid geometry', () => {
      expect(engine.ST_IsValid('garbage')).toBe(false);
    });
  });

  describe('measurements: perimeter branch + error handling', () => {
    it('ST_Length returns perimeter for a Polygon', () => {
      const v = engine.ST_Length('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))');
      expect(v).toBeGreaterThan(0);
    });

    it('ST_Length returns perimeter for a MultiPolygon', () => {
      const v = engine.ST_Length('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)))');
      expect(v).toBeGreaterThan(0);
    });

    it('ST_HausdorffDistance returns 0 on invalid geometry', () => {
      expect(engine.ST_HausdorffDistance('garbage', 'POINT(0 0)')).toBe(0);
    });

    it('ST_MaxDistance returns 0 on invalid geometry', () => {
      expect(engine.ST_MaxDistance('garbage', 'POINT(0 0)')).toBe(0);
    });

    it('ST_3DDistance returns 0 on invalid geometry', () => {
      expect(engine.ST_3DDistance('garbage', 'POINT(0 0)')).toBe(0);
    });

    it('ST_HausdorffDistance flattens MultiPoint input via toPositionArray', () => {
      expect(engine.ST_HausdorffDistance('MULTIPOINT(0 0, 1 1)', 'MULTIPOINT(10 10, 11 11)'))
        .toBeGreaterThan(0);
    });

    it('ST_MaxDistance handles MultiPolygon via toPositionArray', () => {
      const d = engine.ST_MaxDistance('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)))', 'POINT(10 10)');
      expect(d).toBeGreaterThan(0);
    });

    it('ST_HausdorffDistance flattens Polygon + GeometryCollection', () => {
      const d = engine.ST_HausdorffDistance(
        'POLYGON((0 0, 2 0, 2 2, 0 0))',
        'GEOMETRYCOLLECTION(POINT(10 10), LINESTRING(11 11, 12 12))',
      );
      expect(d).toBeGreaterThan(0);
    });
  });

  describe('relationship + processing error branches', () => {
    it('ST_Equals false on invalid geometry', () => {
      expect(engine.ST_Equals('garbage', 'POINT(0 0)')).toBe(false);
    });

    it('ST_Intersects false on invalid geometry', () => {
      expect(engine.ST_Intersects('garbage', 'POINT(0 0)')).toBe(false);
    });

    it('ST_Contains false on invalid geometry', () => {
      expect(engine.ST_Contains('garbage', 'POINT(0 0)')).toBe(false);
    });

    it('ST_Within false on invalid geometry', () => {
      expect(engine.ST_Within('garbage', 'POINT(0 0)')).toBe(false);
    });

    it('ST_Touches false on invalid geometry', () => {
      expect(engine.ST_Touches('garbage', 'POINT(0 0)')).toBe(false);
    });

    it('ST_Crosses false on invalid geometry', () => {
      expect(engine.ST_Crosses('garbage', 'POINT(0 0)')).toBe(false);
    });

    it('ST_Overlaps false on invalid geometry', () => {
      expect(engine.ST_Overlaps('garbage', 'POINT(0 0)')).toBe(false);
    });

    it('ST_Covers false on invalid geometry', () => {
      expect(engine.ST_Covers('garbage', 'POINT(0 0)')).toBe(false);
    });

    it('ST_Intersection returns POLYGON EMPTY on invalid geometry', () => {
      expect(engine.ST_Intersection('garbage', 'POINT(0 0)')).toBe('POLYGON EMPTY');
    });

    it('ST_Union returns first arg on invalid geometry', () => {
      expect(engine.ST_Union('garbage', 'POINT(0 0)')).toBe('garbage');
    });

    it('ST_Difference returns first arg on invalid geometry', () => {
      expect(engine.ST_Difference('garbage', 'POINT(0 0)')).toBe('garbage');
    });

    it('ST_SymDifference returns first arg when both differences null', () => {
      expect(engine.ST_SymDifference('POINT(0 0)', 'POINT(0 0)')).toContain('POINT');
    });

    it('ST_Centroid returns POINT(0 0) on invalid geometry', () => {
      expect(engine.ST_Centroid('garbage')).toBe('POINT(0 0)');
    });

    it('ST_ConvexHull returns original on invalid geometry', () => {
      expect(engine.ST_ConvexHull('garbage')).toBe('garbage');
    });

    it('ST_Envelope returns original on invalid geometry', () => {
      expect(engine.ST_Envelope('garbage')).toBe('garbage');
    });

    it('ST_Simplify returns original on invalid geometry', () => {
      expect(engine.ST_Simplify('garbage', 0.5)).toBe('garbage');
    });
  });

  describe('accessors: multi-geometry branches', () => {
    it('ST_X returns center for a non-point geometry', () => {
      const v = engine.ST_X('LINESTRING(0 0, 2 2)');
      expect(v).toBeCloseTo(1);
    });

    it('ST_X returns NaN on invalid geometry', () => {
      expect(Number.isNaN(engine.ST_X('garbage'))).toBe(true);
    });

    it('ST_Y returns center for a Polygon', () => {
      const v = engine.ST_Y('POLYGON((0 0, 2 0, 2 2, 0 2, 0 0))');
      expect(v).toBeCloseTo(1);
    });

    it('ST_Y returns NaN on invalid geometry', () => {
      expect(Number.isNaN(engine.ST_Y('garbage'))).toBe(true);
    });

    it('ST_Z returns NaN on invalid geometry', () => {
      expect(Number.isNaN(engine.ST_Z('garbage'))).toBe(true);
    });

    it('ST_GeometryType accepts a GeoJSON object directly', () => {
      expect(engine.ST_GeometryType({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }))
        .toBe('ST_LineString');
    });

    it('ST_NPoints counts coords of MultiLineString', () => {
      expect(engine.ST_NPoints('MULTILINESTRING((0 0, 1 1, 2 2),(3 3, 4 4))')).toBe(5);
    });

    it('ST_NPoints counts coords of a Polygon (all rings)', () => {
      expect(engine.ST_NPoints('POLYGON((0 0, 1 0, 1 1, 0 0))')).toBe(4);
    });

    it('ST_NPoints counts coords of MultiPolygon', () => {
      expect(engine.ST_NPoints('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)))')).toBe(4);
    });

    it('ST_NPoints counts coords of GeometryCollection', () => {
      expect(engine.ST_NPoints('GEOMETRYCOLLECTION(POINT(0 0), LINESTRING(0 0, 1 1))')).toBe(3);
    });

    it('ST_NPoints returns 0 on invalid geometry', () => {
      expect(engine.ST_NPoints('garbage')).toBe(0);
    });

    it('ST_NumGeometries MultiLineString and MultiPolygon', () => {
      expect(engine.ST_NumGeometries('MULTILINESTRING((0 0, 1 1),(2 2, 3 3))')).toBe(2);
      expect(engine.ST_NumGeometries('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)),((2 2, 3 2, 3 3, 2 2)))')).toBe(2);
    });

    it('ST_NumGeometries returns 0 on invalid geometry', () => {
      expect(engine.ST_NumGeometries('garbage')).toBe(0);
    });

    it('ST_IsEmpty false for non-empty LineString', () => {
      expect(engine.ST_IsEmpty('LINESTRING(0 0, 1 1)')).toBe(false);
    });

    it('ST_IsEmpty true on invalid geometry (fail-closed)', () => {
      expect(engine.ST_IsEmpty('garbage')).toBe(true);
    });

    it('ST_IsSimple for a LineString without kinks', () => {
      expect(engine.ST_IsSimple('LINESTRING(0 0, 1 1, 2 2)')).toBe(true);
    });

    it('ST_IsSimple for a valid Polygon', () => {
      expect(engine.ST_IsSimple('POLYGON((0 0, 4 0, 4 4, 0 4, 0 0))')).toBe(true);
    });

    it('ST_IsSimple for a MultiLineString falls through to true', () => {
      expect(engine.ST_IsSimple('MULTILINESTRING((0 0, 1 1))')).toBe(true);
    });
  });

  describe('ST_MakePolygon holes', () => {
    it('creates a polygon with a hole', () => {
      const wkt = engine.ST_MakePolygon(
        'LINESTRING(0 0, 10 0, 10 10, 0 10, 0 0)',
        ['LINESTRING(2 2, 3 2, 3 3, 2 3, 2 2)'],
      );
      expect(wkt).toContain('POLYGON');
    });

    it('closes an unclosed hole ring', () => {
      const wkt = engine.ST_MakePolygon(
        'LINESTRING(0 0, 10 0, 10 10, 0 10, 0 0)',
        ['LINESTRING(2 2, 3 2, 3 3, 2 3)'],
      );
      expect(wkt).toContain('POLYGON');
    });

    it('ignores a hole ring with fewer than 3 points', () => {
      const wkt = engine.ST_MakePolygon(
        'LINESTRING(0 0, 10 0, 10 10, 0 10, 0 0)',
        ['LINESTRING(2 2, 3 3)'],
      );
      expect(wkt).toContain('POLYGON');
    });

    it('throws on non-LineString hole ring', () => {
      expect(() => engine.ST_MakePolygon(
        'LINESTRING(0 0, 10 0, 10 10, 0 10, 0 0)',
        ['POINT(2 2)'],
      )).toThrowError(/Only LineString/);
    });

    it('throws on non-LineString outer ring', () => {
      expect(() => engine.ST_MakePolygon('POINT(0 0)'))
        .toThrowError(/Only LineString/);
    });

    it('throws when outer ring has fewer than 3 points', () => {
      expect(() => engine.ST_MakePolygon('LINESTRING(0 0, 1 1)'))
        .toThrowError(/at least 3 points/);
    });
  });

  describe('rewriteStCall full matrix', () => {
    it('replaces ST_Distance', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_Distance(a, b)', 'rewrite')).toContain('0.0');
    });

    it('replaces ST_Contains', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_Contains(a, b)', 'rewrite')).toContain('1');
    });

    it('replaces ST_Intersects', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_Intersects(a, b)', 'rewrite')).toContain('0');
    });

    it('replaces ST_Length', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_Length(a)', 'rewrite')).toContain('0.0');
    });

    it('replaces ST_Area', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_Area(a)', 'rewrite')).toContain('0.0');
    });

    it('replaces ST_X', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_X(a)', 'rewrite')).toContain('0.0');
    });

    it('replaces ST_Y', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_Y(a)', 'rewrite')).toContain('0.0');
    });

    it('replaces ST_AsText', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_AsText(a)', 'rewrite')).toContain('POINT(0 0)');
    });

    it('replaces ST_AsGeoJSON', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_AsGeoJSON(a)', 'rewrite')).toContain('Point');
    });

    it('passes through ST_GeomFromText', () => {
      expect(PostGISEngine.rewriteStCall("ST_GeomFromText('POINT(1 2)', 4326)", 'rewrite'))
        .toContain('POINT(1 2)');
    });

    it('replaces ST_GeomFromGeoJSON', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_GeomFromGeoJSON(a)', 'rewrite')).toContain('POINT(0 0)');
    });

    it('generic fallback replaces an unknown ST_ function', () => {
      expect(PostGISEngine.rewriteStCall('SELECT ST_FooBar(a)', 'rewrite')).toContain('0 /* ST_FooBar() replaced */');
    });
  });

  describe('ST_AsGeoJSON precision rounding deep structures', () => {
    it('rounds nested MultiPolygon coordinates', () => {
      const json = engine.ST_AsGeoJSON('MULTIPOLYGON(((0.12345 0.98765, 1.23456 1.98765, 2 2, 0.12345 0.98765)))', 2);
      const parsed = JSON.parse(json);
      expect(parsed.coordinates[0][0][0][0]).toBeCloseTo(0.12);
    });

    it('rounds a point with Z coordinate', () => {
      const json = engine.ST_AsGeoJSON('POINT(1.23456 2.98765 3.45678)', 1);
      const parsed = JSON.parse(json);
      expect(parsed.coordinates[2]).toBeCloseTo(3.5);
    });
  });

  describe('ST_AsBinary / ST_AsEWKT internal helpers', () => {
    it('ST_AsBinary encodes a multi-geometry via extractCoords', () => {
      const hex = engine.ST_AsBinary('MULTIPOINT(0 0, 1 1)');
      expect(hex).toMatch(/^[0-9A-F]+$/);
    });

    it('ST_AsBinary encodes a GeometryCollection', () => {
      const hex = engine.ST_AsBinary('GEOMETRYCOLLECTION(POINT(0 0), POINT(1 1))');
      expect(hex).toMatch(/^[0-9A-F]+$/);
    });

    it('ST_AsEWKT uses registered SRID', () => {
      engine.registerSRID('POINT(7 7)', 9999);
      expect(engine.ST_AsEWKT('POINT(7 7)')).toBe('SRID=9999;POINT(7 7)');
    });
  });

  describe('edge cases for full branch coverage', () => {
    it('ST_MakeLine with a single point returns a degenerate LineString', () => {
      const wkt = engine.ST_MakeLine(['POINT(1 1)']);
      expect(wkt).toContain('LINESTRING');
      expect(wkt).toContain('1 1');
    });

    it('ST_Collect homogeneous Polygons return MULTIPOLYGON', () => {
      const wkt = engine.ST_Collect(
        'POLYGON((0 0, 1 0, 1 1, 0 0))',
        'POLYGON((2 2, 3 2, 3 3, 2 2))',
      );
      expect(wkt).toContain('MULTIPOLYGON');
    });

    it('ST_Union of overlapping polygons returns a merged polygon', () => {
      const wkt = engine.ST_Union(
        'POLYGON((0 0, 2 0, 2 2, 0 2, 0 0))',
        'POLYGON((1 1, 3 1, 3 3, 1 3, 1 1))',
      );
      expect(wkt).toContain('POLYGON');
      expect(wkt).not.toBe('POLYGON((0 0, 2 0, 2 2, 0 2, 0 0))');
    });

    it('ST_Union of disjoint points falls back to first arg', () => {
      expect(engine.ST_Union('POINT(0 0)', 'POINT(1 1)')).toBe('POINT(0 0)');
    });

    it('ST_SymDifference where only the first difference is non-null', () => {
      const wkt = engine.ST_SymDifference(
        'POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))',
        'POLYGON((0 0, 2 0, 2 2, 0 2, 0 0))',
      );
      expect(wkt).toContain('POLYGON');
    });

    it('intersection alias delegates to ST_Intersection', () => {
      expect(engine.intersection('POINT(0 0)', 'POINT(0 0)')).toBe('POLYGON EMPTY');
    });

    it('convexHull alias delegates to ST_ConvexHull', () => {
      expect(engine.convexHull('POINT(0 0)')).toBe('POINT(0 0)');
    });

    it('makePolygon alias delegates to ST_MakePolygon with holes', () => {
      expect(engine.makePolygon('LINESTRING(0 0, 10 0, 10 10, 0 10, 0 0)')).toContain('POLYGON');
    });

    it('countCoords MultiPoint branch via ST_NPoints', () => {
      expect(engine.ST_NPoints('MULTIPOINT(0 0, 1 1, 2 2)')).toBe(3);
    });

    it('ST_AsText accepts a GeoJSON object directly', () => {
      expect(engine.ST_AsText({ type: 'Point', coordinates: [1, 2] })).toBe('POINT(1 2)');
    });

    it('ST_AsGeoJSON accepts a GeoJSON object directly', () => {
      expect(engine.ST_AsGeoJSON({ type: 'Point', coordinates: [1, 2] })).toContain('"Point"');
    });

    it('ST_AsBinary accepts a GeoJSON object directly', () => {
      expect(engine.ST_AsBinary({ type: 'Point', coordinates: [1, 2] })).toMatch(/^[0-9A-F]+$/);
    });

    it('ST_AsEWKT accepts a GeoJSON object directly', () => {
      expect(engine.ST_AsEWKT({ type: 'Point', coordinates: [1, 2] })).toBe('SRID=4326;POINT(1 2)');
    });

    it('ST_GeomFromText without srid does not register a SRID', () => {
      const g = engine.ST_GeomFromText('POINT(5 5)');
      expect(g.type).toBe('Point');
      expect(engine.getSRID('POINT(5 5)')).toBeUndefined();
    });

    it('ST_MakeLine flattens a MultiPoint via the non-catch branch', () => {
      expect(engine.ST_MakeLine(['MULTIPOINT(0 0, 1 1, 2 2)'])).toContain('LINESTRING');
    });

    it('ST_Covers returns true for identical geometries (booleanEqual branch)', () => {
      expect(engine.ST_Covers('POINT(0 0)', 'POINT(0 0)')).toBe(true);
    });

    it('ST_3DDistance uses ?? 0 default when coordinate is missing', () => {
      const d = engine.ST_3DDistance('LINESTRING(0 0, 1 1)', 'LINESTRING(3 4, 4 5)');
      expect(d).toBeGreaterThan(0);
    });

    it('parses an empty GEOMETRYCOLLECTION', () => {
      const g = wktToGeoJSON('GEOMETRYCOLLECTION()');
      expect(g.type).toBe('GeometryCollection');
      expect((g as GeoJSON.GeometryCollection).geometries).toEqual([]);
    });

    it('parses a nested MULTILINESTRING with multiple lines', () => {
      const g = wktToGeoJSON('MULTILINESTRING((0 0, 1 1),(2 2, 3 3),(4 4, 5 5))');
      expect(g.type).toBe('MultiLineString');
      expect((g.coordinates as number[][][]).length).toBe(3);
    });

    it('ST_Intersection of disjoint polygons returns POLYGON EMPTY (null branch)', () => {
      expect(engine.ST_Intersection(
        'POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))',
        'POLYGON((10 10, 11 10, 11 11, 10 11, 10 10))',
      )).toBe('POLYGON EMPTY');
    });

    it('ST_Difference where b fully covers a returns first arg (null branch)', () => {
      const a = 'POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))';
      expect(engine.ST_Difference(a, 'POLYGON((-1 -1, 2 -1, 2 2, -1 2, -1 -1))')).toBe(a);
    });

    it('ST_Difference of identical polygons returns first arg (null branch)', () => {
      const a = 'POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))';
      expect(engine.ST_Difference(a, a)).toBe(a);
    });

    it('ST_Buffer with radius 0 returns original geometry (null buffer branch)', () => {
      expect(engine.ST_Buffer('POINT(0 0)', 0)).toBe('POINT(0 0)');
    });

    const allGeomTypes = [
      'POINT(1 2)',
      'MULTIPOINT(0 0, 1 1)',
      'LINESTRING(0 0, 1 1, 2 2)',
      'MULTILINESTRING((0 0, 1 1),(2 2, 3 3))',
      'POLYGON((0 0, 4 0, 4 4, 0 4, 0 0))',
      'MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)),((2 2, 3 2, 3 3, 2 3, 2 2)))',
      'GEOMETRYCOLLECTION(POINT(0 0), LINESTRING(0 0, 1 1))',
    ];

    it('ST_AsBinary exercises every extractCoords switch case', () => {
      for (const wkt of allGeomTypes) {
        expect(engine.ST_AsBinary(wkt)).toMatch(/^[0-9A-F]+$/);
      }
    });

    it('ST_NPoints exercises every countCoords switch case', () => {
      for (const wkt of allGeomTypes) {
        expect(engine.ST_NPoints(wkt)).toBeGreaterThanOrEqual(1);
      }
    });

    it('ST_HausdorffDistance exercises every toPositionArray switch case', () => {
      for (const wkt of allGeomTypes) {
        expect(engine.ST_HausdorffDistance(wkt, 'POINT(100 100)')).toBeGreaterThan(0);
      }
    });

    it('ST_MakeLine MultiPoint branch produces a valid LineString', () => {
      expect(engine.ST_MakeLine(['MULTIPOINT(0 0, 1 1, 2 2)'])).toBe('LINESTRING(0 0, 1 1, 2 2)');
    });

    it('ST_MakeLine skips non-point/non-multipoint input (else-if false branch)', () => {
      expect(engine.ST_MakeLine(['LINESTRING(0 0, 1 1)'])).toBe('LINESTRING EMPTY');
    });

    it('getSRID accepts a GeoJSON object directly', () => {
      engine.registerSRID('POINT(3 4)', 7777);
      expect(engine.getSRID({ type: 'Point', coordinates: [3, 4] })).toBe(7777);
    });

    it('ST_SymDifference with partial overlap unions both differences', () => {
      const wkt = engine.ST_SymDifference(
        'POLYGON((0 0, 2 0, 2 2, 0 2, 0 0))',
        'POLYGON((1 1, 3 1, 3 3, 1 3, 1 1))',
      );
      expect(wkt).toContain('MULTIPOLYGON');
    });

    it('ST_SymDifference where a is fully inside b uses only diffBA', () => {
      const wkt = engine.ST_SymDifference(
        'POLYGON((1 1, 2 1, 2 2, 1 2, 1 1))',
        'POLYGON((0 0, 3 0, 3 3, 0 3, 0 0))',
      );
      expect(wkt).toContain('POLYGON');
    });

    it('ST_SymDifference of identical polygons returns the original (both null branch)', () => {
      const a = 'POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))';
      expect(engine.ST_SymDifference(a, a)).toBe(a);
    });

    // ── WKT parser boundary branches (nested parentheses, empty parts) ──

    it('parses GEOMETRYCOLLECTION with only separators (break branch)', () => {
      expect(wktToGeoJSON('GEOMETRYCOLLECTION( , , )').type).toBe('GeometryCollection');
    });

    it('parses GEOMETRYCOLLECTION with nested MULTIPOINT (inner close branch)', () => {
      const g = wktToGeoJSON('GEOMETRYCOLLECTION(MULTIPOINT((0 0),(1 1)))');
      expect(g.type).toBe('GeometryCollection');
      expect((g as GeoJSON.GeometryCollection).geometries).toHaveLength(1);
    });

    it('parses MULTIPOLYGON with deeply nested empty ring (rings.length===0 branch)', () => {
      const g = wktToGeoJSON('MULTIPOLYGON((()))');
      expect(g.type).toBe('MultiPolygon');
    });

    it('parses MULTILINESTRING with extra parentheses (depth!==1 branch)', () => {
      const g = wktToGeoJSON('MULTILINESTRING(((0 0,1 1)))');
      expect(g.type).toBe('MultiLineString');
    });

    it('parses MULTIPOLYGON with multi-level nesting (depth!==0 branch)', () => {
      const g = wktToGeoJSON('MULTIPOLYGON((((0 0,1 0,1 1,0 0))),((2 2,3 2,3 3,2 2))))');
      expect(g.type).toBe('MultiPolygon');
    });
  });
});
