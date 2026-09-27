import { describe, it, expect } from 'vitest';
import {
  EarthdistanceShim,
  EARTH_RADIUS_KM,
  EARTH_RADIUS_METERS,
  EARTH_RADIUS_MILES,
  earth,
  lat_to_earth,
  lon_to_earth,
  ll_to_earth,
  earth_decode_point,
  earth_distance,
  haversineDistanceDeg,
  earth_box,
  isEarthModuleEnabled,
  detectEarthFunctions,
  evaluateEarthFunction,
} from '../query/EarthdistanceShim';

describe('EarthdistanceShim', () => {
  describe('constants', () => {
    it('exposes radius constants', () => {
      expect(EARTH_RADIUS_KM).toBe(6371.009);
      expect(EARTH_RADIUS_METERS).toBe(6_371_008.8);
      expect(EARTH_RADIUS_MILES).toBe(3958.748);
    });
  });

  describe('EarthdistanceShim static methods', () => {
    it('earth() returns radius in km', () => {
      expect(EarthdistanceShim.earth()).toBe(EARTH_RADIUS_KM);
    });
    it('ll_to_earth converts degrees to radians', () => {
      expect(EarthdistanceShim.ll_to_earth(90, 180)).toEqual({
        lat: Math.PI / 2, lon: Math.PI,
      });
    });
    it('ll_to_earth validates latitude', () => {
      expect(() => EarthdistanceShim.ll_to_earth(91, 0)).toThrow(RangeError);
      expect(() => EarthdistanceShim.ll_to_earth(-91, 0)).toThrow(RangeError);
      expect(() => EarthdistanceShim.ll_to_earth(NaN, 0)).toThrow();
      expect(() => EarthdistanceShim.ll_to_earth('x' as any, 0)).toThrow();
    });
    it('ll_to_earth validates longitude', () => {
      expect(() => EarthdistanceShim.ll_to_earth(0, 181)).toThrow(RangeError);
      expect(() => EarthdistanceShim.ll_to_earth(0, -181)).toThrow(RangeError);
      expect(() => EarthdistanceShim.ll_to_earth(0, NaN)).toThrow();
    });
    it('earth_to_ll converts radians back to degrees', () => {
      expect(EarthdistanceShim.earth_to_ll({ lat: 0, lon: 0 })).toEqual({ lat: 0, lon: 0 });
      expect(EarthdistanceShim.earth_to_ll({ lat: Math.PI / 2, lon: Math.PI }))
        .toEqual({ lat: 90, lon: 180 });
    });
    it('earth_distance is zero for identical points', () => {
      expect(EarthdistanceShim.earth_distance({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBe(0);
    });
    it('earth_distance_meters / miles', () => {
      expect(EarthdistanceShim.earth_distance_meters({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBe(0);
      expect(EarthdistanceShim.earth_distance_miles({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBe(0);
    });
    it('lat_to_earth / lon_to_earth', () => {
      expect(EarthdistanceShim.lat_to_earth(90)).toBeCloseTo(Math.PI / 2);
      expect(EarthdistanceShim.lon_to_earth(180)).toBeCloseTo(Math.PI);
      expect(() => EarthdistanceShim.lat_to_earth(91)).toThrow(RangeError);
      expect(() => EarthdistanceShim.lon_to_earth(181)).toThrow(RangeError);
    });
    it('point converts to degrees', () => {
      expect(EarthdistanceShim.point({ lat: 0, lon: 0 })).toEqual({ lat: 0, lon: 0 });
    });
    it('haversineDistanceDeg defaults radius to km', () => {
      expect(EarthdistanceShim.haversineDistanceDeg(0, 0, 0, 0)).toBe(0);
      expect(EarthdistanceShim.haversineDistanceDeg(0, 0, 0, 0, 100)).toBe(0);
    });
    it('isModuleEnabled returns true', () => {
      expect(EarthdistanceShim.isModuleEnabled()).toBe(true);
    });
  });

  describe('detectFunctions', () => {
    it('detects earthdistance function calls', () => {
      expect(EarthdistanceShim.detectFunctions('SELECT earth_distance(a, b)')).toBe(true);
      expect(EarthdistanceShim.detectFunctions('SELECT earth()')).toBe(true);
      expect(EarthdistanceShim.detectFunctions('SELECT ll_to_earth(1, 2)')).toBe(true);
    });
    it('returns false for unrelated SQL', () => {
      expect(EarthdistanceShim.detectFunctions('SELECT 1')).toBe(false);
      expect(EarthdistanceShim.detectFunctions('')).toBe(false);
      expect(EarthdistanceShim.detectFunctions(null as any)).toBe(false);
    });
    it('does not match inside string literals', () => {
      expect(EarthdistanceShim.detectFunctions("SELECT 'earth_distance(a,b)'")).toBe(false);
    });
    it('does not match inside comments', () => {
      expect(EarthdistanceShim.detectFunctions('-- earth(a)\nSELECT 1')).toBe(false);
    });
    it('does not match a function name as part of a larger identifier', () => {
      expect(EarthdistanceShim.detectFunctions('SELECT my_earth()')).toBe(false);
    });
  });

  describe('legacy functional exports', () => {
    it('earth() returns meters (deprecated)', () => {
      expect(earth()).toBe(EARTH_RADIUS_METERS);
    });
    it('lat_to_earth / lon_to_earth (deprecated)', () => {
      expect(lat_to_earth(90)).toBeCloseTo(Math.PI / 2);
      expect(lon_to_earth(180)).toBeCloseTo(Math.PI);
    });
    it('ll_to_earth returns colon-joined string', () => {
      expect(ll_to_earth(0, 0)).toBe('0:0');
    });
    it('earth_decode_point parses valid input', () => {
      expect(earth_decode_point('0.5:1.5')).toEqual([0.5, 1.5]);
    });
    it('earth_decode_point rejects invalid format', () => {
      expect(() => earth_decode_point('abc')).toThrow();
      expect(() => earth_decode_point('x:y')).toThrow();
    });
    it('earth_distance returns 0 for identical string points', () => {
      expect(earth_distance('0:0', '0:0')).toBe(0);
    });
    it('earth_distance rejects bad point format', () => {
      expect(() => earth_distance('x:y', '0:0')).toThrow();
    });
    it('haversineDistanceDeg (deprecated) defaults radius to meters', () => {
      expect(haversineDistanceDeg(0, 0, 0, 0)).toBe(0);
    });
    it('earth_box computes a bounding box', () => {
      const box = earth_box('0:0', 100000);
      expect(box.latMin).toBeLessThan(0);
      expect(box.latMax).toBeGreaterThan(0);
      expect(box.lonMin).toBeLessThan(0);
      expect(box.lonMax).toBeGreaterThan(0);
    });
    it('isEarthModuleEnabled returns true', () => {
      expect(isEarthModuleEnabled()).toBe(true);
    });
  });

  describe('detectEarthFunctions / evaluateEarthFunction', () => {
    it('detectEarthFunctions is literal-aware', () => {
      expect(detectEarthFunctions('SELECT earth_distance(a,b)')).toBe(true);
      expect(detectEarthFunctions("SELECT 'earth(a)'")).toBe(false);
      expect(detectEarthFunctions('-- earth(a)\nSELECT 1')).toBe(false);
    });
    it('evaluateEarthFunction dispatches earth/ll_to_earth', () => {
      expect(evaluateEarthFunction('earth', [])).toBe(EARTH_RADIUS_METERS);
      expect(evaluateEarthFunction('ll_to_earth', [0, 0])).toBe('0:0');
      expect(evaluateEarthFunction('lat_to_earth', [90])).toBeCloseTo(Math.PI / 2);
      expect(evaluateEarthFunction('lon_to_earth', [180])).toBeCloseTo(Math.PI);
    });
    it('evaluateEarthFunction supports earth_box', () => {
      const box = evaluateEarthFunction('earth_box', ['0:0', 100000]) as any;
      expect(box).toHaveProperty('latMin');
      expect(box).toHaveProperty('lonMax');
    });
    it('evaluateEarthFunction throws on unknown function', () => {
      expect(() => evaluateEarthFunction('nope', [])).toThrow();
    });
  });

  describe('evaluateFunction', () => {
    it('dispatches all supported names', () => {
      expect(EarthdistanceShim.evaluateFunction('earth', [])).toBe(EARTH_RADIUS_KM);
      expect(EarthdistanceShim.evaluateFunction('lat_to_earth', [0])).toBe(0);
      expect(EarthdistanceShim.evaluateFunction('lon_to_earth', [0])).toBe(0);
      expect(EarthdistanceShim.evaluateFunction('ll_to_earth', [0, 0])).toEqual({ lat: 0, lon: 0 });
      expect(EarthdistanceShim.evaluateFunction('earth_to_ll', [{ lat: 0, lon: 0 }]))
        .toEqual({ lat: 0, lon: 0 });
      expect(EarthdistanceShim.evaluateFunction('earth_distance', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0 }]))
        .toBe(0);
      expect(EarthdistanceShim.evaluateFunction('point', [{ lat: 0, lon: 0 }]))
        .toEqual({ lat: 0, lon: 0 });
    });
    it('dispatches earth_distance_meters / miles / earth_box', () => {
      expect(EarthdistanceShim.evaluateFunction('earth_distance_meters', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0 }]))
        .toBe(0);
      expect(EarthdistanceShim.evaluateFunction('earth_distance_miles', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0 }]))
        .toBe(0);
      const box = EarthdistanceShim.evaluateFunction('earth_box', ['0:0', 1000]) as any;
      expect(box).toHaveProperty('latMin');
    });
    it('throws on unknown function name', () => {
      expect(() => EarthdistanceShim.evaluateFunction('unknown', [])).toThrow();
    });
  });
});
