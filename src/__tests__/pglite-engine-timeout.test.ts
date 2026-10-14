import { describe, it, expect, vi } from 'vitest';

// Mock PGlite so construction succeeds but `ready` never settles, forcing the
// start() timeout promise to fire and exercising the AbortController path.
vi.mock('@electric-sql/pglite', () => ({
  PGlite: class {
    ready = new Promise(() => {}); // never resolves
    exec() {
      return Promise.resolve([]);
    }
    close() {
      return Promise.resolve();
    }
  },
}));

import { PGliteEngine } from '../query/PGliteEngine';

describe('PGliteEngine — start timeout', () => {
  it('times out when ready never settles, then retries and throws', async () => {
    const eng = new PGliteEngine(20); // 20ms timeout per attempt
    await expect(eng.start()).rejects.toThrow(/failed to start after 3 retries/);
    expect(eng.ready).toBe(false);
  });
});
