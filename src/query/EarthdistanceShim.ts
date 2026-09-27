/**
 * EarthdistanceShim — PostgreSQL earthdistance extension shim for sqlvec-db.
 *
 * Provides Haversine-formula great-circle distance calculations.
 *
 * Public API:
 *   - EarthdistanceShim.earth()                          → Earth radius in km
 *   - EarthdistanceShim.ll_to_earth(lat, lon)            → internal point {lat, lon}
 *   - EarthdistanceShim.earth_to_ll(point)               → {lat, lon} from internal point
 *   - EarthdistanceShim.earth_distance(a, b)             → great-circle distance (km)
 *   - EarthdistanceShim.lat_to_earth(lat)                → validate+convert lat to rad
 *   - EarthdistanceShim.lon_to_earth(lon)                → validate+convert lon to rad
 *   - EarthdistanceShim.point(earthCoord)                → {lat, lon} object
 *
 * Backward-compatible functional exports are provided for code that uses
 * the older string-based point format.
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('EarthdistanceShim');

// ── Internal helpers (literal-aware function-name detection) ──────

/**
 * The set of earthdistance function names recognized by this shim, kept in
 * sync with the evaluation switch so detection and evaluation never diverge.
 */
const EARTH_FUNCTION_NAMES = [
  'earth',
  'earth_distance',
  'earth_distance_meters',
  'earth_distance_miles',
  'll_to_earth',
  'earth_to_ll',
  'lat_to_earth',
  'lon_to_earth',
  'earth_box',
  'point',
] as const;

/**
 * Detect whether `sql` contains a call to any earthdistance function, using
 * a literal-aware scan so that function names appearing inside string
 * literals, quoted identifiers, or comments are never treated as calls.
 *
 * A function is recognized only when its name appears as a whole word
 * (not part of a larger identifier) and is followed — after optional
 * whitespace — by an opening parenthesis.
 */
function findEarthFunction(sql: string, names: readonly string[]): boolean {
  if (typeof sql !== 'string' || sql.length === 0) {
    return false;
  }

  const lower = sql.toLowerCase();

  for (let i = 0; i < lower.length; i++) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }

    const c = lower[i];
    if (!/[a-z_]/.test(c)) continue;
    // Whole-word boundary: previous char must not be an identifier char.
    if (i > 0 && /[a-z0-9_$]/.test(lower[i - 1])) continue;

    for (const name of names) {
      if (!lower.startsWith(name, i)) continue;
      const afterName = i + name.length;
      // Next non-whitespace char must be `(`.
      let j = afterName;
      while (j < lower.length && /\s/.test(lower[j])) j++;
      if (lower[j] === '(') return true;
    }
  }

  return false;
}

// ── Types ──────────────────────────────────────────────────────────

export interface EarthPoint {
  lat: number;   // radians
  lon: number;   // radians
}

export interface GeoPoint {
  lat: number;   // degrees
  lon: number;   // degrees
}

// ── Constants ──────────────────────────────────────────────────────

/** Earth's mean radius in kilometres */
export const EARTH_RADIUS_KM = 6371.009;

/** Earth's mean radius in metres */
export const EARTH_RADIUS_METERS = 6_371_008.8;

/** Earth's mean radius in miles */
export const EARTH_RADIUS_MILES = 3958.748;

// ── Internal helpers ───────────────────────────────────────────────

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

/**
 * Haversine formula: returns great-circle distance in the given radius units.
 */
function haversineDistance(
  lat1Rad: number,
  lon1Rad: number,
  lat2Rad: number,
  lon2Rad: number,
  radius: number,
): number {
  const dLat = lat2Rad - lat1Rad;
  const dLon = lon2Rad - lon1Rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radius * c;
}

function validateLat(latDeg: number): void {
  if (typeof latDeg !== 'number' || !isFinite(latDeg)) {
    throw new Error('Invalid latitude: must be a finite number, got ' + latDeg);
  }
  if (latDeg < -90 || latDeg > 90) {
    throw new RangeError(
      'Latitude out of range: ' + latDeg + '. Must be between -90 and 90 degrees.',
    );
  }
}

function validateLon(lonDeg: number): void {
  if (typeof lonDeg !== 'number' || !isFinite(lonDeg)) {
    throw new Error('Invalid longitude: must be a finite number, got ' + lonDeg);
  }
  if (lonDeg < -180 || lonDeg > 180) {
    throw new RangeError(
      'Longitude out of range: ' + lonDeg + '. Must be between -180 and 180 degrees.',
    );
  }
}

// ── EarthdistanceShim Class ───────────────────────────────────────

export class EarthdistanceShim {
  /** Logger instance */
  private static log = PinoLogger.forComponent('EarthdistanceShim');

