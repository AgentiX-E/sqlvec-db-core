import { describe, it, expect, vi } from 'vitest';

// Mock PGlite to throw on construction (and ready rejection), exercising the
// start() retry / backoff / exhaustion paths without real WASM.
vi.mock('@electric-sql/pglite', () => ({
  PGlite: class {
    ready = Promise.reject(new Error('ready rejected'));
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
