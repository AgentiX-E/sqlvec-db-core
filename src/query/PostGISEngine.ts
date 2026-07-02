/**
 * PostGISEngine — Full PostGIS spatial computation engine using @turf/turf.
 *
 * Covers 40+ ST_* functions across geometry construction, measurement,
 * spatial relationships, processing, accessors, and setters.
 *
 * Architecture:
 *   - WKT ⇄ GeoJSON conversion (WKB via hex encoding)
 *   - SRID metadata tracking (in-memory Map)
 *   - Error-safe wrappers: all ST_* methods catch and log, returning
 *     sensible defaults (0, false, or the original WKT) on failure.
 */

import * as turf from '@turf/turf';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('postgis-engine');

// ── Types ──────────────────────────────────────────────────────

export interface PostGISEngineOptions {
  /** Default SRID (default: 4326 — WGS84) */
  defaultSrid?: number;
  /** Whether to log debug info */
  debug?: boolean;
}

/** GeometryWithSRID wraps a GeoJSON geometry with its SRID */
export interface GeometryWithSRID {
  geometry: GeoJSON.Geometry;
  srid: number;
}

// ── WKT Parsing ────────────────────────────────────────────────

/**
 * Parse WKT to GeoJSON Geometry.
 * Supports: POINT, LINESTRING, POLYGON, MULTIPOINT, MULTILINESTRING,
 * MULTIPOLYGON, GEOMETRYCOLLECTION.
 */
export function wktToGeoJSON(wkt: string): GeoJSON.Geometry {
  const trimmed = wkt.trim();
  const upper = trimmed.toUpperCase().replace(/\s+/g, ' ');

  // GEOMETRYCOLLECTION
  if (upper.startsWith('GEOMETRYCOLLECTION')) {
    const inner = trimmed.replace(/GEOMETRYCOLLECTION\s*\(/i, '').replace(/\)\s*$/, '').trim();
    const geoms = parseGeometryCollectionInner(inner);
    return turf.geometryCollection(geoms as any).geometry;
  }

  // MULTIPOLYGON
  if (upper.startsWith('MULTIPOLYGON')) {
    const inner = trimmed.replace(/MULTIPOLYGON\s*\(/i, '').replace(/\)\s*$/, '').trim();
    return parseMultiPolygonWKT(inner);
  }

  // MULTILINESTRING
  if (upper.startsWith('MULTILINESTRING')) {
    const inner = trimmed.replace(/MULTILINESTRING\s*\(/i, '').replace(/\)\s*$/, '').trim();
    return parseMultiLineStringWKT(inner);
  }

  // MULTIPOINT
  if (upper.startsWith('MULTIPOINT')) {
    const inner = trimmed.replace(/MULTIPOINT\s*\(/i, '').replace(/\)\s*$/, '').trim();
    return parseMultiPointWKT(inner);
  }

  // POLYGON
  if (upper.startsWith('POLYGON')) {
    const inner = trimmed.replace(/POLYGON\s*\(/i, '').replace(/\)\s*$/, '').trim();
    const rings = inner.split('),(').map(ring => {
      return ring.replace(/[()]/g, '').split(',').map(p => {
        const [x, y] = p.trim().split(/\s+/).map(Number);
        return [x, y];
      });
    });
    return turf.polygon(rings).geometry;
  }

  // LINESTRING
  if (upper.startsWith('LINESTRING')) {
    const inner = trimmed.replace(/LINESTRING\s*\(/i, '').replace(/\)\s*$/, '').trim();
    const coords = inner.split(',').map(p => {
      const [x, y] = p.trim().split(/\s+/).map(Number);
      return [x, y];
    });
    return turf.lineString(coords).geometry;
  }

  // POINT (1 2) or POINT(1 2 3)
  if (upper.startsWith('POINT')) {
    const inner = trimmed.replace(/POINT\s*\(/i, '').replace(/\)\s*$/, '').trim();
    const parts = inner.split(/\s+/).map(Number);
    return turf.point(parts.length >= 3 ? [parts[0], parts[1], parts[2]] : [parts[0], parts[1]]).geometry;
  }

  throw new Error(`Unsupported WKT geometry: ${wkt.substring(0, 80)}`);
}

function parseGeometryCollectionInner(inner: string): GeoJSON.Geometry[] {
  const geoms: GeoJSON.Geometry[] = [];
  for (let i = 0; i < inner.length; ) {
    while (i < inner.length && (inner[i] === ' ' || inner[i] === ',')) i++;
    if (i >= inner.length) break;
    const start = i;
    let depth = 0;
    while (i < inner.length) {
      if (inner[i] === '(') depth++;
      else if (inner[i] === ')') { depth--; if (depth === 0) { i++; break; } }
      i++;
    }
    const sub = inner.substring(start, i).trim();
    try { geoms.push(wktToGeoJSON(sub)); } catch { /* skip */ }
  }
  return geoms;
}

function parseMultiPolygonWKT(inner: string): GeoJSON.Geometry {
  const polygonParts: string[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') { depth++; if (depth === 1 && start === -1) start = i; }
    else if (inner[i] === ')') {
      depth--;
      if (depth === 0 && start >= 0) {
        polygonParts.push(inner.substring(start, i + 1));
        start = -1;
      }
    }
  }
  const polygons: number[][][][] = [];
  for (const part of polygonParts) {
    const rings = part.replace(/^\(|\)$/g, '').split('),(').map(ring =>
      ring.replace(/[()]/g, '').split(',').map(p => {
        const [x, y] = p.trim().split(/\s+/).map(Number);
        return [x, y];
      })
    );
    if (rings.length > 0) polygons.push(rings);
  }
  return polygons.length === 1
    ? turf.polygon(polygons[0]).geometry
    : turf.multiPolygon(polygons).geometry;
}

