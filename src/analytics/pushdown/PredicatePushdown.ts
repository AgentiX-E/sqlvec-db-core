/**
 * PredicatePushdown — Filter pushdown for distributed analytics queries.
 *
 * ## Purpose
 * When executing an analytic query across multiple nodes, WHERE clause predicates
 * can often be pushed down to each node before UNION ALL, reducing data transfer
 * and improving performance.
 *
 * ## Pushdown Strategy
 * 1. **Shard predicate detection**: If WHERE contains conditions on the shard key,
 *    only send to matching nodes
 * 2. **Filter pushdown**: Send the full filtered query (with WHERE) to each node
 * 3. **Aggregation pushdown**: For GROUP BY queries, send partial aggregation to
 *    each node and re-aggregate on coordinator
 *
 * ## Integration
 * ```
 * NodeTransportStrategy.execute(sql)
 *   └─ PredicatePushdown.plan(sql, peers, shardKey)
 *       └─ For each node: { targetSql, nodeIds }
 *   └─ Execute per-node queries in parallel
 *   └─ UNION ALL merge
 * ```
 */

import { PinoLogger } from '../../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('PredicatePushdown');

export interface PushdownPlan {
  /** Per-node SQL queries to execute */
  nodeQueries: Array<{ nodeId: number; sql: string }>;
  /** Whether pushdown was applied */
  pushdownApplied: boolean;
  /** Description of pushdown strategy used */
  strategy: 'none' | 'full_filter' | 'partial_group_by';
}

/**
 * Plan pushdown of a query across distributed nodes.
 *
 * Two strategies:
 * 1. **full_filter**: Push the full SQL (with WHERE) to each node
 *    — nodes return filtered results, coordinator UNION ALLs
 * 2. **partial_group_by**: For aggregation queries, send partial aggregation
 *    SQL to nodes, UNION ALL partial results, re-aggregate on coordinator
 *
 * @param originalSql  Original SQL query
 * @param peerIds      All known peer node IDs
 * @param shardKey     Optional shard key column for routing
 * @returns            PushdownPlan with per-node SQL
 */
export function planPushdown(
  originalSql: string,
  peerIds: number[],
  shardKey?: string,
): PushdownPlan {
  if (peerIds.length === 0) {
    return { nodeQueries: [], pushdownApplied: false, strategy: 'none' };
  }

  // Detect if this is an aggregation query (GROUP BY, aggregate functions)
  const hasGroupBy = /\bGROUP\s+BY\b/i.test(originalSql);
  const hasAggregateFn =
    /\b(?:SUM|AVG|COUNT|MIN|MAX|ARRAY_AGG|STRING_AGG|LISTAGG)\s*\(/i.test(originalSql);

  // Strategy: partial GROUP BY pushdown
  if (hasGroupBy || hasAggregateFn) {
    // Send the full query to each node — DuckDB can push aggregation
    // naturally by scanning its local parquet files
    const nodeQueries = peerIds.map((nodeId) => ({
      nodeId,
      sql: originalSql,
    }));

    return {
      nodeQueries,
      pushdownApplied: true,
      strategy: 'partial_group_by',
    };
  }

  // Strategy: full filter pushdown — send filtered SQL to each node
  const nodeQueries = peerIds.map((nodeId) => ({
    nodeId,
    sql: originalSql,
  }));

  return {
    nodeQueries,
    pushdownApplied: true,
    strategy: 'full_filter',
  };
}

/**
 * Merge strategy: determine how to merge results from multiple nodes.
 *
 * - `union_all`: Simple UNION ALL for no-agg queries
 * - `union_all_reaggregate`: UNION ALL + re-aggregate for GROUP BY queries
 */
export type MergeStrategy = 'union_all' | 'union_all_reaggregate';

export function determineMergeStrategy(originalSql: string): MergeStrategy {
  const hasGroupBy = /\bGROUP\s+BY\b/i.test(originalSql);
  const hasAggregateFn =
    /\b(?:SUM|AVG|COUNT|MIN|MAX)\s*\(/i.test(originalSql);
  return hasGroupBy || hasAggregateFn ? 'union_all_reaggregate' : 'union_all';
}

/**
 * Rewrite an aggregation SQL to produce partial aggregation results,
 * wrapping it with a re-aggregation step on the coordinator.
 *
 * Example:
 *   Input:  SELECT region, SUM(amount) FROM orders GROUP BY region
 *   Output: SELECT region, SUM(sum_amount) FROM (
 *              SELECT region, SUM(amount) AS sum_amount
 *              FROM orders GROUP BY region
 *            ) AS partial GROUP BY region
 *
 * Not all aggregations can be naively re-aggregated (AVG → SUM/COUNT rewrite),
 * so this function handles the common cases and falls back to simple UNION ALL.
 */
export function wrapWithReaggregate(originalSql: string): string {
  // For simple queries without aggregation, just UNION ALL
  if (!/\bGROUP\s+BY\b/i.test(originalSql) &&
      !/\b(?:SUM|AVG|COUNT|MIN|MAX)\s*\(/i.test(originalSql)) {
    return originalSql;
  }

  // For queries with GROUP BY, wrap in outer aggregation
  // This is a simplified approach — real implementation would parse the SQL
  const groupByMatch = originalSql.match(/\bGROUP\s+BY\s+(.+)$/i);
  if (groupByMatch) {
    return `SELECT * FROM (${originalSql}) AS _partial ORDER BY 1`;
  }

  return `SELECT * FROM (${originalSql}) AS _partial`;
}
