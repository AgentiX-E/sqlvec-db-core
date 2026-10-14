import { describe, it, expect } from 'vitest';
import { SpatialIndexManager } from '../query/SpatialIndexManager';

describe('SpatialIndexManager', () => {
  it('builds an R-tree and searches overlapping bounding boxes', () => {
    const sim = new SpatialIndexManager();
    sim.insert(1, 0, 0, 10, 10);
    sim.insert(2, 5, 5, 15, 15);
    sim.insert(3, 100, 100, 110, 110);
    sim.finish();
    expect(sim.search(3, 3, 8, 8)).toEqual([1, 2]);
  });

  it('isBuilt / size / name / entries reflect state', () => {
    const sim = new SpatialIndexManager('geo');
    expect(sim.name()).toBe('geo');
    expect(sim.isBuilt()).toBe(false);
    sim.insert(1, 0, 0, 1, 1);
    expect(sim.size()).toBe(1);
    expect(sim.entries().length).toBe(1);
    sim.finish();
    expect(sim.isBuilt()).toBe(true);
  });

  it('begin() resets a finalized index for re-building', () => {
    const sim = new SpatialIndexManager();
    sim.insert(1, 0, 0, 1, 1);
    sim.finish();
    expect(sim.isBuilt()).toBe(true);
    sim.begin();
    expect(sim.isBuilt()).toBe(false);
    expect(sim.size()).toBe(0);
    // rebuild with new items
    sim.insert(9, 0, 0, 5, 5);
    sim.finish();
    expect(sim.search(0, 0, 5, 5)).toEqual([9]);
  });

  it('begin() is a no-op when the index is not yet built', () => {
    const sim = new SpatialIndexManager();
    sim.begin(); // built === false -> no-op
    expect(sim.isBuilt()).toBe(false);
    sim.insert(1, 0, 0, 1, 1);
    sim.finish();
    expect(sim.search(0, 0, 1, 1)).toEqual([1]);
  });

  it('insert after finalize throws', () => {
    const sim = new SpatialIndexManager();
    sim.insert(1, 0, 0, 1, 1);
    sim.finish();
    expect(() => sim.insert(2, 2, 2, 3, 3)).toThrow(/finalize/i);
  });

  it('search before finalize throws', () => {
    const sim = new SpatialIndexManager();
    sim.insert(1, 0, 0, 1, 1);
    expect(() => sim.search(0, 0, 1, 1)).toThrow(/finalize/i);
  });

  it('knn before finalize throws', () => {
    const sim = new SpatialIndexManager();
    sim.insert(1, 0, 0, 1, 1);
    expect(() => sim.knn(0, 0)).toThrow(/finalize/i);
  });

  it('search on an empty finalized index returns []', () => {
    const sim = new SpatialIndexManager();
    sim.finish(); // zero items
    expect(sim.isBuilt()).toBe(true);
    expect(sim.search(0, 0, 1, 1)).toEqual([]);
  });

  it('knn on an empty finalized index returns []', () => {
    const sim = new SpatialIndexManager();
    sim.finish();
    expect(sim.knn(0, 0)).toEqual([]);
  });

  it('knn returns nearest neighbors sorted by distance', () => {
    const sim = new SpatialIndexManager();
    sim.insert(1, 0, 0, 1, 1);     // near origin
    sim.insert(2, 100, 100, 101, 101); // far
    sim.insert(3, 2, 2, 3, 3);     // near
    sim.finish();
    const r = sim.knn(0, 0, 2);
    expect(r.length).toBeLessThanOrEqual(2);
    // id 1 (at origin) should be first, id 3 second, id 2 last
    expect(r[0]).toBe(1);
    expect(r[1]).toBe(3);
  });

  it('knn uses default k=10', () => {
    const sim = new SpatialIndexManager();
    sim.insert(1, 0, 0, 1, 1);
    sim.finish();
    const r = sim.knn(0, 0);
    expect(r).toEqual([1]);
  });

  it('searchAround computes a bbox from center and half-extents', () => {
    const sim = new SpatialIndexManager();
    sim.insert(1, 0, 0, 10, 10);
    sim.finish();
    // center (5,5) half-extents (3,3) -> bbox (2,2)-(8,8)
    expect(sim.searchAround(5, 5, 3, 3)).toEqual([1]);
    // center far away -> empty
    expect(sim.searchAround(100, 100, 3, 3)).toEqual([]);
  });

  it('clear resets the index to a fresh state', () => {
    const sim = new SpatialIndexManager();
    sim.insert(1, 0, 0, 1, 1);
    sim.finish();
    sim.clear();
    expect(sim.isBuilt()).toBe(false);
    expect(sim.size()).toBe(0);
    expect(sim.entries()).toEqual([]);
  });

  it('finish is idempotent (second finish is a no-op)', () => {
    const sim = new SpatialIndexManager();
    sim.insert(1, 0, 0, 1, 1);
    sim.finish();
    sim.finish(); // already built -> return early
    expect(sim.search(0, 0, 1, 1)).toEqual([1]);
  });
});
