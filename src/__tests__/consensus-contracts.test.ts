import { describe, it, expect } from 'vitest';
import { RowLockManager, type LockMode } from '../consensus/RowLockManager';
import { FencingManager } from '../consensus/FencingManager';
import { RaftGroupManager } from '../consensus/RaftGroupManager';

// ─────────────────────────────────────────────────────────────
// RowLockManager — single-node null-object default.
// ─────────────────────────────────────────────────────────────
describe('RowLockManager (single-node null-object)', () => {
  it('exposes a singleton via getInstance', () => {
    const a = RowLockManager.getInstance();
    const b = RowLockManager.getInstance();
    expect(a).toBeInstanceOf(RowLockManager);
    expect(a).toBe(b);
  });

  it('grants every requested lock immediately (no contention)', async () => {
    const mgr = new RowLockManager();
    const result = await mgr.acquireLocks({
      sessionId: 's1',
      shardId: 0,
      tableName: 'users',
      rowIds: [1n, 2n, 3n],
      mode: 'FOR_UPDATE',
      nowait: false,
      skipLocked: false,
      timeoutMs: 10000,
    });
    expect(result.granted).toBe(true);
    expect(result.rowIds).toEqual([1n, 2n, 3n]);
    expect(result.skipped).toEqual([]);
  });

  it('reports granted=false for an empty row-id request', async () => {
    const result = await new RowLockManager().acquireLocks({
      sessionId: 's1',
      shardId: 0,
      tableName: 'users',
      rowIds: [],
      mode: 'FOR_SHARE',
      nowait: true,
      skipLocked: true,
      timeoutMs: 0,
    });
    expect(result.granted).toBe(false);
    expect(result.rowIds).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('returns a defensive copy of rowIds (no aliasing)', async () => {
    const ids = [7n];
    const result = await new RowLockManager().acquireLocks({
      sessionId: 's1',
      shardId: 0,
      tableName: 't',
      rowIds: ids,
      mode: 'FOR_UPDATE',
      nowait: false,
      skipLocked: false,
      timeoutMs: 0,
    });
    result.rowIds.push(999n);
    expect(ids).toEqual([7n]);
  });
});

// LockMode type is a compile-time contract; assert representative values here
// to guard against accidental narrowing of the union.
describe('LockMode (type contract)', () => {
  it('accepts every PostgreSQL lock strength variant', () => {
    const modes: LockMode[] = [
      'FOR_UPDATE',
      'FOR_NO_KEY_UPDATE',
      'FOR_SHARE',
      'FOR_KEY_SHARE',
    ];
    expect(modes).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────
// FencingManager — single-node null-object default.
// ─────────────────────────────────────────────────────────────
describe('FencingManager (single-node null-object)', () => {
  it('exposes a singleton via getInstance', () => {
    const a = FencingManager.getInstance();
    const b = FencingManager.getInstance();
    expect(a).toBeInstanceOf(FencingManager);
    expect(a).toBe(b);
  });

  it('always allows writes for any shard (no Raft group to fence from)', () => {
    const fm = new FencingManager();
    expect(fm.checkWriteAllowed(0)).toEqual({ allowed: true });
    expect(fm.checkWriteAllowed(7)).toEqual({ allowed: true });
    expect(fm.checkWriteAllowed('shard-3')).toEqual({ allowed: true });
  });

  it('returns no reason when the write is allowed', () => {
    expect(new FencingManager().checkWriteAllowed(0).reason).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// RaftGroupManager — injectable contract carrier (no behavior in core).
// ─────────────────────────────────────────────────────────────
describe('RaftGroupManager (contract carrier)', () => {
  // Every distributed method must fail loudly in single-node core, signaling
  // that it is an injectable cluster responsibility and has not been wired up.
  it('throws on read for single-node core', () => {
    expect(() => new RaftGroupManager().read(0, 'SELECT 1')).toThrow(/not implemented/);
  });

  it('throws on propose for single-node core', async () => {
    await expect(new RaftGroupManager().propose(0, { msgId: 'm1' } as never)).rejects.toThrow(
      /not implemented/,
    );
  });

  it('throws on proposeAndWait for single-node core', async () => {
    await expect(
      new RaftGroupManager().proposeAndWait(0, { msgId: 'm1' } as never),
    ).rejects.toThrow(/not implemented/);
  });

  it('throws on getPeerCount for single-node core', () => {
    expect(() => new RaftGroupManager().getPeerCount()).toThrow(/not implemented/);
  });

  it('throws on isLeader for single-node core', () => {
    expect(() => new RaftGroupManager().isLeader(0)).toThrow(/not implemented/);
  });

  it('throws on getLocalShardIds for single-node core', () => {
    expect(() => new RaftGroupManager().getLocalShardIds()).toThrow(/not implemented/);
  });

  it('throws on flushApplyQueue for single-node core', async () => {
    await expect(new RaftGroupManager().flushApplyQueue()).rejects.toThrow(/not implemented/);
  });
});
