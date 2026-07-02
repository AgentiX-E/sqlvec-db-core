# SqlVec DB — Core

> Embeddable HTAP database engine — SQLite OLTP + DuckDB OLAP with real-time CDC

```typescript
import { SqlVecDatabase } from '@agentix-e/sqlvec-db-core';

const db = new SqlVecDatabase({ dataDir: './mydb' });
await db.start();

// Standard SQL
await db.query("CREATE TABLE docs (id SERIAL, title TEXT, embedding FLOAT[768])");
await db.query("INSERT INTO docs VALUES (1, 'hello', ARRAY[0.1, 0.2, ...])");

// Vector search — HNSW, 100% recall
const result = await db.query(
  "SELECT id, title FROM docs ORDER BY embedding <-> ? LIMIT 10",
  [queryVector]
);

// Real-time OLTP→OLAP CDC (100ms DataBridge)
// All INSERT/UPDATE/DELETE automatically sync to DuckDB columnar store

await db.stop();
```

## Features

- **HTAP Dual-Engine**: SQLite (OLTP row store) + DuckDB (OLAP columnar) with 100ms real-time CDC
- **HNSW Vector Search**: SIFT-128 1M — 100% recall@10 at 410 QPS
- **TDE Encryption**: AES-256-GCM file-level encryption with online key rotation
- **PG Compatible**: 156+ PostgreSQL syntax shims, PL/pgSQL stored procedures
- **Embeddable**: Zero external services required. Just `npm install` + `import`.

## Links

- [sqlvec-db-node](https://github.com/AgentiX-E/sqlvec-db-node) — Standalone PG-compatible server
- [sqlvec-db-cluster](https://github.com/AgentiX-E/sqlvec-db-cluster) — Raft distributed cluster
- [sqlvec-db-federation](https://github.com/AgentiX-E/sqlvec-db-federation) — Cross-DC enterprise deployment
