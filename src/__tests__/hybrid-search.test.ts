/**
 * HybridSearch — vector + full-text hybrid search with Reciprocal Rank Fusion.
 *
 * Exercises the full lifecycle against a real MiniSearch index (no mocks):
 * construction defaults/overrides, add/remove documents, RRF fusion ranking
 * (docs appearing in both vs one ranking), stats, and oversample slicing.
 */
import { describe, it, expect } from 'vitest';
import { HybridSearch } from '../vector/HybridSearch';

describe('HybridSearch', () => {
  describe('construction', () => {
    it('applies RRF defaults', () => {
      const hs = new HybridSearch();
      expect((hs as any).config).toEqual({ k: 60, vectorTopK: 50, ftsTopK: 50 });
    });

    it('accepts partial config overrides merged with defaults', () => {
      const hs = new HybridSearch({ k: 30, ftsTopK: 5 });
      expect((hs as any).config.k).toBe(30);
      expect((hs as any).config.ftsTopK).toBe(5);
      expect((hs as any).config.vectorTopK).toBe(50);
    });
  });

  describe('document management', () => {
    it('addDocument indexes and increases indexedDocs', () => {
      const hs = new HybridSearch();
      expect(hs.getStats().indexedDocs).toBe(0);
      hs.addDocument({ id: 1, title: 'vector database', content: 'hnsw' });
      hs.addDocument({ id: 2, title: 'full text', content: 'search engine' });
      expect(hs.getStats().indexedDocs).toBe(2);
    });

    it('addDocument tolerates missing fields', () => {
      const hs = new HybridSearch();
      hs.addDocument({ id: 1 }); // no title/content/category
      expect(hs.getStats().indexedDocs).toBe(1);
    });

    it('removeDocument decreases indexedDocs and drops search hits', async () => {
      const hs = new HybridSearch();
      hs.addDocument({ id: 1, title: 'apple banana', content: 'fruit' });
      hs.addDocument({ id: 2, title: 'carrot', content: 'vegetable' });
      expect(hs.getStats().indexedDocs).toBe(2);

      hs.removeDocument(1);
      expect(hs.getStats().indexedDocs).toBe(1);

      const res = await hs.search('apple', async () => [{ id: 2, score: 0.5 }], 5);
      // Document 1 was removed; FTS should no longer surface it.
      expect(res.results.map((r) => r.id)).not.toContain(1);
    });

    it('getMiniSearch exposes the underlying index', () => {
      const hs = new HybridSearch();
      hs.addDocument({ id: 1, title: 'hello' });
      const m = hs.getMiniSearch();
      expect(m.documentCount).toBe(1);
    });
  });

  describe('RRF fusion', () => {
    it('ranks a document appearing in both rankings highest', async () => {
      const hs = new HybridSearch();
      hs.addDocument({ id: 1, title: 'vector search', content: 'hnsw index' });
      hs.addDocument({ id: 2, title: 'vector database', content: 'sqlite' });
      hs.addDocument({ id: 3, title: 'unrelated', content: 'nothing here' });

      // id 1 is #1 in both vector and FTS → highest RRF score.
      const res = await hs.search(
        'vector search',
        async () => [
          { id: 1, score: 0.9 },
          { id: 2, score: 0.7 },
          { id: 3, score: 0.1 },
        ],
        3,
      );
      expect(res.results[0].id).toBe(1);
      // rankVec == 1 (appears in vector top), rankFTS == 1 (appears in FTS top).
      expect(res.results[0].rankVec).toBe(1);
      expect(res.results[0].rankFTS).toBe(1);
    });

    it('assigns a fallback rank (-1) for docs missing from one ranking', async () => {
      const hs = new HybridSearch();
      hs.addDocument({ id: 1, title: 'alpha', content: 'only in fts' });
      // Vector fn returns only id 99 (not in FTS) plus id 1 not present.
      const res = await hs.search(
        'alpha',
        async () => [{ id: 99, score: 1.0 }],
        5,
      );
      const id1 = res.results.find((r) => r.id === 1);
      // id 1 is in FTS but not in vector → rankVec should be -1 (fallback).
      expect(id1).toBeDefined();
      expect(id1!.rankVec).toBe(-1);
      expect(id1!.rankFTS).toBe(1);
    });

    it('computes RRF score via 1/(k+rank) for both rankings', async () => {
      const hs = new HybridSearch({ k: 60, vectorTopK: 50, ftsTopK: 50 });
      hs.addDocument({ id: 1, title: 'exact match term', content: 'x' });
      hs.addDocument({ id: 2, title: 'other', content: 'y' });

      const res = await hs.search(
        'exact match term',
        async () => [
          { id: 1, score: 1.0 }, // rank 1
          { id: 2, score: 0.5 }, // rank 2
        ],
        2,
      );
      const id1 = res.results.find((r) => r.id === 1)!;
      // FTS rank 1, vector rank 1 → score = 1/61 + 1/61
      const expected = 1 / (60 + 1) + 1 / (60 + 1);
      expect(id1.score).toBeCloseTo(expected, 10);
    });

    it('caps results at topK and reports fusion stats', async () => {
      const hs = new HybridSearch({ vectorTopK: 50, ftsTopK: 50 });
      for (let i = 0; i < 20; i++) {
        hs.addDocument({ id: i, title: `doc ${i}`, content: 'common term' });
      }
      const vectorResults = Array.from({ length: 10 }, (_, i) => ({ id: i, score: 1 - i * 0.01 }));
      const res = await hs.search('common term', async () => vectorResults, 5);
      expect(res.results.length).toBe(5);
      expect(res.stats.vectorCandidates).toBe(10);
      expect(res.stats.totalCandidates).toBeGreaterThanOrEqual(10);
      expect(res.stats.rrfResultCount).toBe(5);
    });

    it('handles empty vector results (only FTS contributes)', async () => {
      const hs = new HybridSearch();
      hs.addDocument({ id: 1, title: 'standalone', content: 'text' });
      hs.addDocument({ id: 2, title: 'another', content: 'doc' });
      const res = await hs.search('standalone', async () => [], 3);
      expect(res.results.length).toBeGreaterThan(0);
      // Document 1 matches FTS and gets rankFTS 1; vector empty → rankVec fallback.
      const id1 = res.results.find((r) => r.id === 1)!;
      expect(id1.rankVec).toBe(-1);
      expect(id1.rankFTS).toBe(1);
      expect(res.stats.vectorCandidates).toBe(0);
    });
  });
});
