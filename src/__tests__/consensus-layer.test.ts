import { describe, it, expect, beforeEach } from 'vitest';
import {
  RaflessConsensus,
  RaftConsensus,
  IConsensusLayer,
} from '../query/ConsensusLayer';

// ConsensusLayer is a pure abstraction with two implementations (null-object
// single-node and Raft delegation). No SQL-string rewriting, no literal
// handling. Tests lock both contracts exactly.
describe('ConsensusLayer', () => {
  describe('RaflessConsensus (null-object / single-node)', () => {
    let c: IConsensusLayer;
    beforeEach(() => { c = new RaflessConsensus(); });

    it('reports itself as unavailable', () => {
      expect(c.isAvailable).toBe(false);
    });

    it('returns empty defaults for reads and shard membership', async () => {
      expect(c.getPeerCount()).toBe(0);
      expect(c.getLocalShardIds()).toEqual([]);
      await expect(c.read(1, 'SELECT 1')).resolves.toEqual([]);
    });

    it('is always the leader for any shard', async () => {
      await expect(c.isLeader('shard-1')).resolves.toBe(true);
    });

    it('treats propose/proposeAndWait/flushApplyQueue as no-ops', async () => {
      await expect(c.propose(1, { msgId: 'm', type: 't', data: {} })).resolves.toBeUndefined();
      await expect(c.proposeAndWait(1, { msgId: 'm', type: 't', data: {} })).resolves.toBeUndefined();
      await expect(c.flushApplyQueue()).resolves.toBeUndefined();
    });
  });

  describe('RaftConsensus (delegation)', () => {
    const mock = {
      read: (_s: number, _q: string, _p?: any[]) => Promise.resolve([{ id: 1 }]),
      propose: (_s: number, _e: unknown) => Promise.resolve(),
      proposeAndWait: (_s: number, _e: unknown) => Promise.resolve(),
      getPeerCount: () => 3,
      isLeader: (_s: string) => Promise.resolve(false),
      getLocalShardIds: () => [1, 2],
      flushApplyQueue: () => Promise.resolve(),
    };

    let c: RaftConsensus;
    beforeEach(() => { c = new RaftConsensus(mock); });

    it('reports itself as available', () => {
      expect(c.isAvailable).toBe(true);
    });

    it('delegates read with shard/sql/params', async () => {
      await expect(c.read(1, 'SELECT 1', [2])).resolves.toEqual([{ id: 1 }]);
    });

    it('delegates propose and proposeAndWait', async () => {
      const entry = { msgId: 'm', type: 't', data: { k: 1 } };
      await expect(c.propose(1, entry)).resolves.toBeUndefined();
      await expect(c.proposeAndWait(1, entry)).resolves.toBeUndefined();
    });

    it('delegates peer count, leadership, shard ids and flush', async () => {
      expect(c.getPeerCount()).toBe(3);
      await expect(c.isLeader('s')).resolves.toBe(false);
      expect(c.getLocalShardIds()).toEqual([1, 2]);
      await expect(c.flushApplyQueue()).resolves.toBeUndefined();
    });
  });
});
