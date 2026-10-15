import { describe, it, expect, vi } from 'vitest';

// Mock PGlite to throw on construction, exercising the start() retry /
// backoff / exhaustion paths without real WASM. The `ready` field is omitted:
// construction throws before it could ever be read, and a `ready =
// Promise.reject(...)` class field would emit an unhandled rejection that fails
// the run under --pool=forks.
vi.mock('@electric-sql/pglite', () => ({
  PGlite: class {
    constructor() {
      throw new Error('cannot init pglite');
    }
    exec() {
      return Promise.resolve([]);
    }
    close() {
      return Promise.resolve();
    }
  },
}));

import { PGliteEngine } from '../query/PGliteEngine';

describe('PGliteEngine — start retry & exhaustion', () => {
  it('exhausts retries and throws after 3 attempts', async () => {
    const eng = new PGliteEngine(30);
    await expect(eng.start()).rejects.toThrow(/failed to start after 3 retries/);
    expect(eng.ready).toBe(false);
  });

  it('ready stays false when start fails', async () => {
    const eng = new PGliteEngine(30);
    try {
      await eng.start();
    } catch {
      /* expected */
    }
    expect(eng.ready).toBe(false);
  });
});
