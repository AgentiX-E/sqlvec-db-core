/**
 * IVFPQIndex — Inverted File with Product Quantization (pure JS)
 *
 * Train / build / search lifecycle.
 *
 * Usage:
 *   const idx = new IVFPQIndex({ dim: 128 });
 *   idx.train(vectors);            // K‑means + PQ codebook training
 *   idx.add(vectors, ids);         // index vectors into inverted lists
 *   const results = idx.search(query, 10); // topK results
 */

import {
  IVFPQParams,
  DEFAULT_IVFPQ_PARAMS,
  InvertedListEntry,
  kmeans,
  closestCentroid,
  nearestCentroids,
} from './ivfpq-types';

export interface IVFPQSearchResult {
  id: number;
  distance: number;
}

export class IVFPQIndex {
  params: IVFPQParams;
  dim: number;

  /** K × dim — coarse centroid vectors */
  coarseCentroids: Float64Array[] = [];
  /** M × codebookSize × subDim — PQ codebook */
  pqCodebook: Float64Array[][] = [];
  /** Per‑centroid inverted lists */
  invertedLists: InvertedListEntry[][] = [];
  /** Number of vectors indexed */
  count = 0;

  private subDim = 0;
  private trained = false;
  private built = false;

  constructor(params?: Partial<IVFPQParams> & { dim: number }) {
    this.params = { ...DEFAULT_IVFPQ_PARAMS, ...params };
    this.dim = params!.dim;
    this.subDim = this.dim / this.params.M;
    if (this.subDim !== Math.floor(this.subDim)) {
      throw new Error(`dim (${this.dim}) must be divisible by M (${this.params.M})`);
    }
  }

  /**
   * Train coarse quantizer (K‑means) + PQ codebooks.
   * `vectors`: array of Float64Array, each length = this.dim.
   */
  train(vectors: Float64Array[]): void {
    if (vectors.length < this.params.K) {
      throw new Error(
        `Need at least K=${this.params.K} vectors for training, got ${vectors.length}`,
      );
    }

    // 1. Coarse quantizer: K‑means on all vectors
    this.coarseCentroids = kmeans(vectors, this.params.K, this.dim);

    // 2. Assign each vector to its nearest centroid
    const assignments = vectors.map((v) => closestCentroid(v, this.coarseCentroids));

    // 3. Compute residuals (v - centroid) and train PQ codebooks per subspace
    const residuals = vectors.map((v, i) => {
      const c = this.coarseCentroids[assignments[i]];
      const res = new Float64Array(this.dim);
      for (let d = 0; d < this.dim; d++) res[d] = v[d] - c[d];
      return res;
    });

    // 4. For each subspace m, collect sub‑vectors from all residuals, run K‑means
    const codebookSize = this.params.codebookSize;
    this.pqCodebook = [];
    for (let m = 0; m < this.params.M; m++) {
      const start = m * this.subDim;
      const end = start + this.subDim;
      const subVectors = residuals.map((r) => r.subarray(start, end));
      const subCentroids = kmeans(subVectors, codebookSize, this.subDim, 30);
      this.pqCodebook.push(subCentroids);
    }

    this.trained = true;
  }

  /**
   * Add vectors to the index (builds inverted lists).
   * `vectors`: same format as train(). `ids`: optional external ids (default 0..N-1).
   */
  add(vectors: Float64Array[], ids?: number[]): void {
    if (!this.trained) throw new Error('Must train() before add()');
    const K = this.params.K;
    const M = this.params.M;

    // Pre‑compute L2 distance tables for PQ encoding
    // For each subspace m, we already have the codebook centroids.
    // Encoding a vector: for each subspace, find nearest codebook entry.

    // Lazily initialize inverted lists once; subsequent add() calls append
    // (incremental indexing) rather than replacing the whole structure.
    if (this.invertedLists.length === 0) {
      this.invertedLists = Array.from({ length: K }, () => []);
    }

    for (let i = 0; i < vectors.length; i++) {
      const vec = vectors[i];
      const id = ids?.[i] ?? this.count;

      // Find nearest coarse centroid
      const ci = closestCentroid(vec, this.coarseCentroids);

      // Compute residual
      const res = new Float64Array(this.dim);
      const c = this.coarseCentroids[ci];
      for (let d = 0; d < this.dim; d++) res[d] = vec[d] - c[d];

      // PQ encode residual: per subspace, find nearest codebook entry.
      // Iterate over the ACTUAL codebook length — training may produce fewer
      // codebook entries than params.codebookSize when there are fewer
      // training vectors than the requested codebook size.
      const pqCode = new Uint8Array(M);
      for (let m = 0; m < M; m++) {
        const start = m * this.subDim;
        const end = start + this.subDim;
        const subVec = res.subarray(start, end);
        const codebook = this.pqCodebook[m];

        let bestJ = 0;
        let bestDist = Infinity;
        for (let j = 0; j < codebook.length; j++) {
          let dist = 0;
          const cb = codebook[j];
          for (let s = 0; s < this.subDim; s++) {
            const d = subVec[s] - cb[s];
            dist += d * d;
          }
          if (dist < bestDist) {
            bestDist = dist;
            bestJ = j;
          }
        }
        pqCode[m] = bestJ;
      }

      // Append to the inverted list (incremental indexing).
      this.invertedLists[ci].push({ id, pqCode });
      this.count++;
    }

    this.built = true;
  }

