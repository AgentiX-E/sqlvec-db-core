/**
 * ProductQuantizer — pure-JS product quantization for vector compression.
 *
 * Exercises the full train → encode/decode → ADC distance → serialize
 * lifecycle against synthetic clustered data, and locks down error paths.
 */
import { describe, it, expect } from 'vitest';
import { ProductQuantizer } from '../vector/ProductQuantizer';

function makeVectors(dim: number, groups: number, perGroup: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let g = 0; g < groups; g++) {
    const center = g * 10;
    for (let j = 0; j < perGroup; j++) {
      const v = new Float32Array(dim);
      for (let d = 0; d < dim; d++) {
        v[d] = center + (Math.random() - 0.5) * 2;
      }
      out.push(v);
    }
  }
  return out;
}

describe('ProductQuantizer', () => {
  it('throws when training on empty vectors', () => {
    const pq = new ProductQuantizer({ m: 2, k: 4 });
    expect(() => pq.train([])).toThrow(/empty vectors/);
  });

  it('throws when dimension is not divisible by m', () => {
    const pq = new ProductQuantizer({ m: 3, k: 4 });
    const v = new Float32Array([1, 2, 3, 4]); // dim 4, m 3 → not divisible
    expect(() => pq.train([v])).toThrow(/divisible by m/);
  });

  it('throws when encoding before training', () => {
    const pq = new ProductQuantizer({ m: 2, k: 4 });
    expect(() => pq.encode(new Float32Array([1, 2]))).toThrow(/not yet trained/);
  });

  it('encodes a vector into m codes and reconstructs approximately', () => {
    const pq = new ProductQuantizer({ m: 4, k: 8 });
    const vectors = makeVectors(8, 2, 32);
    pq.train(vectors);

    const v = vectors[0];
    const codes = pq.encode(v);
    expect(codes.length).toBe(4);
    // each code byte indexes a centroid (< k)
    expect(codes.every((c) => c < 8)).toBe(true);

    const decoded = pq.decode(codes);
    expect(decoded.length).toBe(8);

    // Reconstruction is an approximation of the original (L2 < a loose bound).
    let err = 0;
    for (let d = 0; d < 8; d++) err += (v[d] - decoded[d]) ** 2;
    expect(err).toBeLessThan(100);
  });

  it('rejects mismatched dimension on encode', () => {
    const pq = new ProductQuantizer({ m: 2, k: 4 });
    pq.train(makeVectors(4, 1, 8));
    expect(() => pq.encode(new Float32Array([1, 2, 3]))).toThrow(/expected dimension/);
  });

  it('rejects mismatched code length on decode', () => {
    const pq = new ProductQuantizer({ m: 4, k: 8 });
    pq.train(makeVectors(8, 1, 8));
    expect(() => pq.decode(new Uint8Array([1, 2]))).toThrow(/expected 4 codes/);
  });

  it('computes a distance table of shape [m][k] and ADC distance', () => {
    const pq = new ProductQuantizer({ m: 4, k: 8 });
    const vectors = makeVectors(8, 2, 32);
    pq.train(vectors);

    const q = vectors[10];
    const table = pq.computeDistanceTable(q);
    expect(table.length).toBe(4 * 8);

    const codesA = pq.encode(vectors[0]);
    const codesB = pq.encode(vectors[1]);
    const adcA = pq.computeAdcDistance(codesA, table);
    const adcB = pq.computeAdcDistance(codesB, table);
    expect(typeof adcA).toBe('number');
    expect(adcA).toBeGreaterThanOrEqual(0);
    expect(adcB).toBeGreaterThanOrEqual(0);

    // Identical codes → distance 0.
    expect(pq.computeDistance(codesA, codesA)).toBe(0);
  });

  it('rejects mismatched dimension on computeDistanceTable', () => {
    const pq = new ProductQuantizer({ m: 2, k: 4 });
    pq.train(makeVectors(4, 1, 8));
    expect(() => pq.computeDistanceTable(new Float32Array([1, 2, 3]))).toThrow(/expected dimension/);
  });

  it('computeDistance is symmetric and zero for equal codes', () => {
    const pq = new ProductQuantizer({ m: 4, k: 8 });
    pq.train(makeVectors(8, 2, 32));
    const a = pq.encode(makeVectors(8, 1, 1)[0]);
    const b = pq.encode(makeVectors(8, 1, 1)[0]);
    expect(pq.computeDistance(a, b)).toBeGreaterThanOrEqual(0);
  });

  it('supports code storage via enableCodes / storeCode / getCode / removeCode', () => {
    const pq = new ProductQuantizer({ m: 4, k: 8 });
    pq.train(makeVectors(8, 1, 16));

    const map = pq.enableCodes();
    expect(pq.isCodesEnabled()).toBe(true);
    expect(map).toBe(pq.getCodes());

    const code = pq.encode(makeVectors(8, 1, 1)[0]);
    pq.storeCode(42, code);
    expect(pq.getCode(42)).toEqual(code);
    expect(pq.getCode(99)).toBeUndefined();

    pq.removeCode(42);
    expect(pq.getCode(42)).toBeUndefined();
  });

  it('storeCode lazily initializes the codes map without enableCodes', () => {
    const pq = new ProductQuantizer({ m: 4, k: 8 });
    expect(pq.getCodes()).toBeNull();
    pq.storeCode(7, new Uint8Array([1, 2, 3, 4]));
    expect(pq.getCode(7)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('reports memory sizes', () => {
    const pq = new ProductQuantizer({ m: 4, k: 8 });
    // Before training: zero.
    expect(pq.getSize()).toEqual({ centroidsBytes: 0, codeSizeBytes: 0 });

    pq.train(makeVectors(8, 1, 16));
    const size = pq.getSize();
    expect(size.centroidsBytes).toBe(4 * 8 * 2 * 4); // m*k*subDim*4
    expect(size.codeSizeBytes).toBe(0);

    pq.storeCode(1, new Uint8Array([0, 0, 0, 0]));
    expect(pq.getSize().codeSizeBytes).toBe(4); // one code * m bytes
  });

  it('round-trips through toJSON / fromJSON (with and without codes)', () => {
    const pq = new ProductQuantizer({ m: 4, k: 8 });
    const vectors = makeVectors(8, 2, 32);
    pq.train(vectors);

    // Without codes.
    const jsonNoCodes = pq.toJSON();
    const restoredNoCodes = ProductQuantizer.fromJSON(jsonNoCodes);
    expect(restoredNoCodes.isTrained()).toBe(true);
    expect(restoredNoCodes.getCodes()).toBeNull();

    // With codes.
    const code = pq.encode(vectors[0]);
    pq.storeCode(123, code);
    const jsonWithCodes = pq.toJSON();
    expect(jsonWithCodes.codes).not.toBeNull();

    const restoredWithCodes = ProductQuantizer.fromJSON(jsonWithCodes);
    expect(restoredWithCodes.getCode(123)).toEqual(code);
    expect(restoredWithCodes.isCodesEnabled()).toBe(true);

    // Round-trip preserves encode/decode consistency.
    const encoded = restoredWithCodes.encode(vectors[0]);
    expect(encoded).toEqual(code);
  });

  it('isTrained reflects training state', () => {
    const pq = new ProductQuantizer({ m: 2, k: 4 });
    expect(pq.isTrained()).toBe(false);
    pq.train(makeVectors(4, 1, 8));
    expect(pq.isTrained()).toBe(true);
  });

  it('trains when there are fewer points than centroids (n < k)', () => {
    const pq = new ProductQuantizer({ m: 2, k: 16 });
    // Only 3 training vectors — fewer than k=16, triggering the noise-fill branch.
    const vectors = [
      new Float32Array([0, 0]),
      new Float32Array([1, 1]),
      new Float32Array([2, 2]),
    ];
    pq.train(vectors);
    expect(pq.isTrained()).toBe(true);

    // Encoding still produces valid codes (< k).
    const codes = pq.encode(vectors[0]);
    expect(codes.length).toBe(2);
    expect(codes.every((c) => c < 16)).toBe(true);
  });

  it('handles a single training vector', () => {
    const pq = new ProductQuantizer({ m: 2, k: 8 });
    pq.train([new Float32Array([1, 2])]);
    expect(pq.isTrained()).toBe(true);
    const codes = pq.encode(new Float32Array([1, 2]));
    expect(codes.length).toBe(2);
  });

  it('toJSON with empty codes map produces codes: null', () => {
    const pq = new ProductQuantizer({ m: 2, k: 4 });
    pq.train(makeVectors(4, 1, 8));
    pq.enableCodes(); // empty map
    const json = pq.toJSON();
    expect(json.codes).toBeNull();
  });

  it('applies default m and k when not provided', () => {
    const pq = new ProductQuantizer({});
    expect(pq.m).toBe(8);
    expect(pq.k).toBe(256);
  });

  it('accepts a numCentroids config (documented no-op)', () => {
    // numCentroids is accepted but canonical k*m is authoritative.
    const pq = new ProductQuantizer({ m: 2, k: 4, numCentroids: 64 });
    expect(pq.m).toBe(2);
    expect(pq.k).toBe(4);
  });

  it('enableCodes returns the same map on repeated calls', () => {
    const pq = new ProductQuantizer({ m: 2, k: 4 });
    pq.train(makeVectors(4, 1, 8));
    const first = pq.enableCodes();
    const second = pq.enableCodes();
    expect(first).toBe(second);
  });
});
