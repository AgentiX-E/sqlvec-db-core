import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

// Simulate the optional @mongodb-js/zstd dependency being present. Its real
// API is a pair of async buffer transforms; here we use an identity transform
// so round-trips are still byte-exact while exercising the zstd branch.
vi.mock('@mongodb-js/zstd', () => ({
  compress: async (b: Buffer) => b,
  decompress: async (b: Buffer) => b,
}));

import { ToastStorage } from '../storage/ToastStorage';

// Flush the microtask queue so the constructor's async zstd detection
// (`import('@mongodb-js/zstd').then(...)`) completes and sets zstdReady=true.
async function newZstdToast(db: Database.Database): Promise<ToastStorage> {
  const toast = new ToastStorage(db);
  await new Promise((r) => setImmediate(r));
  return toast;
}

describe('ToastStorage — zstd compression path (mocked dependency)', () => {
  it('compresses and decompresses a large string using the zstd branch', async () => {
    const db = new Database(':memory:');
    const toast = await newZstdToast(db);

    const big = 'v'.repeat(20000);
    const ptr = (await toast.store(big))!;
    expect(ptr.startsWith('__TOAST:')).toBe(true);

    // full round-trip goes through zstd.decompress
    expect(await toast.retrieve(ptr)).toBe(big);
  });

  it('compresses and decompresses a large binary Buffer using the zstd branch', async () => {
    const db = new Database(':memory:');
    const toast = await newZstdToast(db);

    const big = Buffer.alloc(20000, 42);
    const ptr = (await toast.store(big))!;
    expect(ptr.split(':')[4]).toBe('binary');

    const got = (await toast.retrieve(ptr)) as Buffer;
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got.equals(big)).toBe(true);
  });
});
