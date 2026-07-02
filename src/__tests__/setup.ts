/**
 * Test setup — mock only optional native modules that may not be installed.
 * DuckDB is a hard dependency and runs natively (no mock).
 */
import { vi } from 'vitest';

// hnswlib-node is optional — mock if not installed
try { require.resolve('hnswlib-node'); } catch {
  vi.mock('hnswlib-node', () => ({
    HierarchicalNSW: vi.fn(() => ({
      initIndex: vi.fn(), addPoint: vi.fn(), searchKnn: vi.fn(() => ({ distances: [], neighbors: [] })),
      resizeIndex: vi.fn(), getMaxElements: vi.fn(() => 0), getCurrentCount: vi.fn(() => 0),
      saveIndex: vi.fn(), readIndex: vi.fn(), setEf: vi.fn(),
    })),
    SpaceName: { L2: 'l2', COSINE: 'cosine', IP: 'ip' },
  }));
}