  /**
   * Returns Earth's mean radius in kilometres.
   * Mirrors PostgreSQL's `earth()` function.
   */
  static earth(): number {
    this.log.debug('earth() called');
    return EARTH_RADIUS_KM;
  }

  /**
   * Convert latitude/longitude (degrees) to an internal earth point (radians).
   * Validates lat/lon ranges.
   *
   * Mirrors PostgreSQL's `ll_to_earth(lat, lon)`.
   */
  static ll_to_earth(latDeg: number, lonDeg: number): EarthPoint {
    validateLat(latDeg);
    validateLon(lonDeg);
    return {
      lat: toRadians(latDeg),
      lon: toRadians(lonDeg),
    };
  }

  /**
   * Convert an internal earth point back to degrees.
   */
  static earth_to_ll(point: EarthPoint): GeoPoint {
    return {
      lat: toDegrees(point.lat),
      lon: toDegrees(point.lon),
    };
  }

  /**
   * Calculate great-circle distance between two earth points.
   * Result is in kilometres.
   *
   * Mirrors PostgreSQL's `earth_distance(ll_to_earth(...), ll_to_earth(...))`.
   */
  static earth_distance(a: EarthPoint, b: EarthPoint): number {
    return haversineDistance(a.lat, a.lon, b.lat, b.lon, EARTH_RADIUS_KM);
  }

  /**
   * Calculate great-circle distance in metres (higher precision).
   */
  static earth_distance_meters(a: EarthPoint, b: EarthPoint): number {
    return haversineDistance(a.lat, a.lon, b.lat, b.lon, EARTH_RADIUS_METERS);
  }

  /**
   * Calculate great-circle distance in miles.
   */
  static earth_distance_miles(a: EarthPoint, b: EarthPoint): number {
    return haversineDistance(a.lat, a.lon, b.lat, b.lon, EARTH_RADIUS_MILES);
  }

  /**
   * Validate and convert latitude (degrees) to radians.
   * Throws if latitude is out of [-90, 90].
   *
   * Mirrors PostgreSQL's `lat_to_earth(lat)`.
   */
  static lat_to_earth(latDeg: number): number {
    validateLat(latDeg);
    return toRadians(latDeg);
  }

  /**
   * Validate and convert longitude (degrees) to radians.
   * Throws if longitude is out of [-180, 180].
   *
   * Mirrors PostgreSQL's `lon_to_earth(lon)`.
   */
  static lon_to_earth(lonDeg: number): number {
    validateLon(lonDeg);
    return toRadians(lonDeg);
  }

  /**
   * Convert earth coordinate to a PostGIS-style {lat, lon} point.
   *
   * Mirrors PostgreSQL's `point(earth)`.
   */
  static point(earthCoord: EarthPoint): GeoPoint {
    return {
      lat: toDegrees(earthCoord.lat),
      lon: toDegrees(earthCoord.lon),
    };
  }

  /**
   * Haversine distance between two geographic points given in decimal degrees.
   * Convenience function for external use.
   */
  static haversineDistanceDeg(
    lat1Deg: number,
    lon1Deg: number,
    lat2Deg: number,
    lon2Deg: number,
    radius: number = EARTH_RADIUS_KM,
  ): number {
    return haversineDistance(
      toRadians(lat1Deg), toRadians(lon1Deg),
      toRadians(lat2Deg), toRadians(lon2Deg),
      radius,
    );
  }

  /**
   * Check if the earthdistance module is enabled.
   * Always returns true (simulated).
   */
  static isModuleEnabled(): boolean {
    return true;
  }

  /**
   * Detect if a SQL statement contains earthdistance function calls.
   * Literal-aware: function names inside strings/comments are ignored.
   */
  static detectFunctions(sql: string): boolean {
    return findEarthFunction(sql, EARTH_FUNCTION_NAMES);
  }

  /**
   * Evaluate a named earthdistance function with the given arguments.
   */
  static evaluateFunction(fnName: string, args: unknown[]): unknown {
    const name = fnName.toLowerCase();
    switch (name) {
      case 'earth':
        return EarthdistanceShim.earth();
      case 'lat_to_earth':
        return EarthdistanceShim.lat_to_earth(Number(args[0]));
      case 'lon_to_earth':
        return EarthdistanceShim.lon_to_earth(Number(args[0]));
      case 'll_to_earth':
        return EarthdistanceShim.ll_to_earth(Number(args[0]), Number(args[1]));
      case 'earth_to_ll':
        return EarthdistanceShim.earth_to_ll(args[0] as EarthPoint);
      case 'earth_distance':
        return EarthdistanceShim.earth_distance(args[0] as EarthPoint, args[1] as EarthPoint);
      case 'earth_distance_meters':
        return EarthdistanceShim.earth_distance_meters(args[0] as EarthPoint, args[1] as EarthPoint);
      case 'earth_distance_miles':
        return EarthdistanceShim.earth_distance_miles(args[0] as EarthPoint, args[1] as EarthPoint);
      case 'earth_box':
        return earth_box(args[0] as string, Number(args[1]));
      case 'point':
        return EarthdistanceShim.point(args[0] as EarthPoint);
      default:
        throw new Error('Unknown earthdistance function: ' + fnName);
    }
  }
}

