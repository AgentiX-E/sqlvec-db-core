/**
 * IVFPQ — Inverted File with Product Quantization (pure JS)
 *
 * Types and K‑means helper for vector index that trades some recall
 * for much faster build and lower memory vs HNSW.
 */

export interface IVFPQParams {
  /** Coarse quantizer centroid count (IVF) */
  K: number;
  /** Number of sub‑quantizers (PQ) */
  M: number;
  /** Codebook size per sub‑quantizer (256 = 8‑bit) */
  codebookSize: number;
  /** Clusters to probe during search */
  nprobe: number;
  /** Distance metric (only 'l2' implemented) */
  distance: 'l2';
}

export const DEFAULT_IVFPQ_PARAMS: IVFPQParams = {
  K: 128,
  M: 8,
  codebookSize: 256,
  nprobe: 16,
  distance: 'l2',
};

export interface InvertedListEntry {
  id: number;
  pqCode: Uint8Array; // M bytes, each byte = codebook index for that subspace
}

export interface IVFPQIndex {
  params: IVFPQParams;
  dim: number;
  /** K × dim — coarse centroid vectors */
  coarseCentroids: Float64Array[];
  /** M × codebookSize × subDim — PQ codebook */
  pqCodebook: Float64Array[][];
  /** Per‑centroid inverted lists */
  invertedLists: InvertedListEntry[][];
  /** Number of vectors indexed */
  count: number;
}

// ─────────────────────────────────────────────
// K‑means (basic, single‑pass for PQ codebooks)

function l2Dist(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

export function closestCentroid(vec: Float64Array, centroids: Float64Array[]): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const d = l2Dist(vec, centroids[i]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * K‑means (random init, max 15 iterations, 2% early stop).
 * For efficiency: if data.length > 5000, sub‑sample to 2000 for centroid updates.
 * Returns K centroids.
 */
export function kmeans(
  data: Float64Array[],
  K: number,
  dim: number,
  maxIters = 15,
): Float64Array[] {
  if (data.length === 0) throw new Error('kmeans: empty data');
  if (K > data.length) K = data.length;

  // Use a working subset for k-means (2000 is plenty for centroid training)
  const workingSet = data.length > 2000
    ? data.filter(() => Math.random() < 2000 / data.length)
    : data;
  if (workingSet.length < K) return kmeans(data.slice(0, K * 2), K, dim, maxIters);

  // Random init: pick K distinct vectors
  const centroids: Float64Array[] = [];
  const used = new Set<number>();
  for (let k = 0; k < K; k++) {
    let idx: number;
    do { idx = (Math.random() * workingSet.length) | 0; } while (used.has(idx));
    used.add(idx);
    centroids.push(new Float64Array(workingSet[idx]));
  }

  const assignments = new Int32Array(workingSet.length);
  let prevDistortion = Infinity;

  for (let iter = 0; iter < maxIters; iter++) {
    let distortion = 0;
    for (let i = 0; i < workingSet.length; i++) {
      const ci = closestCentroid(workingSet[i], centroids);
      assignments[i] = ci;
      distortion += l2Dist(workingSet[i], centroids[ci]);
    }

    if (prevDistortion !== Infinity) {
      const improvement = 1 - distortion / prevDistortion;
      if (improvement < 0.02) break;
    }
    prevDistortion = distortion;

    const sums: Float64Array[] = Array.from({ length: K }, () => new Float64Array(dim));
    const counts = new Int32Array(K);
    for (let i = 0; i < workingSet.length; i++) {
      const ci = assignments[i];
      const v = workingSet[i];
      for (let d = 0; d < dim; d++) sums[ci][d] += v[d];
      counts[ci]++;
    }
    for (let k = 0; k < K; k++) {
      if (counts[k] === 0) {
        centroids[k] = new Float64Array(workingSet[(Math.random() * workingSet.length) | 0]);
      } else {
        for (let d = 0; d < dim; d++) centroids[k][d] = sums[k][d] / counts[k];
      }
    }
  }

  return centroids;
}

// ─────────────────────────────────────────────
// Nearest centroids (for search)

/**
 * Find indices of the `nprobe` nearest centroids to `query`.
 */
export function nearestCentroids(
  query: Float64Array,
  centroids: Float64Array[],
  nprobe: number,
): number[] {
  const dists = centroids.map((c, i) => ({ i, d: l2Dist(query, c) }));
  dists.sort((a, b) => a.d - b.d);
  return dists.slice(0, nprobe).map((x) => x.i);
}
