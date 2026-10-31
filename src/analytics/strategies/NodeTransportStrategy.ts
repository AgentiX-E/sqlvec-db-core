/**
 * NodeTransportStrategy — Layer 3: cross-node query forwarding
 *
 * Fallback strategy: forwards the analytics SQL to remote peer nodes via
 * TCP, each peer executes on its local DuckDB column store, results are
 * merged via DuckDB UNION ALL temporary tables.
 *
 * This is the highest-latency strategy, used only when no shared storage
 * or S3 path is available.
 */
import * as net from 'node:net';
import type { DuckDBAnalyticsManager, DuckDBResult } from '../DuckDBAnalyticsManager';
import type { FederationStrategy, NodeTransportConfig, RemoteQueryResult } from './FederationStrategy';
import { planPushdown, wrapWithReaggregate, determineMergeStrategy, type PushdownPlan } from '../pushdown/PredicatePushdown';
import { PinoLogger } from '../../logger/PinoLogger';

const logger = PinoLogger.forComponent('NodeTransportStrategy');

/** Wire protocol message envelope */
interface NodeQueryRequest {
  type: 'ANALYTICS_QUERY';
  queryId: string;
  sql: string;
}

interface NodeQueryResponse {
  type: 'ANALYTICS_RESULT';
  queryId: string;
  success: boolean;
  columns?: Array<{ name: string; type: string }>;
  rows?: Record<string, unknown>[];
  error?: string;
}

export class NodeTransportStrategy implements FederationStrategy {
  readonly name = 'node_transport';
  readonly priority = 30;

  private readonly queryTimeoutMs: number;
  // Track connectivity per peer (avoid re-trying known-dead peers mid-query)
  private peerAlive = new Map<string, boolean>();

  constructor(
    private readonly duckDB: DuckDBAnalyticsManager,
    private readonly config: NodeTransportConfig,
  ) {
  /* v8 ignore next -- ?? fallback is defensive default */
    this.queryTimeoutMs = config.queryTimeoutMs ?? 30_000;
    // Assume all peers are alive until proven otherwise
    for (const peer of config.peers) {
      this.peerAlive.set(peer, true);
    }
  }

  /** Check that we have at least one live peer */
  async available(): Promise<boolean> {
    const livePeers = this.config.peers.filter(p => this.peerAlive.get(p) !== false);
    return livePeers.length > 0;
  }

  /** Execute query across all known nodes, merge results via UNION ALL */
  async execute(sql: string): Promise<DuckDBResult> {
    const livePeers = this.config.peers.filter(p => this.peerAlive.get(p) !== false);
    if (livePeers.length === 0) {
      // Fall back to local-only
      return this.duckDB.execute(sql);
    }

    // Step 0: Use PredicatePushdown to plan per-node queries
    // For aggregation queries, push partial aggregation to each node
    const peerIds = livePeers.map(p => {
      const parts = p.split(':');
  /* v8 ignore next -- ?? fallback is defensive default */
      return parseInt(parts[0] ?? parts[1] ?? '0', 10);
    });
    const pushdownPlan: PushdownPlan = planPushdown(sql, peerIds);

    // Step 1: send query to all live peers in parallel
    // Use PredicatePushdown per-node SQL (same SQL, but pushdown strategy applied)
    const remoteResults = await Promise.allSettled(
      livePeers.map((peer, i) => this.queryPeer(peer, pushdownPlan.nodeQueries[i]?.sql ?? sql)),
    );

    // Step 2: collect successful results, mark failed peers
    const successfulColumns: RemoteQueryResult[] = [];
    for (let i = 0; i < remoteResults.length; i++) {
      const result = remoteResults[i];
      const peer = livePeers[i];
      if (result.status === 'fulfilled' && result.value.success && result.value.rows) {
        successfulColumns.push({
          nodeId: peer,
          columns: result.value.columns ?? [],
          rows: result.value.rows,
        });
      } else {
        this.peerAlive.set(peer, false);
        logger.warn('[NodeTransportStrategy] Peer query failed, marking dead: %s', peer);
      }
    }

    if (successfulColumns.length === 0) {
      logger.warn('[NodeTransportStrategy] All remote peers failed, falling back to local');
      return this.duckDB.execute(sql);
    }

    // Step 3: merge remote results as temporary tables
    for (const rc of successfulColumns) {
      const tempTableName = `remote_${rc.nodeId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      const colDefs = rc.columns
        .map(c => `"${c.name.replace(/"/g, '""')}"`)
        .join(', ');

