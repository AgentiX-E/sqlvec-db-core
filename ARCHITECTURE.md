# SqlVec DB Core — Architecture & Ownership Boundaries

> **sqlvec-db-core** is an *embeddable HTAP database engine*: SQLite (OLTP row
> store) + DuckDB (OLAP columnar store) with real-time CDC, HNSW vector search,
> TDE encryption, and a PostgreSQL-compatibility layer.

This document fixes the **ownership boundaries** of the core package: which
capabilities belong in `sqlvec-db-core` (single-node engine), and which belong
in the sibling cluster/federation packages. It is the authoritative reference
for deciding whether a module stays, moves, or is reclassified.

---

## 1. Core Identity

| Property | Value |
|----------|-------|
| Package | `@agentix-e/sqlvec-db-core` |
| Role | Embeddable, **single-node** HTAP engine |
| OLTP | SQLite (row-oriented) via `better-sqlite3` |
| OLAP | DuckDB (columnar) with `sqlite_scanner` |
| Sync | Real-time CDC (`DataBridge`, ~100ms OLTP→OLAP) |
| Vector | HNSW via `sqlite-vec` |
| Deployment | Embeddable — zero external services required |

The core engine is **self-contained** and must remain embeddable: it must not
*depend* on a running cluster, a network service, or a shared coordinator to
serve local reads and writes.

### Sibling packages (out of scope for core)

| Package | Responsibility |
|---------|----------------|
| `sqlvec-db-node` | Standalone PG-compatible server wrapping core |
| `sqlvec-db-cluster` | Raft distributed cluster (multi-node consensus) |
| `sqlvec-db-federation` | Cross-DC enterprise deployment (federated analytics) |

---

## 2. What belongs in core (single-node engine)

The following are **inherent** to the core engine and are owned here.

### 2.1 Storage & Sharding
- `storage/ShardManager.ts` — SQLite sharded storage + `vec0` vector indexes.
- `storage/ShardReplica.ts` — per-shard apply/replay with HLC-based last-writer-wins
  conflict resolution. **No network dependency**; it is the local state machine.

> Sharding here is *intra-process* (multiple local SQLite files), inspired by
> HashQL's `ShardManager`. It is **not** multi-node replication.

### 2.2 Dual-Engine Analytics (OLAP)
- `analytics/DuckDBAnalyticsManager.ts` — persistent DuckDB column store.
- `analytics/AnalyticQueryClassifier.ts` — OLTP/OLAP routing heuristics.
- `analytics/DataBridge.ts` — CDC sync from shards → columnar tables.
- `analytics/ABComparisonValidator.ts` — DuckDB ↔ SQLite result equivalence checks.

### 2.3 Single-node WAL & Durability
- `storage/PgWalWriter.ts`, `storage/WALStateManager.ts`,
  `storage/PgWalSegmentManager.ts`, `storage/WalDataFormats.ts`,
  `storage/WALConfig.ts` — PostgreSQL-compatible WAL segment semantics
  (LSN tracking, segments, crash recovery) for the *local* engine.
- `commitlog/CommitLog.ts` — local commit log.

### 2.4 PostgreSQL Compatibility Layer
- `query/` — 156+ PG syntax shims (system views, functions, `FOR UPDATE`,
  `LOCK TABLE`, 2PC, etc.).
- `system/` — `pg_catalog` / `information_schema` system catalogs & functions.
- `plpgsql/` — PL/pgSQL runtime.

### 2.5 Distributed-*in-name-only* modules (still core)
These names contain "distributed" but operate **within a single process** over
local shards (via `ShardManager`), with **no network/Raft**:

- `query/DistributedTwoPhaseCommitCoordinator.ts` — **cross-shard** 2PC over
  local shards. Imports only `PinoLogger` + `ShardManager`.
- `storage/ReplicationSlotTracker.ts` — in-memory simulation of
  `pg_replication_slots` for PG compatibility. **No real standby transport.**

---

## 3. Cross-node capability is *optional* and injectable

Multi-node / cross-network capability does **not** live in core's main write
path. It is provided as **interfaces + injectable strategies**, with a
**null-object or local default** for single-node operation. This mirrors the
consensus design already present in `interfaces/consensus.ts`.

| Capability | Interface / default (core) | Injectable implementation |
|------------|----------------------------|---------------------------|
| Consensus | `IConsensusLayer` + `RaflessConsensus` (single-node, `isAvailable=false`) | `RaftConsensus` wrapping a `RaftGroupManager` (cluster) |
| Row locks | `RowLockManager` null-object (grants all) | cluster implementation with deadlock detection |
| Write fencing | `FencingManager` null-object (`allowed:true`) | cluster lease/heartbeat fencing (STONITH) |
| Raft groups | `RaftGroupManager` stub (throws) | `db-cluster/src/consensus/core/RaftGroupManager.ts` |
| WAL streaming | local `PgWalWriter` (single-node) | `WALSender` / `WALReceiver` (ZeroMQ, optional) |
| Analytics routing | `FederationStrategy` + `LocalColumnarStrategy` (Layer 0) | `HttpfsStrategy` (Layer 2), `NodeTransportStrategy` (TCP, Layer 3) |

### 3.1 Consequence: ZeroMQ/TCP transport modules stay in core
- `query/WALSender.ts` / `query/WALReceiver.ts` (ZeroMQ PUSH/PULL)
- `analytics/strategies/NodeTransportStrategy.ts` (TCP `net.Socket`)

These are **optional, injectable transport strategies**, not part of the
single-node main path. They are retained in core because (a) they are only
constructed when a cluster/federation layer opts in, and (b) relocating them
would break the existing `FederationStrategy` / WAL strategy import graph
without a behavioral benefit. They remain governed by the same boundary rule:
**core never *depends* on them; callers inject them.**

---

## 4. Empty-shell / contract modules

Several modules were historically empty shells consumed by `@ts-nocheck` files
as if implemented. They are now either:

- **Implemented as single-node null-objects** (belong in core): `DedupRing`,
  `HLC.ts`, `HLCClockCompensator`, `SyncReplicationManager`, `RowLockManager`,
  `FencingManager`.
- **Contract carriers with fail-loud stubs** (cluster owns the impl):
  `RaftGroupManager`.

---

## 5. Boundary decision rules

When classifying a module, apply these tests in order:

1. **Does it depend on the network / a remote node / Raft / ZeroMQ / TCP?**
   - Yes → it is an *injectable strategy* (retain as optional) or a
     *cluster-owned* concern (contract stub in core).
   - No → it belongs in core (see §2).
2. **Does it only orchestrate *local* shards via `ShardManager`?**
   - Yes → core (cross-shard ≠ cross-node).
3. **Does it simulate a PostgreSQL catalog/view for compatibility?**
   - Yes → core (even if named "replication" / "distributed").

### Hard invariant
> The core engine must remain **embeddable and self-contained**: constructing a
> `SqlVecDatabase` and serving local reads/writes must never require a network
> peer, a running cluster, or an external coordination service.

---

## 6. Coverage threshold

Every *owned* module (i.e. everything in §2, §3, and §4) is subject to a
uniform coverage threshold of **≥95% in every dimension** (statements,
branches, functions). No exemptions. Contract stubs (§4) are covered by
asserting their fail-loud behavior.

---

*Maintained by Lambertyan. Last revised 2026-09-17.*
