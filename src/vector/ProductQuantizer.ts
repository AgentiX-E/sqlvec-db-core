/**
 * ProductQuantizer — Product Quantization for vector compression
 *
 * Implements PQ compression that splits each d-dimensional vector into m
 * sub-vectors, runs k-means clustering per sub-space, and stores centroid
 * indices (codes). This provides significant memory reduction (typically
 * 75%+) for large HNSW indices with modest accuracy loss.
 *
 * Uses Asymmetric Distance Computation (ADC) for approximate distance
 * computation: precompute distance table from query sub-vectors to each
 * sub-space centroid, then table-lookup distances for encoded vectors.
 *
 * Reference: "Product Quantization for Nearest Neighbor Search" (Jégou et al.)
 */

import { ProductQuantizationConfig } from '../types';

export interface PQCentroids {
  /** Sub-vectors per vector */
  m: number;
  /** Centroids per sub-space */
  k: number;
  /** Dimension of each sub-vector */
  subDim: number;
  /** Centroid arrays: Float32Array[m][k * subDim] — flat per sub-space */
  data: Float32Array[];
}

export interface PQSerialized {
  m: number;
  k: number;
  subDim: number;
  centroids: number[][];
  codes: number[][] | null;
}

export class ProductQuantizer {
  readonly m: number;
  readonly k: number;
  subDim: number;
  private centroids: Float32Array[] | null = null;
  private codes: Map<number, Uint8Array> | null = null;
  private trained: boolean = false;
  private codesEnabled: boolean = false;

  constructor(config: Partial<ProductQuantizationConfig>) {
    this.m = config.m ?? 8;
    this.k = config.k ?? 256;
    this.subDim = 0; // set when train() is called
    if (config.numCentroids !== undefined && config.numCentroids !== this.k * this.m) {
      // Accept custom total, but k*m is canonical
    }
  }

  // ──────────────────────────────────────────────
  //  Training (K-means per sub-space)
  // ──────────────────────────────────────────────

  /**
   * Train PQ centroids via k-means clustering (Lloyd's algorithm)
   * on each sub-vector space independently.
   *
   * @param vectors  Training vectors (all Float32Array of same dimension)
   */
  train(vectors: Float32Array[]): void {
    if (vectors.length === 0) {
      throw new Error('ProductQuantizer: cannot train on empty vectors');
    }

    const dim = vectors[0].length;
    if (dim % this.m !== 0) {
      throw new Error(
        `ProductQuantizer: vector dimension ${dim} must be divisible by m=${this.m}`,
      );
    }

    this.subDim = dim / this.m;
    this.centroids = new Array(this.m);

    // For each sub-space
    for (let s = 0; s < this.m; s++) {
      // Extract sub-vectors from all training vectors
      const subVectors: Float32Array[] = vectors.map(v => {
        return v.slice(s * this.subDim, (s + 1) * this.subDim);
      });

      // Run k-means
      this.centroids[s] = this.kMeans(subVectors, this.k, 20);
    }

    this.trained = true;
  }

  /**
   * Lloyd's k-means clustering
   *
   * @param points  Array of Float32Array (each point has subDim coordinates)
   * @param k       Number of centroids
   * @param maxIter Maximum iterations
   * @returns       Flat Float32Array of shape [k * subDim]
   */
  private kMeans(points: Float32Array[], k: number, maxIter: number): Float32Array {
    const n = points.length;
    const subDim = points[0].length;
    const centroids = new Float32Array(k * subDim);

    // Initialize centroids: randomly select k distinct points (k-means++)
    // If there are fewer points than k, duplicate some points
    const effectiveK = Math.min(k, n);
    const indices = new Set<number>();

    // First centroid: random from dataset
    indices.add(Math.floor(Math.random() * n));
    // Fill remaining centroids with random distinct points (or duplicates if n < k)
    while (indices.size < effectiveK) {
      indices.add(Math.floor(Math.random() * n));
    }

    let idx = 0;
    for (const i of indices) {
      for (let d = 0; d < subDim; d++) {
        centroids[idx * subDim + d] = points[i][d];
      }
      idx++;
    }

    // If k > n, initialize remaining centroids with random noise
    if (effectiveK < k) {
      for (let c = effectiveK; c < k; c++) {
        const srcIdx = c % n;
        const offset = c * subDim;
        for (let d = 0; d < subDim; d++) {
          // Add small random perturbation to avoid all centroids being identical
          centroids[offset + d] = points[srcIdx][d] + (Math.random() - 0.5) * 0.01;
        }
      }
    }

    // Assignments: which centroid each point belongs to
    const assignments = new Int32Array(n).fill(-1);

    for (let iter = 0; iter < maxIter; iter++) {
      // Assignment step: assign each point to nearest centroid
      let changed = false;
      for (let i = 0; i < n; i++) {
        const point = points[i];
        let bestDist = Infinity;
        let bestCent = 0;

        for (let c = 0; c < k; c++) {
          let dist = 0;
          const offset = c * subDim;
          for (let d = 0; d < subDim; d++) {
            const diff = point[d] - centroids[offset + d];
            dist += diff * diff;
          }
          if (dist < bestDist) {
            bestDist = dist;
            bestCent = c;
          }
        }

        if (assignments[i] !== bestCent) {
          changed = true;
          assignments[i] = bestCent;
        }
      }

      if (!changed) break;

      // Update step: recompute centroids as mean of assigned points
      const sums = new Float32Array(k * subDim);
      const counts = new Int32Array(k);

      for (let i = 0; i < n; i++) {
        const c = assignments[i];
        const point = points[i];
        const offset = c * subDim;
        counts[c]++;
        for (let d = 0; d < subDim; d++) {
          sums[offset + d] += point[d];
        }
      }

      for (let c = 0; c < k; c++) {
        const count = counts[c];
        if (count === 0) continue;
        const offset = c * subDim;
        for (let d = 0; d < subDim; d++) {
          centroids[offset + d] = sums[offset + d] / count;
        }
      }
    }

    return centroids;
  }

