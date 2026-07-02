/**
 * Comprehensive test setup — mock ALL non-core modules.
 *
 * The 225 query shim files reference auth, security, consensus, replication,
 * cluster, ha, pitr, backup, ops — none of which exist in core.  Rather than
 * creating hundreds of individual stub files, we intercept the module loader
 * and return no-op stubs for any module that isn't part of core.
 */

import { vi } from 'vitest';

// ── Native modules (crash-prone) ──
vi.mock('duckdb', () => ({
  default: {
    Database: vi.fn(() => ({
      connect() { return { all(_s: string, cb?: Function) { cb?.(null, []); }, exec(_s: string, cb?: Function) { cb?.(null); }, close(){} }; },
      close() {},
    })),
  },
}));

vi.mock('hnswlib-node', () => ({
  HierarchicalNSW: vi.fn(() => ({
    initIndex: vi.fn(), addPoint: vi.fn(), searchKnn: vi.fn(() => ({ distances: [], neighbors: [] })), resizeIndex: vi.fn(), getMaxElements: vi.fn(() => 0), getCurrentCount: vi.fn(() => 0), saveIndex: vi.fn(), readIndex: vi.fn(), setEf: vi.fn(),
  })),
  SpaceName: { L2: 'l2', COSINE: 'cosine', IP: 'ip' },
}));

vi.mock('zeromq', () => ({}));
vi.mock('lmdb', () => ({}));
vi.mock('raft-logic', () => ({}));
vi.mock('@msgpack/msgpack', () => ({ encode: vi.fn(), decode: vi.fn() }));
vi.mock('piscina', () => ({ default: vi.fn() }));

// ── Non-core internal modules ──
// These modules exist in sqlvec-db-node or sqlvec-db-cluster but are
// imported by query shims.  Vi.mock auto-hoists and returns empty stubs.

for (const mod of [
  'auth/pgHbaConf', 'auth/CertMappingStore', 'auth/RoleManager', 'auth/RoleHierarchyManager',
  'security/SQLInjectionGuard', 'security/ColumnGrantChecker', 'security/BottleneckRateLimiter', 'security/RowLevelSecurity',
  'consensus/RaftGroupManager', 'consensus/FencingManager', 'consensus/HLCClockCompensator', 'consensus/RowLockManager',
  'replication/DedupRing', 'replication/HLC', 'replication/SyncReplicationManager', 'replication/OutboxManager',
  'monitoring/ActiveQueryRegistry', 'monitoring/ConnectionManager', 'monitoring/RaftMetrics', 'monitoring/RouteMetrics',
  'monitoring/PgStatUserIndexes', 'monitoring/PgVisibilityShim',
  'pg_stats/PgStatStatements', 'pg-pool/ConnectionPoolManager', 'pg-pool/ConnectionPool',
  'pitr/PITRManager', 'pitr/PITRApi', 'pitr/PITRConfigManager',
  'backup/WALArchiver', 'recovery/WalRecordReader', 'recovery/MvccCrashRecovery',
  'core/GucSystem', 'core/MetricsManager',
  'error/DatabaseError',
]) {
  vi.mock(`../${mod}`, () => {
    const name = mod.split('/').pop()!;
    const Stub = class {};
    Object.defineProperty(Stub, 'name', { value: name });
    return { [name]: Stub };
  });
}