  /**
   * Search for `topK` nearest neighbors.
   * Returns array sorted by ascending distance.
   */
  search(query: Float64Array, topK: number): IVFPQSearchResult[] {
    if (!this.built) throw new Error('Must add() before search()');
    const { M, nprobe } = this.params;

    // 1. Find nearest nprobe centroids
    const probeIds = nearestCentroids(query, this.coarseCentroids, nprobe);

    // 2. For each probe centroid, pre‑compute distance table (ADC)
    //    distanceTable[m][codebookIdx] = L2 distance from query sub‑vector to codebook entry
    const candidates: { id: number; dist: number }[] = [];

    for (const pi of probeIds) {
      // Compute distance table for this centroid (query residual = query - centroid)
      const centroid = this.coarseCentroids[pi];
      const queryResidual = new Float64Array(this.dim);
      for (let d = 0; d < this.dim; d++) queryResidual[d] = query[d] - centroid[d];

      // Build distance table: M × codebookSize
      const distTable: Float64Array[] = [];
      for (let m = 0; m < M; m++) {
        const start = m * this.subDim;
        const end = start + this.subDim;
        const qSub = queryResidual.subarray(start, end);
        const codebook = this.pqCodebook[m];
        const table = new Float64Array(codebook.length);
        for (let j = 0; j < codebook.length; j++) {
          const cb = codebook[j];
          let s = 0;
          for (let sIdx = 0; sIdx < this.subDim; sIdx++) {
            const d = qSub[sIdx] - cb[sIdx];
            s += d * d;
          }
          table[j] = s;
        }
        distTable.push(table);
      }

      // Scan inverted list: accumulate distance from distance table
      const list = this.invertedLists[pi];
      for (const entry of list) {
        let dist = 0;
        for (let m = 0; m < M; m++) {
          dist += distTable[m][entry.pqCode[m]];
        }
        candidates.push({ id: entry.id, dist });
      }
    }

    // 3. Sort and return topK
    candidates.sort((a, b) => a.dist - b.dist);
    return candidates.slice(0, topK).map((c) => ({ id: c.id, distance: Math.sqrt(c.dist) }));
  }

  // ─────────────────────────────────────────────
  // Serialization

  toJSON(): any {
    return {
      params: this.params,
      dim: this.dim,
      coarseCentroids: this.coarseCentroids.map((a) => Array.from(a)),
      pqCodebook: this.pqCodebook.map((m) => m.map((a) => Array.from(a))),
      invertedLists: this.invertedLists.map((list) =>
        list.map((e) => ({ id: e.id, pqCode: Array.from(e.pqCode) })),
      ),
      count: this.count,
      subDim: this.subDim,
      trained: this.trained,
      built: this.built,
    };
  }

  static fromJSON(data: any): IVFPQIndex {
    const idx = new IVFPQIndex({ ...data.params, dim: data.dim });
    idx.coarseCentroids = data.coarseCentroids.map((a: number[]) => new Float64Array(a));
    idx.pqCodebook = data.pqCodebook.map((m: number[][]) =>
      m.map((a: number[]) => new Float64Array(a)),
    );
    idx.invertedLists = data.invertedLists.map((list: any[]) =>
      list.map((e: any) => ({ id: e.id, pqCode: new Uint8Array(e.pqCode) })),
    );
    idx.count = data.count;
    idx.subDim = data.subDim;
    idx.trained = data.trained;
    idx.built = data.built;
    return idx;
  }
}