  // ──────────────────────────────────────────────
  //  Encoding/Decoding
  // ──────────────────────────────────────────────

  /**
   * Encode a vector into PQ codes (m bytes).
   *
   * For each sub-space, find the nearest centroid and store its index.
   *
   * @param vector  Original vector (dimension must match subDim * m)
   * @returns       Uint8Array of length m (one byte per sub-space centroid index)
   */
  encode(vector: Float32Array): Uint8Array {
    this.ensureTrained();

    const dim = this.subDim * this.m;
    if (vector.length !== dim) {
      throw new Error(
        `ProductQuantizer.encode: expected dimension ${dim}, got ${vector.length}`,
      );
    }

    const codes = new Uint8Array(this.m);

    for (let s = 0; s < this.m; s++) {
      const centroids = this.centroids![s];
      const start = s * this.subDim;
      let bestDist = Infinity;
      let bestIdx = 0;

      for (let c = 0; c < this.k; c++) {
        let dist = 0;
        const offset = c * this.subDim;
        for (let d = 0; d < this.subDim; d++) {
          const diff = vector[start + d] - centroids[offset + d];
          dist += diff * diff;
        }
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = c;
        }
      }

      codes[s] = bestIdx;
    }

    return codes;
  }

  /**
   * Decode PQ codes back to an approximate vector.
   *
   * @param codes  PQ code (m bytes from encode())
   * @returns      Approximate reconstruction of the original vector
   */
  decode(codes: Uint8Array): Float32Array {
    this.ensureTrained();

    if (codes.length !== this.m) {
      throw new Error(
        `ProductQuantizer.decode: expected ${this.m} codes, got ${codes.length}`,
      );
    }

    const result = new Float32Array(this.subDim * this.m);

    for (let s = 0; s < this.m; s++) {
      const centIdx = codes[s];
      const centroids = this.centroids![s];
      const offsetSrc = centIdx * this.subDim;
      const offsetDst = s * this.subDim;

      for (let d = 0; d < this.subDim; d++) {
        result[offsetDst + d] = centroids[offsetSrc + d];
      }
    }

    return result;
  }

  // ──────────────────────────────────────────────
  //  Distance Computation (ADC)
  // ──────────────────────────────────────────────

  /**
   * Precompute per-sub-space distance table from query to all centroids.
   *
   * Table shape: [m][k] where table[s][c] = L2 distance from query[s] to centroid[c]
   *
   * @param query  Query vector
   * @returns      Distance table as Float32Array[m * k]
   */
  computeDistanceTable(query: Float32Array): Float32Array {
    this.ensureTrained();

    const dim = this.subDim * this.m;
    if (query.length !== dim) {
      throw new Error(
        `ProductQuantizer.computeDistanceTable: expected dimension ${dim}, got ${query.length}`,
      );
    }

    const table = new Float32Array(this.m * this.k);

    for (let s = 0; s < this.m; s++) {
      const centroids = this.centroids![s];
      const start = s * this.subDim;

      for (let c = 0; c < this.k; c++) {
        let dist = 0;
        const offset = c * this.subDim;
        for (let d = 0; d < this.subDim; d++) {
          const diff = query[start + d] - centroids[offset + d];
          dist += diff * diff;
        }
        table[s * this.k + c] = dist;
      }
    }

    return table;
  }

  /**
   * Compute ADC distance using a precomputed distance table.
   *
   * @param codes      Encoded vector (m bytes)
   * @param distTable  Precomputed distance table from computeDistanceTable()
   * @returns          Approximate L2 distance
   */
  computeAdcDistance(codes: Uint8Array, distTable: Float32Array): number {
    let distance = 0;
    for (let s = 0; s < this.m; s++) {
      distance += distTable[s * this.k + codes[s]];
    }
    return distance;
  }

  /**
   * Convenience: compute distance between two encoded vectors directly via ADC.
   * This precomputes the distance table from the first argument's decoded approximation.
   * For best performance, precompute the table once with computeDistanceTable(),
   * then call computeAdcDistance() for each encoded vector.
   *
   * @param codesA  Encoded vector A
   * @param codesB  Encoded vector B
   * @returns       Approximate L2 distance
   */
  computeDistance(codesA: Uint8Array, codesB: Uint8Array): number {
    this.ensureTrained();

    let distance = 0;

    // Symmetric distance: approximate both codes and compute L2 between approximations
    for (let s = 0; s < this.m; s++) {
      const centroids = this.centroids![s];
      const idxA = codesA[s];
      const idxB = codesB[s];
      const offsetA = idxA * this.subDim;
      const offsetB = idxB * this.subDim;

      let subDist = 0;
      for (let d = 0; d < this.subDim; d++) {
        const diff = centroids[offsetA + d] - centroids[offsetB + d];
        subDist += diff * diff;
      }
      distance += subDist;
    }

    return distance;
  }

  // ──────────────────────────────────────────────
  //  Code storage management
  // ──────────────────────────────────────────────

  /**
   * Enable code storage and get the internal codes map
   */
  enableCodes(): Map<number, Uint8Array> {
    if (!this.codes) {
      this.codes = new Map();
    }
    this.codesEnabled = true;
    return this.codes;
  }

  /**
   * Get or create the internal codes map
   */
  getCodes(): Map<number, Uint8Array> | null {
    return this.codes;
  }

  /**
   * Store a code for a given ID
   */
  storeCode(id: number, code: Uint8Array): void {
    if (!this.codes) {
      this.codes = new Map();
    }
    this.codes.set(id, code);
  }

  /**
   * Retrieve a stored code
   */
  getCode(id: number): Uint8Array | undefined {
    return this.codes?.get(id);
  }

  /**
   * Remove a stored code
   */
  removeCode(id: number): void {
    this.codes?.delete(id);
  }

  /**
   * Check if code storage is enabled
   */
  isCodesEnabled(): boolean {
    return this.codesEnabled;
  }

  // ──────────────────────────────────────────────
  //  Memory statistics
  // ──────────────────────────────────────────────

  /**
   * Get memory usage statistics.
   */
  getSize(): { centroidsBytes: number; codeSizeBytes: number } {
    if (!this.centroids) {
      return { centroidsBytes: 0, codeSizeBytes: 0 };
    }

    // Each centroid: m subspaces * k centroids * subDim floats * 4 bytes
    const centroidsBytes = this.m * this.k * this.subDim * 4;

    // Each stored code: m bytes + Map overhead
    const codeCount = this.codes?.size ?? 0;
    const codeSizeBytes = codeCount * this.m; // raw code bytes (excludes Map overhead)

    return { centroidsBytes, codeSizeBytes };
  }

  // ──────────────────────────────────────────────
  //  Serialization
  // ──────────────────────────────────────────────

  /**
   * Serialize PQ state to JSON-compatible object.
   */
  toJSON(): PQSerialized {
    this.ensureTrained();

    const centroidsData: number[][] = this.centroids!.map(c => Array.from(c));

    let codesData: number[][] | null = null;
    if (this.codes && this.codes.size > 0) {
      codesData = [];
      for (const [id, code] of this.codes) {
        codesData.push([id, ...Array.from(code)]);
      }
    }

    return {
      m: this.m,
      k: this.k,
      subDim: this.subDim,
      centroids: centroidsData,
      codes: codesData,
    };
  }

  /**
   * Deserialize PQ state from previously serialized data.
   *
   * @param data  Serialized PQ data
   * @returns     Restored ProductQuantizer instance
   */
  static fromJSON(data: PQSerialized): ProductQuantizer {
    const pq = new ProductQuantizer({
      m: data.m,
      k: data.k,
    });
    pq.subDim = data.subDim;

    // Restore centroids
    pq.centroids = new Array(data.m);
    for (let s = 0; s < data.m; s++) {
      pq.centroids[s] = new Float32Array(data.centroids[s]);
    }

    // Restore codes if present
    if (data.codes) {
      pq.codes = new Map();
      for (const entry of data.codes) {
        const id = entry[0];
        const codeBytes = entry.slice(1);
        pq.codes.set(id, new Uint8Array(codeBytes));
      }
      pq.codesEnabled = true;
    }

    pq.trained = true;
    return pq;
  }

  /**
   * Check if the quantizer has been trained.
   */
  isTrained(): boolean {
    return this.trained;
  }

  private ensureTrained(): void {
    if (!this.trained || !this.centroids) {
      throw new Error('ProductQuantizer: not yet trained. Call train() first.');
    }
  }
}
