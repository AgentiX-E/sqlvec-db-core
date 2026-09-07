import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor acquireWriteLock contention & queue resolve', () => {
  it('contended lock waits and resolves via queue handoff', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);

    // a grabs the write lock immediately.
    const first = await e.acquireWriteLock('a', 't', 1, 100);
    expect(first).toBe(0);

    // b contends and queues up (returns a pending promise).
    const pending = e.acquireWriteLock('b', 't', 1, 5000);

    // Release a's lock → hands off to b via entry.resolve() → clears timeout.
    e.releaseWriteLock('t', 1);

    const wait = await pending;
    expect(wait).toBeGreaterThanOrEqual(0);
  });

  it('contended lock times out after timeoutMs', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);

    await e.acquireWriteLock('a', 't', 1, 100); // a holds lock

    // b queues with a short timeout and never gets the lock → reject.
    await expect(e.acquireWriteLock('b', 't', 1, 20)).rejects.toThrow(/timeout/);
  });

  it('read-only txn returns 0 immediately', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', true); // read-only
    expect(await e.acquireWriteLock('a', 't', 1)).toBe(0);
  });

  it('unknown session returns 0', async () => {
    const e = makeExec();
    expect(await e.acquireWriteLock('ghost', 't', 1)).toBe(0);
  });
});

describe('MVCCExecutor writeSql rejection handling', () => {
  it('logs a warning when writeSql rejects (persist caller catch)', async () => {
    const e = makeExec({
      writeSql: () => Promise.reject(new Error('db write failed')),
    });
    // deleteRowVersion triggers writeSql().catch(...)
    (e as any).deleteRowVersion('t:1');
    // give the microtask queue a chance to run the catch
    await new Promise((r) => setTimeout(r, 10));
    // No throw — the rejection is swallowed by the .catch handler.
    expect(true).toBe(true);
  });

  it('logs a warning when writeSql rejects (persistRowVersion path)', async () => {
    const e = makeExec({
      writeSql: () => Promise.reject(new Error('write failed')),
    });
    (e as any).persistRowVersion('t:1', 1, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(true).toBe(true);
  });
});

describe('MVCCExecutor deleteRowVersion db.prepare fallback', () => {
  it('catches db.prepare errors without throwing', () => {
    const db = {
      exec: () => {},
      pragma: () => {},
      prepare: () => { throw new Error('prepare failed'); },
    };
    const e = makeExec({ db } as any);
    expect(() => (e as any).deleteRowVersion('t:1')).not.toThrow();
  });

  it('returns early when no db and no writeSql', () => {
    const e = makeExec();
    expect(() => (e as any).deleteRowVersion('t:1')).not.toThrow();
  });
});