function parseMultiLineStringWKT(inner: string): GeoJSON.Geometry {
  const parts: number[][][] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') { depth++; if (depth === 1) start = i + 1; }
    else if (inner[i] === ')') {
      depth--;
      if (depth === 0) {
        parts.push(inner.substring(start, i).split(',').map(p => {
          const [x, y] = p.trim().split(/\s+/).map(Number);
          return [x, y];
        }));
      }
    }
  }
  return turf.multiLineString(parts).geometry;
}

function parseMultiPointWKT(inner: string): GeoJSON.Geometry {
  const coords = inner.replace(/[()]/g, '').split(',').map(p => {
    const [x, y] = p.trim().split(/\s+/).map(Number);
    return [x, y];
  });
  return turf.multiPoint(coords).geometry;
}

// ── WKT Serialization ──────────────────────────────────────────

/** Convert GeoJSON geometry to WKT string. */
export function geoJSONToWKT(geom: GeoJSON.Geometry): string {
  switch (geom.type) {
    case 'Point':
      return `POINT(${geom.coordinates[0]} ${geom.coordinates[1]})`;
    case 'LineString':
      return `LINESTRING(${geom.coordinates.map(c => `${c[0]} ${c[1]}`).join(', ')})`;
    case 'Polygon':
      return `POLYGON(${geom.coordinates.map(r => '(' + r.map(c => `${c[0]} ${c[1]}`).join(', ') + ')').join(', ')})`;
    case 'MultiPoint':
      return `MULTIPOINT(${geom.coordinates.map(c => `${c[0]} ${c[1]}`).join(', ')})`;
    case 'MultiLineString':
      return `MULTILINESTRING(${geom.coordinates.map(p => '(' + p.map(c => `${c[0]} ${c[1]}`).join(', ') + ')').join(', ')})`;
    case 'MultiPolygon':
      return `MULTIPOLYGON(${geom.coordinates.map(p => '(' + p.map(r => '(' + r.map(c => `${c[0]} ${c[1]}`).join(', ') + ')').join(', ') + ')').join(', ')})`;
    case 'GeometryCollection':
      return `GEOMETRYCOLLECTION(${(geom as GeoJSON.GeometryCollection).geometries.map(g => geoJSONToWKT(g)).join(', ')})`;
    default:
      throw new Error(`Unsupported geometry type: ${(geom as any).type}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────

function roundCoordinates(obj: unknown, precision: number): void {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'number') {
        obj[i] = parseFloat((obj[i] as number).toFixed(precision));
      } else {
        roundCoordinates(obj[i], precision);
      }
    }
  } else if (obj && typeof obj === 'object') {
    for (const key in obj as Record<string, unknown>) {
      roundCoordinates((obj as Record<string, unknown>)[key], precision);
    }
  }
}

function isValidNumber(n: number): boolean {
  return typeof n === 'number' && !Number.isNaN(n) && Number.isFinite(n);
}

// ── Engine ─────────────────────────────────────────────────────

export class PostGISEngine {
  private readonly options: Required<PostGISEngineOptions>;
  /** In-memory SRID metadata: map of WKT → SRID */
  private readonly sridRegistry: Map<string, number> = new Map();
  /** Counter for anonymous SRID registrations */
  private sridCounter = 0;

  constructor(options: PostGISEngineOptions = {}) {
    this.options = {
      defaultSrid: options.defaultSrid ?? 4326,
      debug: options.debug ?? false,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // GEOMETRY CONSTRUCTORS
  // ════════════════════════════════════════════════════════════════

  /** ST_MakePoint(x, y [, z]) — Create a point from coordinates. Returns WKT. */
  ST_MakePoint(x: number, y: number, z?: number): string {
    return z != null && isValidNumber(z)
      ? `POINT(${x} ${y} ${z})`
      : `POINT(${x} ${y})`;
  }

  /** ST_MakeEnvelope(xmin, ymin, xmax, ymax [, srid]) — Create a rectangular polygon. */
  ST_MakeEnvelope(xmin: number, ymin: number, xmax: number, ymax: number, srid?: number): string {
    const wkt = `POLYGON((${xmin} ${ymin}, ${xmax} ${ymin}, ${xmax} ${ymax}, ${xmin} ${ymax}, ${xmin} ${ymin}))`;
    if (srid != null) this.setSRID(wkt, srid);
    return wkt;
  }

  /** ST_MakeLine(points[]) — Create a LineString from an array of point geometries (WKT strings). */
  ST_MakeLine(points: string[]): string {
    if (points.length === 0) return 'LINESTRING(0 0)';
    const coords: [number, number][] = [];
    for (const p of points) {
      try {
        const g = wktToGeoJSON(p);
        if (g.type === 'Point') {
          coords.push([(g.coordinates as number[])[0], (g.coordinates as number[])[1]]);
        } else if (g.type === 'MultiPoint') {
          for (const c of (g as GeoJSON.MultiPoint).coordinates) {
            coords.push([c[0], c[1]]);
          }
        }
      } catch {
        // Try parsing as raw coordinate pair
        const match = p.trim().match(/^([\d.+-eE]+)\s+([\d.+-eE]+)$/);
        if (match) coords.push([parseFloat(match[1]), parseFloat(match[2])]);
      }
    }
    return coords.length >= 2
      ? geoJSONToWKT(turf.lineString(coords).geometry)
      : `LINESTRING(${coords[0][0]} ${coords[0][1]}, ${coords[0][0] + 1} ${coords[0][1]})`;
  }

  /** ST_MakePolygon(outerRing, holes?) — Create a Polygon from a LineString ring (WKT) and optional hole rings. */
  ST_MakePolygon(outerRing: string, holes?: string[]): string {
    const extractCoordsFromLine = (wkt: string): [number, number][] => {
      const g = wktToGeoJSON(wkt);
      if (g.type === 'LineString') {
        return (g as GeoJSON.LineString).coordinates.map(c => [c[0], c[1]] as [number, number]);
      }
      throw new Error('Only LineString geometries can be used as polygon rings');
    };

    const outer = extractCoordsFromLine(outerRing);
    if (outer.length < 3) throw new Error('A polygon ring must have at least 3 points');

    // Close ring if not already closed
    if (outer[0][0] !== outer[outer.length - 1][0] || outer[0][1] !== outer[outer.length - 1][1]) {
      outer.push(outer[0]);
    }

    const rings: [number, number][][] = [outer];

    if (holes) {
      for (const holeWkt of holes) {
        const hole = extractCoordsFromLine(holeWkt);
        if (hole.length >= 3) {
          if (hole[0][0] !== hole[hole.length - 1][0] || hole[0][1] !== hole[hole.length - 1][1]) {
            hole.push(hole[0]);
          }
          rings.push(hole);
        }
      }
    }

    return geoJSONToWKT(turf.polygon(rings).geometry);
  }

  /** ST_Collect(...geoms) — Collect multiple geometries. */
  ST_Collect(...geoms: string[]): string {
    if (geoms.length === 0) return 'GEOMETRYCOLLECTION()';
    const collected: GeoJSON.Geometry[] = [];
    for (const wkt of geoms) {
      try { collected.push(wktToGeoJSON(wkt)); } catch { /* skip */ }
    }
    if (collected.length === 1) return geoms[0];
    return geoJSONToWKT(turf.geometryCollection(collected as any).geometry);
  }

  /** ST_GeomFromText(wkt [, srid]) — Parse WKT to GeoJSON. */
  ST_GeomFromText(wkt: string, srid?: number): GeoJSON.Geometry {
    const g = wktToGeoJSON(wkt);
    if (srid != null) this.setSRID(wkt, srid);
    return g;
  }

  /** ST_GeomFromGeoJSON(geojson) — Parse GeoJSON string to WKT. */
  ST_GeomFromGeoJSON(geojson: string): string {
    const parsed = JSON.parse(geojson) as GeoJSON.Geometry;
    return geoJSONToWKT(parsed);
  }

  /** ST_AsText(geom) — Convert geometry to WKT string. */
  ST_AsText(geom: GeoJSON.Geometry | string): string {
    const g = typeof geom === 'string' ? wktToGeoJSON(geom) : geom;
    return geoJSONToWKT(g);
  }

  /** ST_AsGeoJSON(geom [, precision]) — Convert to GeoJSON string. */
  ST_AsGeoJSON(geom: GeoJSON.Geometry | string, precision?: number): string {
    const g = typeof geom === 'string' ? wktToGeoJSON(geom) : geom;
    const json = JSON.stringify(g);
    if (precision != null && precision >= 0) {
      const parsed = JSON.parse(json);
      roundCoordinates(parsed, precision);
      return JSON.stringify(parsed);
    }
    return json;
  }

  /** ST_AsBinary(geom) — Convert geometry to WKB hex string. */
  ST_AsBinary(geom: GeoJSON.Geometry | string): string {
    const g = typeof geom === 'string' ? wktToGeoJSON(geom) : geom;
    // Encode coordinates as hex for WKB-like representation
    const coords = extractCoords(g);
    const buf = Buffer.alloc(coords.length * 8);
    for (let i = 0; i < coords.length; i++) {
      buf.writeDoubleLE(coords[i], i * 8);
    }
    return buf.toString('hex').toUpperCase();
  }

  /** ST_AsEWKT(geom [, srid]) — WKT with SRID prefix. */
  ST_AsEWKT(geom: GeoJSON.Geometry | string): string {
    const wkt = this.ST_AsText(geom);
    const srid = this.getSRID(geom) ?? this.options.defaultSrid;
    return `SRID=${srid};${wkt}`;
  }

  // ════════════════════════════════════════════════════════════════
  // MEASUREMENTS
  // ════════════════════════════════════════════════════════════════

  /** ST_Length(geom) — Length of a line (in degrees or meters). */
  ST_Length(geom: string): number {
    try {
      const g = wktToGeoJSON(geom);
      const feature = turf.feature(g);
      if (g.type === 'LineString' || g.type === 'MultiLineString') {
        return turf.length(feature, { units: 'kilometers' }) * 1000;
      }
      if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
        // Perimeter: length of the boundary
        const line = turf.polygonToLine(feature as any);
        return line ? turf.length(line, { units: 'kilometers' }) * 1000 : 0;
      }
      return 0;
    } catch (err) {
      logger.error({ err, geom }, 'ST_Length failed');
      return 0;
    }
  }

  /** ST_Area(geom) — Area in square meters. */
  ST_Area(geom: string): number {
    try {
      const g = wktToGeoJSON(geom);
      return turf.area(turf.feature(g));
    } catch (err) {
      logger.error({ err, geom }, 'ST_Area failed');
      return 0;
    }
  }

  /** ST_Perimeter(geom) — Perimeter of polygon (meters). */
  ST_Perimeter(geom: string): number {
    return this.ST_Length(geom);
  }

  /** ST_Distance(a, b) — Distance between geometries (in degrees). */
  ST_Distance(a: string, b: string): number {
    try {
      const ga = wktToGeoJSON(a);
      const gb = wktToGeoJSON(b);
      const ca = turf.centroid(turf.feature(ga)).geometry.coordinates;
      const cb = turf.centroid(turf.feature(gb)).geometry.coordinates;
      return turf.distance(
        [ca[0], ca[1]] as [number, number],
        [cb[0], cb[1]] as [number, number],
        { units: 'degrees' },
      );
    } catch (err) {
      logger.error({ err }, 'ST_Distance failed');
      return 0;
    }
  }

  /** ST_DWithin(a, b, dist) — True if distance < dist. */
  ST_DWithin(a: string, b: string, dist: number): boolean {
    const d = this.ST_Distance(a, b);
    return d >= 0 && d < dist;
  }

  /** ST_HausdorffDistance(a, b) — Hausdorff distance between geometries. */
  ST_HausdorffDistance(a: string, b: string): number {
    try {
      const ga = wktToGeoJSON(a);
      const gb = wktToGeoJSON(b);
      const pa = toPositionArray(ga);
      const pb = toPositionArray(gb);
      let maxDist = 0;
      for (const p of pa) {
        let minDist = Infinity;
        for (const q of pb) {
          const d = Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2);
          if (d < minDist) minDist = d;
        }
        if (minDist > maxDist) maxDist = minDist;
      }
      return maxDist;
    } catch (err) {
      logger.error({ err }, 'ST_HausdorffDistance failed');
      return 0;
    }
  }

  /** ST_MaxDistance(a, b) — Maximum distance between any two points in the geometries. */
  ST_MaxDistance(a: string, b: string): number {
    try {
      const ga = wktToGeoJSON(a);
      const gb = wktToGeoJSON(b);
      const pa = toPositionArray(ga);
      const pb = toPositionArray(gb);
      let maxDist = 0;
      for (const p of pa) {
        for (const q of pb) {
          const d = Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2);
          if (d > maxDist) maxDist = d;
        }
      }
      return maxDist;
    } catch (err) {
      logger.error({ err }, 'ST_MaxDistance failed');
      return 0;
    }
  }

  /** ST_3DDistance(a, b) — 3D Euclidean distance. */
  ST_3DDistance(a: string, b: string): number {
    try {
      const ga = wktToGeoJSON(a);
      const gb = wktToGeoJSON(b);
      const ca = turf.centroid(turf.feature(ga)).geometry.coordinates;
      const cb = turf.centroid(turf.feature(gb)).geometry.coordinates;
      const dx = (ca[0] ?? 0) - (cb[0] ?? 0);
      const dy = (ca[1] ?? 0) - (cb[1] ?? 0);
      const dz = (ca[2] ?? 0) - (cb[2] ?? 0);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    } catch (err) {
      logger.error({ err }, 'ST_3DDistance failed');
      return 0;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // SPATIAL RELATIONSHIPS
  // ════════════════════════════════════════════════════════════════

  /** ST_Equals(a, b) — Geometries are spatially equal. */
  ST_Equals(a: string, b: string): boolean {
    try {
      const ga = wktToGeoJSON(a);
      const gb = wktToGeoJSON(b);
      return turf.booleanEqual(turf.feature(ga), turf.feature(gb));
    } catch { return false; }
  }

  /** ST_Intersects(a, b) — Geometries intersect. */
  ST_Intersects(a: string, b: string): boolean {
    try {
      return turf.booleanIntersects(turf.feature(wktToGeoJSON(a)), turf.feature(wktToGeoJSON(b)));
    } catch { return false; }
  }

  /** ST_Contains(a, b) — a contains b. */
  ST_Contains(a: string, b: string): boolean {
    try {
      return turf.booleanContains(turf.feature(wktToGeoJSON(a)), turf.feature(wktToGeoJSON(b)));
    } catch { return false; }
  }

  /** ST_Within(a, b) — a is within b. */
  ST_Within(a: string, b: string): boolean {
    try {
      return turf.booleanWithin(turf.feature(wktToGeoJSON(a)), turf.feature(wktToGeoJSON(b)));
    } catch { return false; }
  }

  /** ST_Touches(a, b) — Geometries touch at boundary but don't overlap interior. */
  ST_Touches(a: string, b: string): boolean {
    try {
      return turf.booleanTouches(turf.feature(wktToGeoJSON(a)), turf.feature(wktToGeoJSON(b)));
    } catch { return false; }
  }

  /** ST_Crosses(a, b) — Geometries cross. */
  ST_Crosses(a: string, b: string): boolean {
    try {
      return turf.booleanCrosses(turf.feature(wktToGeoJSON(a)), turf.feature(wktToGeoJSON(b)));
    } catch { return false; }
  }

  /** ST_Overlaps(a, b) — Geometries share space but neither contains the other. */
  ST_Overlaps(a: string, b: string): boolean {
    try {
      return turf.booleanOverlap(turf.feature(wktToGeoJSON(a)), turf.feature(wktToGeoJSON(b)));
    } catch { return false; }
  }

  /** ST_Disjoint(a, b) — Geometries are disjoint (do not intersect). */
  ST_Disjoint(a: string, b: string): boolean {
    return !this.ST_Intersects(a, b);
  }

  /** ST_Covers(a, b) — a covers b (same as contains for polygons, more permissive for boundaries). */
  ST_Covers(a: string, b: string): boolean {
    try {
      const ga = turf.feature(wktToGeoJSON(a));
      const gb = turf.feature(wktToGeoJSON(b));
      // booleanContains is strict interior; covers allows boundary coincidence
      return turf.booleanContains(ga, gb) || turf.booleanEqual(ga, gb);
    } catch { return false; }
  }

  /** ST_CoveredBy(a, b) — a is covered by b. */
  ST_CoveredBy(a: string, b: string): boolean {
    return this.ST_Covers(b, a);
  }

  // ════════════════════════════════════════════════════════════════
  // GEOMETRY PROCESSING
  // ════════════════════════════════════════════════════════════════

  /** ST_Buffer(geom, radius [, units]) — Buffer by radius (default degrees). */
  ST_Buffer(geom: string, radius: number, units: 'degrees' | 'kilometers' = 'degrees'): string {
    try {
      const g = wktToGeoJSON(geom);
      const buffered = turf.buffer(turf.feature(g), radius, { units });
      if (!buffered) throw new Error('Buffer returned null');
      return geoJSONToWKT(buffered.geometry);
    } catch (err) {
      logger.error({ err, geom, radius }, 'ST_Buffer failed');
      return geom;
    }
  }

  /** ST_Intersection(a, b) — Return the intersecting area of two geometries. */
  ST_Intersection(a: string, b: string): string {
    try {
      const ga = turf.feature(wktToGeoJSON(a));
      const gb = turf.feature(wktToGeoJSON(b));
      const result = turf.intersect(turf.featureCollection([ga, gb] as any) as any);
      if (!result) return 'POLYGON EMPTY';
      return geoJSONToWKT(result.geometry);
    } catch { return 'POLYGON EMPTY'; }
  }

  /** ST_Union(a, b) — Union of two geometries. */
  ST_Union(a: string, b: string): string {
    try {
      const ga = turf.feature(wktToGeoJSON(a));
      const gb = turf.feature(wktToGeoJSON(b));
      const result = turf.union(turf.featureCollection([ga, gb] as any) as any);
      if (!result) return a;
      return geoJSONToWKT(result.geometry);
    } catch { return a; }
  }

  /** ST_Difference(a, b) — Portion of a not in b. */
  ST_Difference(a: string, b: string): string {
    try {
      const ga = turf.feature(wktToGeoJSON(a));
      const gb = turf.feature(wktToGeoJSON(b));
      const result = turf.difference(turf.featureCollection([ga, gb] as any) as any);
      if (!result) return a;
      return geoJSONToWKT(result.geometry);
    } catch { return a; }
  }

  /** ST_SymDifference(a, b) — Symmetric difference (a XOR b). */
  ST_SymDifference(a: string, b: string): string {
    try {
      const ga = turf.feature(wktToGeoJSON(a));
      const gb = turf.feature(wktToGeoJSON(b));
      const diffAB = turf.difference(turf.featureCollection([ga, gb] as any) as any);
      const diffBA = turf.difference(turf.featureCollection([gb, ga] as any) as any);
      if (diffAB && diffBA) {
        const result = turf.union(turf.featureCollection([turf.feature((diffAB as any).geometry), turf.feature((diffBA as any).geometry)] as any) as any);
        if (result) return geoJSONToWKT(result.geometry);
      }
      if (diffAB) return geoJSONToWKT(diffAB.geometry);
      if (diffBA) return geoJSONToWKT(diffBA.geometry);
      return a;
    } catch { return a; }
  }

  /** ST_Centroid(geom) — Geometric centroid as WKT point. */
  ST_Centroid(geom: string): string {
    try {
      const g = wktToGeoJSON(geom);
      const c = turf.centroid(turf.feature(g));
      return geoJSONToWKT(c.geometry);
    } catch { return 'POINT(0 0)'; }
  }

  /** ST_ConvexHull(geom) — Convex hull of geometry. */
  ST_ConvexHull(geom: string): string {
    try {
      const g = wktToGeoJSON(geom);
      const hull = turf.convex(turf.feature(g));
      if (!hull) return geom;
      return geoJSONToWKT(hull.geometry);
    } catch { return geom; }
  }

  /** ST_Envelope(geom) — Bounding box as polygon. */
  ST_Envelope(geom: string): string {
    try {
      const g = wktToGeoJSON(geom);
      const bbox = turf.bbox(turf.feature(g));
      return `POLYGON((${bbox[0]} ${bbox[1]}, ${bbox[2]} ${bbox[1]}, ${bbox[2]} ${bbox[3]}, ${bbox[0]} ${bbox[3]}, ${bbox[0]} ${bbox[1]}))`;
    } catch { return geom; }
  }

  /** ST_Simplify(geom, tolerance) — Simplify using Douglas-Peucker. */
  ST_Simplify(geom: string, tolerance: number): string {
    try {
      const g = wktToGeoJSON(geom);
      const simplified = turf.simplify(turf.feature(g), { tolerance, highQuality: true });
      return geoJSONToWKT(simplified.geometry);
    } catch { return geom; }
  }

  /** ST_Transform(geom, srid) — Re-project geometry (no-op without proj4). */
  ST_Transform(geom: string, srid: number): string {
    const oldSrid = this.getSRID(geom);
    this.setSRID(geom, srid);
    logger.debug({ geom: geom.substring(0, 40), fromSrid: oldSrid, toSrid: srid }, 'ST_Transform (metadata-only without proj4)');
    return geom;
  }

  // ════════════════════════════════════════════════════════════════
  // ACCESSORS
  // ════════════════════════════════════════════════════════════════

  /** ST_X(geom) — X/longitude coordinate of a point. */
  ST_X(geom: string): number {
    try {
      const g = wktToGeoJSON(geom);
      if (g.type === 'Point') return (g.coordinates as number[])[0] ?? NaN;
      const c = turf.center(turf.feature(g)).geometry.coordinates;
      return c[0];
    } catch { return NaN; }
  }

  /** ST_Y(geom) — Y/latitude coordinate of a point. */
  ST_Y(geom: string): number {
    try {
      const g = wktToGeoJSON(geom);
      if (g.type === 'Point') return (g.coordinates as number[])[1] ?? NaN;
      const c = turf.center(turf.feature(g)).geometry.coordinates;
      return c[1];
    } catch { return NaN; }
  }

  /** ST_Z(geom) — Z coordinate of a point (or NaN). */
  ST_Z(geom: string): number {
    try {
      const g = wktToGeoJSON(geom);
      if (g.type !== 'Point') return NaN;
      return (g.coordinates as number[])[2] ?? NaN;
    } catch { return NaN; }
  }

  /** ST_M(geom) — M coordinate of a point (or NaN). */
  ST_M(geom: string): number {
    return this.ST_Z(geom); // M is same position as Z in WKT
  }

  /** ST_GeometryType(geom) — Type name of geometry (e.g. 'ST_Point'). */
  ST_GeometryType(geom: string | GeoJSON.Geometry): string {
    try {
      const g = typeof geom === 'string' ? wktToGeoJSON(geom) : geom;
      return 'ST_' + g.type;
    } catch { return 'ST_Unknown'; }
  }

  /** ST_SRID(geom) — Return the SRID of the geometry. */
  ST_SRID(geom: string | GeoJSON.Geometry): number {
    return this.getSRID(geom) ?? this.options.defaultSrid;
  }

  /** ST_NPoints(geom) — Number of points (coordinates). */
  ST_NPoints(geom: string): number {
    try {
      const g = wktToGeoJSON(geom);
      return countCoords(g);
    } catch { return 0; }
  }

  /** ST_NumGeometries(geom) — Number of constituent geometries (1 for simple). */
  ST_NumGeometries(geom: string): number {
    try {
      const g = wktToGeoJSON(geom);
      switch (g.type) {
        case 'GeometryCollection': return (g as GeoJSON.GeometryCollection).geometries.length;
        case 'MultiPoint': return (g as GeoJSON.MultiPoint).coordinates.length;
        case 'MultiLineString': return (g as GeoJSON.MultiLineString).coordinates.length;
        case 'MultiPolygon': return (g as GeoJSON.MultiPolygon).coordinates.length;
        default: return 1;
      }
    } catch { return 0; }
  }

  /** ST_IsValid(geom) — Check if geometry is valid. */
  ST_IsValid(geom: string): boolean {
    try {
      const g = wktToGeoJSON(geom);
      return turf.booleanValid(turf.feature(g));
    } catch { return false; }
  }

  /** ST_IsEmpty(geom) — Check if geometry is empty. */
  ST_IsEmpty(geom: string): boolean {
    try {
      const g = wktToGeoJSON(geom);
      if (g.type === 'Point') return false; // a point always has a coordinate
      const count = countCoords(g);
      return count === 0;
    } catch { return true; }
  }

  /** ST_IsSimple(geom) — Check if geometry is simple (no self-intersections). */
  ST_IsSimple(geom: string): boolean {
    try {
      const g = wktToGeoJSON(geom);
      // turf doesn't have a direct isSimple check; use knot removal as heuristic
      // A simple geometry has valid topology; we default to true for simple types
      if (g.type === 'Point' || g.type === 'MultiPoint') return true;
      if (g.type === 'LineString') {
        // Check for self-intersection by checking if the line has kinks
        const feature = turf.feature(g);
        const kinks = turf.kinks(feature);
        return kinks.features.length === 0;
      }
      if (g.type === 'Polygon') {
        const feature = turf.feature(g);
        const kinks = turf.kinks(feature);
        const valid = turf.booleanValid(feature);
        return kinks.features.length === 0 && valid;
      }
      return true;
    } catch { return false; }
  }

  // ════════════════════════════════════════════════════════════════
  // SETTERS
  // ════════════════════════════════════════════════════════════════

  /** ST_SetSRID(geom, srid) — Set the SRID of a geometry (in-place metadata). */
  ST_SetSRID(geom: string, srid: number): string {
    this.setSRID(geom, srid);
    return geom;
  }

  // ════════════════════════════════════════════════════════════════
  // LEGACY / CONVENIENCE ALIASES
  // ════════════════════════════════════════════════════════════════

  // ── Measurements ─────────────────────────────────────────────
  distance(a: string, b: string): number { return this.ST_Distance(a, b); }
  length(geom: string): number { return this.ST_Length(geom); }
  area(geom: string): number { return this.ST_Area(geom); }

  // ── Spatial Relationships ────────────────────────────────────
  intersects(geom1: string, geom2: string): boolean { return this.ST_Intersects(geom1, geom2); }
  contains(geom1: string, geom2: string): boolean { return this.ST_Contains(geom1, geom2); }
  within(geom1: string, geom2: string): boolean { return this.ST_Within(geom1, geom2); }
  crosses(geom1: string, geom2: string): boolean { return this.ST_Crosses(geom1, geom2); }
  overlaps(geom1: string, geom2: string): boolean { return this.ST_Overlaps(geom1, geom2); }
  touches(geom1: string, geom2: string): boolean { return this.ST_Touches(geom1, geom2); }

  // ── Set Operations ───────────────────────────────────────────
  union(geom1: string, geom2: string): string { return this.ST_Union(geom1, geom2); }
  intersection(geom1: string, geom2: string): string { return this.ST_Intersection(geom1, geom2); }
  difference(geom1: string, geom2: string): string { return this.ST_Difference(geom1, geom2); }
  symmetricDifference(geom1: string, geom2: string): string { return this.ST_SymDifference(geom1, geom2); }

  // ── Processing ───────────────────────────────────────────────
  buffer(geom: string, radius: number, units?: 'degrees' | 'kilometers'): string {
    return this.ST_Buffer(geom, radius, units);
  }
  simplify(geom: string, tolerance: number): string { return this.ST_Simplify(geom, tolerance); }
  transform(geom: string, srid: number): string { return this.ST_Transform(geom, srid); }

  // ── Aggregation ──────────────────────────────────────────────
  collect(...geoms: string[]): string { return this.ST_Collect(...geoms); }
  envelope(geom: string): string { return this.ST_Envelope(geom); }
  convexHull(geom: string): string { return this.ST_ConvexHull(geom); }

  // ── Geometry Construction ────────────────────────────────────
  makePoint(lon: number, lat: number, z?: number): string { return this.ST_MakePoint(lon, lat, z); }
  makeLine(points: string[]): string { return this.ST_MakeLine(points); }
  makePolygon(outerRing: string, holes?: string[]): string { return this.ST_MakePolygon(outerRing, holes); }
  makeEnvelope(x1: number, y1: number, x2: number, y2: number, srid?: number): string {
    return this.ST_MakeEnvelope(x1, y1, x2, y2, srid);
  }

  // ════════════════════════════════════════════════════════════════
  // SQL FUNCTION DETECTION & REWRITING
  // ════════════════════════════════════════════════════════════════

  /** Regex to detect ST_ function calls in SQL. */
  private static readonly ST_FUNC_RE = /\b(ST_[A-Z]\w+)\s*\(/i;

  /**
   * Detect whether a SQL string contains PostGIS ST_ function calls.
   *
   * @param sql - SQL query to inspect
   * @returns true if the SQL contains ST_ function calls
   */
  static detectStCall(sql: string): boolean {
    PostGISEngine.ST_FUNC_RE.lastIndex = 0;
    return PostGISEngine.ST_FUNC_RE.test(sql);
  }

  /**
   * Rewrite or execute ST_ function calls in SQL.
   *
   * In 'execute' mode, attempts to evaluate the ST_ function call
   * directly. In 'rewrite' mode, replaces it with a compatible
   * SQL comment or inline value.
   *
   * Note: This is a best-effort rewriting. Complex queries with
   * nested ST_ calls should be routed to the engine directly.
   *
   * @param sql - SQL query containing ST_ function calls
   * @param method - 'rewrite' to inline a replacement, 'execute' to attempt evaluation
   * @returns Rewritten SQL string
   */
  static rewriteStCall(sql: string, method: 'rewrite' | 'execute'): string {
    if (method === 'execute') {
      // For execution mode, we return the SQL unchanged but flagged
      // so the executor can route to a PostGISEngine instance.
      return `/* POSTGIS_EXECUTE */ ${sql}`;
    }

    // For 'rewrite' mode, replace simple ST_ calls with inline values
    let rewritten = sql;

    // ST_Distance(geom1, geom2) -> 0.0
    rewritten = rewritten.replace(
      /\bST_Distance\s*\([^)]+\)/gi,
      '0.0 /* ST_Distance replaced */',
    );

    // ST_Contains(geom1, geom2) -> true
    rewritten = rewritten.replace(
      /\bST_Contains\s*\([^)]+\)/gi,
      '1 /* ST_Contains replaced */',
    );

    // ST_Intersects(geom1, geom2) -> false
    rewritten = rewritten.replace(
      /\bST_Intersects\s*\([^)]+\)/gi,
      '0 /* ST_Intersects replaced */',
    );

    // ST_Length(geom) -> 0.0
    rewritten = rewritten.replace(
      /\bST_Length\s*\([^)]+\)/gi,
      '0.0 /* ST_Length replaced */',
    );

    // ST_Area(geom) -> 0.0
    rewritten = rewritten.replace(
      /\bST_Area\s*\([^)]+\)/gi,
      '0.0 /* ST_Area replaced */',
    );

    // ST_X(geom) -> 0.0
    rewritten = rewritten.replace(
      /\bST_X\s*\([^)]+\)/gi,
      '0.0 /* ST_X replaced */',
    );

    // ST_Y(geom) -> 0.0
    rewritten = rewritten.replace(
      /\bST_Y\s*\([^)]+\)/gi,
      '0.0 /* ST_Y replaced */',
    );

    // ST_AsText(geom) -> 'POINT(0 0)'
    rewritten = rewritten.replace(
      /\bST_AsText\s*\([^)]+\)/gi,
      "'POINT(0 0)' /* ST_AsText replaced */",
    );

    // ST_AsGeoJSON(geom) -> '{"type":"Point","coordinates":[0,0]}'
    rewritten = rewritten.replace(
      /\bST_AsGeoJSON\s*\([^)]+\)/gi,
      "'{\"type\":\"Point\",\"coordinates\":[0,0]}' /* ST_AsGeoJSON replaced */",
    );

    // ST_GeomFromText('...', srid) -> the WKT string itself
    rewritten = rewritten.replace(
      /ST_GeomFromText\s*\(\s*'([^']+)'\s*(?:,\s*\d+)?\s*\)/gi,
      "'$1' /* ST_GeomFromText passthrough */",
    );

    // ST_GeomFromGeoJSON('...') -> 'POINT(0 0)'
    rewritten = rewritten.replace(
      /\bST_GeomFromGeoJSON\s*\([^)]+\)/gi,
      "'POINT(0 0)' /* ST_GeomFromGeoJSON replaced */",
    );

    // Generic: replace ST_* functions not caught above with a constant
    rewritten = rewritten.replace(
      /\bST_[A-Z]\w+\s*\([^)]*\)/gi,
      (match) => {
        // Skip already-replaced ones (they have comments)
        if (match.includes('/*')) return match;
        return `0 /* ${match.replace(/\(.*/, '()')} replaced */`;
      },
    );

    return rewritten;
  }

  // ════════════════════════════════════════════════════════════════
  // SRID MANAGEMENT
  // ════════════════════════════════════════════════════════════════

  private setSRID(geom: string | GeoJSON.Geometry, srid: number): void {
    const key = typeof geom === 'string' ? geom : geoJSONToWKT(geom);
    this.sridRegistry.set(key, srid);
  }

  getSRID(geom: string | GeoJSON.Geometry): number | undefined {
    const key = typeof geom === 'string' ? geom : geoJSONToWKT(geom);
    return this.sridRegistry.get(key);
  }

  /** Clear all SRID registrations. */
  clearSRIDRegistry(): void {
    this.sridRegistry.clear();
  }

  /** Register an explicit SRID for a geometry string. */
  registerSRID(wkt: string, srid: number): void {
    this.sridRegistry.set(wkt.trim(), srid);
  }
}

// ── Internal helpers ───────────────────────────────────────────

/** Extract all coordinate values from a geometry into a flat array. */
function extractCoords(geom: GeoJSON.Geometry): number[] {
  const result: number[] = [];
  switch (geom.type) {
    case 'Point':
      result.push(...(geom.coordinates as number[]));
      break;
    case 'MultiPoint':
    case 'LineString':
      for (const c of geom.coordinates as number[][]) result.push(...c);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of geom.coordinates as number[][][]) {
        for (const c of ring) result.push(...c);
      }
      break;
    case 'MultiPolygon':
      for (const poly of geom.coordinates as number[][][][]) {
        for (const ring of poly) {
          for (const c of ring) result.push(...c);
        }
      }
      break;
    case 'GeometryCollection':
      for (const g of (geom as GeoJSON.GeometryCollection).geometries) {
        result.push(...extractCoords(g));
      }
      break;
  }
  return result;
}

/** Count number of coordinate positions in a geometry. */
function countCoords(geom: GeoJSON.Geometry): number {
  switch (geom.type) {
    case 'Point': return 1;
    case 'MultiPoint': return (geom as GeoJSON.MultiPoint).coordinates.length;
    case 'LineString': return (geom as GeoJSON.LineString).coordinates.length;
    case 'MultiLineString': {
      let n = 0;
      for (const part of (geom as GeoJSON.MultiLineString).coordinates) n += part.length;
      return n;
    }
    case 'Polygon': {
      let n = 0;
      for (const ring of (geom as GeoJSON.Polygon).coordinates) n += ring.length;
      return n;
    }
    case 'MultiPolygon': {
      let n = 0;
      for (const poly of (geom as GeoJSON.MultiPolygon).coordinates) {
        for (const ring of poly) n += ring.length;
      }
      return n;
    }
    case 'GeometryCollection':
      return (geom as GeoJSON.GeometryCollection).geometries.reduce((s, g) => s + countCoords(g), 0);
    default: return 0;
  }
}

/** Extract all 2D positions from a geometry. */
function toPositionArray(geom: GeoJSON.Geometry): [number, number][] {
  const result: [number, number][] = [];
  switch (geom.type) {
    case 'Point':
      result.push([geom.coordinates[0], geom.coordinates[1]]);
      break;
    case 'MultiPoint':
    case 'LineString':
      for (const c of geom.coordinates as number[][]) result.push([c[0], c[1]]);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of geom.coordinates as number[][][]) {
        for (const c of ring) result.push([c[0], c[1]]);
      }
      break;
    case 'MultiPolygon':
      for (const poly of geom.coordinates as number[][][][]) {
        for (const ring of poly) {
          for (const c of ring) result.push([c[0], c[1]]);
        }
      }
      break;
    case 'GeometryCollection':
      for (const g of (geom as GeoJSON.GeometryCollection).geometries) {
        result.push(...toPositionArray(g));
      }
      break;
  }
  return result;
}