// ── Backward-compatible functional exports ──────────────────────────

const POINT_SEPARATOR = ':';

/** @deprecated Use EarthdistanceShim.earth() instead */
export function earth(): number {
  return EARTH_RADIUS_METERS;
}

/** @deprecated Use EarthdistanceShim.lat_to_earth() instead */
export function lat_to_earth(lat: number): number {
  return toRadians(lat);
}

/** @deprecated Use EarthdistanceShim.lon_to_earth() instead */
export function lon_to_earth(lon: number): number {
  return toRadians(lon);
}

/** @deprecated Use EarthdistanceShim.ll_to_earth() instead */
export function ll_to_earth(lat: number, lon: number): string {
  const latRad = toRadians(lat);
  const lonRad = toRadians(lon);
  return '' + latRad + POINT_SEPARATOR + lonRad;
}

/** @deprecated Use EarthdistanceShim.earth_to_ll() instead */
export function earth_decode_point(point: string): [number, number] {
  const parts = point.split(POINT_SEPARATOR);
  if (parts.length !== 2) {
    throw new Error('Invalid earth point format: "' + point + '". Expected "lat:lon".');
  }
  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  if (!isFinite(lat) || !isFinite(lon)) {
    throw new Error(
      'Invalid earth point format: "' + point + '". Expected numeric "lat:lon".',
    );
  }
  return [lat, lon];
}

/** @deprecated Use EarthdistanceShim.earth_distance() instead */
export function earth_distance(pointA: string, pointB: string): number {
  const [lat1Rad, lon1Rad] = earth_decode_point(pointA);
  const [lat2Rad, lon2Rad] = earth_decode_point(pointB);
  return haversineDistance(lat1Rad, lon1Rad, lat2Rad, lon2Rad, EARTH_RADIUS_METERS);
}

/** @deprecated Use EarthdistanceShim.haversineDistanceDeg() instead */
export function haversineDistanceDeg(
  lat1Deg: number,
  lon1Deg: number,
  lat2Deg: number,
  lon2Deg: number,
  radius: number = EARTH_RADIUS_METERS,
): number {
  return haversineDistance(
    toRadians(lat1Deg), toRadians(lon1Deg),
    toRadians(lat2Deg), toRadians(lon2Deg),
    radius,
  );
}

/** @deprecated Use EarthdistanceShim with custom implementation instead */
export function earth_box(
  point: string,
  radiusMeters: number,
): { latMin: number; lonMin: number; latMax: number; lonMax: number } {
  const [latRad, lonRad] = earth_decode_point(point);
  const angularRadius = radiusMeters / EARTH_RADIUS_METERS;

  const latMinRad = latRad - angularRadius;
  const latMaxRad = latRad + angularRadius;

  const lonDeltaRad = Math.asin(Math.min(1, Math.sin(angularRadius) / Math.cos(Math.abs(latRad))));
  const lonMinRad = lonRad - lonDeltaRad;
  const lonMaxRad = lonRad + lonDeltaRad;

  return {
    latMin: toDegrees(latMinRad),
    latMax: toDegrees(latMaxRad),
    lonMin: toDegrees(lonMinRad),
    lonMax: toDegrees(lonMaxRad),
  };
}

/** @deprecated Use EarthdistanceShim.isModuleEnabled() instead */
export function isEarthModuleEnabled(): boolean {
  return true;
}

/** @deprecated Use EarthdistanceShim.detectFunctions() instead */
export function detectEarthFunctions(sql: string): boolean {
  return findEarthFunction(sql, EARTH_FUNCTION_NAMES);
}

/** @deprecated Use EarthdistanceShim.evaluateFunction() instead */
export function evaluateEarthFunction(fnName: string, args: unknown[]): unknown {
  const name = fnName.toLowerCase();
  switch (name) {
    case 'earth':
      return EARTH_RADIUS_METERS;
    case 'lat_to_earth':
      return toRadians(Number(args[0]));
    case 'lon_to_earth':
      return toRadians(Number(args[0]));
    case 'll_to_earth':
      return '' + toRadians(Number(args[0])) + POINT_SEPARATOR + toRadians(Number(args[1]));
    case 'earth_box':
      return earth_box(args[0] as string, Number(args[1]));
    default:
      return EarthdistanceShim.evaluateFunction(fnName, args);
  }
}