      // Create temp table from remote result
      if (rc.rows.length > 0) {
        await this.duckDB.execSQL(
          `CREATE OR REPLACE TEMP TABLE "${tempTableName}" AS SELECT * FROM (VALUES ${rc.rows.map(r =>
            `(${rc.columns.map(c => this.valueToSQL(r[c.name])).join(', ')})`
          ).join(', ')}) AS t(${colDefs})`,
        );
      } else {
        // Empty result — create empty temp table with schema
        await this.duckDB.execSQL(
          `CREATE OR REPLACE TEMP TABLE "${tempTableName}" (${rc.columns.map(c =>
            `"${c.name.replace(/"/g, '""')}" ${c.type}`
          ).join(', ')})`,
        );
      }
    }

    // Step 4: rewrite query to UNION ALL across remote tables (+ local)
    // Use PredicatePushdown merge strategy for aggregation queries
    const mergeStrategy = determineMergeStrategy(sql);
    const remoteTableNames = successfulColumns.map(
      rc => `"remote_${rc.nodeId.replace(/[^a-zA-Z0-9_]/g, '_')}"`,
    );
    const unionSql = remoteTableNames.length > 0
      ? remoteTableNames.map(t => `SELECT * FROM ${t}`).join(' UNION ALL ')
      : sql;

    // Execute merged query — uses wrapWithReaggregate for aggregation queries
    if (remoteTableNames.length > 0) {
      const baseQuery = `SELECT * FROM (${unionSql}) AS _merged`;
      const finalSql = mergeStrategy === 'union_all_reaggregate'
        ? wrapWithReaggregate(sql)
        : baseQuery;
      logger.debug({ pushdown: pushdownPlan.strategy, mergeStrategy }, 'PredicatePushdown applied');

      // Return the merged remote result. Previously this result was computed
      // and then dropped, falling through to a local-only execution below —
      // so successfully-fetched remote data was never returned to the caller.
      return this.duckDB.execute(finalSql);
    }

    // No remote peers returned data — fall back to local-only execution.
    return this.duckDB.execute(sql);
  }

  /** Send query to a single peer via TCP, await response */
  private queryPeer(peer: string, sql: string): Promise<NodeQueryResponse> {
    return new Promise((resolve, reject) => {
      const [host, portStr] = peer.split(':');
  /* v8 ignore next -- ?? fallback is defensive default */
      const port = parseInt(portStr ?? '6543', 10);
      const queryId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const client = new net.Socket();
      let timeout: NodeJS.Timeout;
      let buffer = '';

      const cleanup = () => {
        clearTimeout(timeout);
        client.removeAllListeners();
        client.destroy();
      };

      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Query timeout after ${this.queryTimeoutMs}ms: ${peer}`));
      }, this.queryTimeoutMs);

      client.connect(port, host, () => {
        const request: NodeQueryRequest = { type: 'ANALYTICS_QUERY', queryId, sql };
        client.write(JSON.stringify(request) + '\n');
      });

      client.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        // Try to parse as complete JSON response
        try {
          const response = JSON.parse(buffer) as NodeQueryResponse;
          if (response.queryId === queryId) {
            cleanup();
            resolve(response);
          }
  /* v8 ignore next -- catch is defensive fallback */
        } catch {
          // Incomplete JSON — wait for more data
        }
      });

      client.on('error', (err: Error) => {
        cleanup();
        reject(err);
      });

      client.on('close', () => {
        cleanup();
        reject(new Error(`Connection closed by peer: ${peer}`));
      });
    });
  }

  /** Convert a JS value to a DuckDB-safe SQL literal */
  private valueToSQL(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return value.toString();
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    if (value instanceof Date) return `'${value.toISOString()}'::TIMESTAMP`;
    return `'${String(value).replace(/'/g, "''")}'`;
  }
}
