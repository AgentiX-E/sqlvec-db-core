/**
 * HybridSearch — Vector + Full-Text hybrid search with RRF fusion
 *
 * Uses minisearch for BM25 full-text, sqlite-vec for vector similarity.
 * Results are fused via Reciprocal Rank Fusion (RRF).
 */

import MiniSearch from 'minisearch';
import { ShardReplica } from '../storage/ShardReplica';

export interface HybridSearchConfig {
  k: number;          // RRF constant (default: 60)
  vectorTopK: number; // Vector search oversample (default: 50)
  ftsTopK: number;    // Full-text search oversample (default: 50)
}

export interface HybridResult {
  id: number;
  score: number;
  rankVec: number;
  rankFTS: number;
}

export class HybridSearch {
  private config: HybridSearchConfig;
  private miniSearch: MiniSearch;

  constructor(config?: Partial<HybridSearchConfig>) {
    this.config = {
      k: config?.k ?? 60,
      vectorTopK: config?.vectorTopK ?? 50,
      ftsTopK: config?.ftsTopK ?? 50,
    };

    this.miniSearch = new MiniSearch({
      fields: ['title', 'content', 'category'],
      storeFields: ['id', 'title'],
      searchOptions: {
        boost: { title: 3, content: 1, category: 1.5 },
        prefix: true,
        fuzzy: 0.2,
      },
    });
  }

  /**
   * Add documents to the full-text index.
   * Called during INSERT via ShardReplica apply.
   */
  addDocument(doc: { id: number; title?: string; content?: string; category?: string }): void {
    this.miniSearch.add(doc);
  }

  /**
   * Remove a document from the full-text index.
   */
  removeDocument(id: number): void {
    this.miniSearch.remove({ id } as any);
  }

  /**
   * Perform hybrid search: vector search + full-text search + RRF fusion.
   *
   * @param queryText - Natural language query text for full-text search
   * @param vectorSearchFn - Function that performs vector search and returns id+score pairs
   * @param topK - Final number of results
   */
  async search(
    queryText: string,
    vectorSearchFn: () => Promise<Array<{ id: number; score: number }>>,
    topK: number = 10,
  ): Promise<{ results: HybridResult[]; stats: { vectorCandidates: number; ftsCandidates: number; totalCandidates: number; rrfResultCount: number } }> {
    // Phase 1: Full-text search via minisearch
    const ftsResults = this.miniSearch.search(queryText, {
      prefix: true,
      fuzzy: 0.2,
    });
    const ftsTop = ftsResults.slice(0, this.config.ftsTopK);
    const ftsMap = new Map<number, number>();
    ftsTop.forEach((r: any, i: number) => ftsMap.set(r.id as number, i + 1));

    // Phase 2: Vector search
    const vecResults = await vectorSearchFn();
    const vecTop = vecResults.slice(0, this.config.vectorTopK);
    const vecMap = new Map<number, number>();
    vecTop.forEach((r, i) => vecMap.set(r.id, i + 1));

    // Phase 3: RRF fusion
    const combinedIds = new Set([...vecMap.keys(), ...ftsMap.keys()]);
    const scored: HybridResult[] = [];

    for (const id of combinedIds) {
      const rankVec = vecMap.get(id) || this.config.vectorTopK + 1;
      const rankFTS = ftsMap.get(id) || this.config.ftsTopK + 1;
      const score = (1 / (this.config.k + rankVec)) + (1 / (this.config.k + rankFTS));
      scored.push({ id, score, rankVec: rankVec > this.config.vectorTopK ? -1 : rankVec, rankFTS: rankFTS > this.config.ftsTopK ? -1 : rankFTS });
    }

    // Sort by RRF score descending
    scored.sort((a, b) => b.score - a.score);

    return {
      results: scored.slice(0, topK),
      stats: {
        vectorCandidates: vecTop.length,
        ftsCandidates: ftsTop.length,
        totalCandidates: combinedIds.size,
        rrfResultCount: Math.min(topK, scored.length),
      },
    };
  }

  getMiniSearch(): MiniSearch {
    return this.miniSearch;
  }

  getStats(): { indexedDocs: number } {
    // MiniSearch exposes `documentCount` as a runtime getter. The project's
    // legacy `moduleResolution: "node"` resolves the minisearch 7.x exports
    // map loosely and drops that getter (along with toJSON) from the visible
    // type, so read it through a narrow cast rather than the internal
    // property count (which was the previous, incorrect behavior).
    const mini = this.miniSearch as unknown as { documentCount: number };
    return { indexedDocs: mini.documentCount };
  }
}
