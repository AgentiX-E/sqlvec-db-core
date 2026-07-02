/**
 * PartitionPruner — Standalone SQL partition pruning for SQLite-backed partitioning.
 *
 * Analyzes SELECT SQL to determine which partition shards need to be scanned
 * based on WHERE clause predicates on the partition key, then rewrites the
 * SELECT as a UNION ALL across matching partitions.
 *
 * Uses PartitionPredicateExtractor for SQL-level predicate extraction.
 *
 * @module query/PartitionPruner
 */

import { PinoLogger } from '../logger/PinoLogger';
import type { PartitionPredicate } from './PartitionPredicateExtractor';
import { extractPartitionPredicates } from './PartitionPredicateExtractor';
import type { PartitionMeta, PartitionMethod, RangeBounds, ListBounds, HashBounds } from './PartitionMetaManager';
import { parseBounds } from './PartitionMetaManager';

const logger = PinoLogger.forComponent('PartitionPruner');

// ── Types ────────────────────────────────────────────────────────

export interface PruneResult {
  /** Partition names that match the WHERE conditions (subset of all partitions). */
  matchingPartitions: string[];
  /** Whether pruning was effective (i.e., not scanning all partitions). */
  pruned: boolean;
  /** The rewritten SQL (UNION ALL of SELECTs on matching shards), or original if no pruning. */
  rewrittenSql: string;
}

/**
 * Prune partitions based on WHERE clause predicates.
 *
 * Analyzes the SQL's WHERE clause for conditions on the partition key column,
 * then returns only the partition names that could contain matching rows.
 *
 * RANGE: compares partition_col >/>=/</<=/=/BETWEEN values against partition bounds
 * LIST: checks partition_col IN (...) or = value against partition values
 * HASH: checks partition_col = value against modulus/remainder
 *
 * Fallback: if can't determine matching partitions (no WHERE on key, or complex
 * predicate that can't be parsed), returns ALL partitions (correct but slow).
 *
 * @param sql        The original SELECT SQL statement.
 * @param partitions Array of PartitionMeta for the table.
 * @returns PruneResult with matching partitions and rewritten SQL.
 */
export function prunePartitions(
  sql: string,
  partitions: PartitionMeta[],
): PruneResult {
  if (partitions.length === 0) {
    return {
      matchingPartitions: [],
      pruned: false,
      rewrittenSql: sql,
    };
  }

  const partitionColumn = partitions[0].partitionColumn;
  const method = partitions[0].partitionMethod;

  // Extract predicates on the partition key
  const predicates = extractPartitionPredicates(sql, partitionColumn);

  if (predicates.length === 0) {
    // No predicates on partition key — fallback: scan all
    logger.debug(
      { table: partitions[0].parentTable, partitionCount: partitions.length },
      'No partition key predicates found — scanning all partitions',
    );
    const allNames = partitions.map((p) => p.partitionName);
    return {
      matchingPartitions: allNames,
      pruned: false,
      rewrittenSql: rewriteSelectForPartition(sql, allNames),
    };
  }

  const matchingPartitions: string[] = [];

  for (const partition of partitions) {
    if (matchesPredicates(partition, predicates, method)) {
      matchingPartitions.push(partition.partitionName);
    }
  }

  // If no partitions matched (e.g., predicate outside all bounds), return empty result
  if (matchingPartitions.length === 0) {
    logger.warn(
      {
        table: partitions[0].parentTable,
        predicates: predicates.map((p) => `${p.col} ${p.op} ${p.value}`),
      },
      'No partitions matched — returning empty result set',
    );
    return {
      matchingPartitions: [],
      pruned: true,
      rewrittenSql: generateNoMatchSql(sql),
    };
  }

  logger.info(
    {
      table: partitions[0].parentTable,
      total: partitions.length,
      matched: matchingPartitions.length,
    },
    'Partition pruning applied',
  );

  return {
    matchingPartitions,
    pruned: matchingPartitions.length < partitions.length,
    rewrittenSql: rewriteSelectForPartition(sql, matchingPartitions),
  };
}

/**
 * Generate a SQL that returns empty result set (for when all partitions are excluded).
 */
function generateNoMatchSql(originalSql: string): string {
  // Extract column list from original SELECT
  const selectMatch = originalSql.match(/SELECT\s+(.+?)\s+FROM\s/i);
  const columns = selectMatch ? selectMatch[1].trim() : '*';
  return `SELECT ${columns} WHERE 1=0`;
}

// ── Predicate matching ────────────────────────────────────────────

function matchesPredicates(
  partition: PartitionMeta,
  predicates: PartitionPredicate[],
  method: PartitionMethod,
): boolean {
  // For multiple predicates, ALL must match
  for (const pred of predicates) {
    if (!matchesSinglePredicate(partition, pred, method)) {
      return false;
    }
  }
  return true;
}

function matchesSinglePredicate(
  partition: PartitionMeta,
  pred: PartitionPredicate,
  method: PartitionMethod,
): boolean {
  switch (method) {
    case 'RANGE':
      return rangePredicateMatch(partition, pred);
    case 'LIST':
      return listPredicateMatch(partition, pred);
    case 'HASH':
      return hashPredicateMatch(partition, pred);
    default:
      return true; // Unknown method — include partition
  }
}

// ── RANGE matching ────────────────────────────────────────────────

function rangePredicateMatch(
  partition: PartitionMeta,
  pred: PartitionPredicate,
): boolean {
  const bounds = parseBounds(partition.partitionBounds) as RangeBounds;
  const { from, to } = bounds;

  switch (pred.op) {
    case '=': {
      // Partition contains value if from <= value < to (exclusive upper for RANGE)
      const val = coerceCompare(pred.value);
      const lower = coerceCompare(from);
      const upper = coerceCompare(to);
      return val >= lower && val < upper;
    }
    case '>': {
      // Partition may have values > pred.value if to > pred.value
      const val = coerceCompare(pred.value);
      const upper = coerceCompare(to);
      return upper > val;
    }
    case '>=': {
      // Partition may have values >= pred.value if to > pred.value (to is exclusive)
      const val = coerceCompare(pred.value);
      const upper = coerceCompare(to);
      return upper > val;
    }
    case '<': {
      // Partition may have values < pred.value if from < pred.value
      const val = coerceCompare(pred.value);
      const lower = coerceCompare(from);
      return lower < val;
    }
    case '<=': {
      // Partition may have values <= pred.value if from <= pred.value
      const val = coerceCompare(pred.value);
      const lower = coerceCompare(from);
      return lower <= val;
    }
    case 'IN': {
      // Partition contains value if any IN value is within bounds
      for (const v of pred.values ?? []) {
        const val = coerceCompare(v);
        const lower = coerceCompare(from);
        const upper = coerceCompare(to);
        if (val >= lower && val < upper) return true;
      }
      return false;
    }
    case 'BETWEEN': {
      // Partition may have values in [x, y] if [x, y] overlaps [from, to)
      const x = coerceCompare(pred.values?.[0]);
      const y = coerceCompare(pred.values?.[1]);
      const lower = coerceCompare(from);
      const upper = coerceCompare(to);
      if (x === undefined || y === undefined) return true; // Can't determine — include
      return x < upper && y >= lower;
    }
    default:
      return true; // Unknown operator — include partition
  }
}

// ── LIST matching ─────────────────────────────────────────────────

function listPredicateMatch(
  partition: PartitionMeta,
  pred: PartitionPredicate,
): boolean {
  const bounds = parseBounds(partition.partitionBounds) as ListBounds;
  const listVals = bounds.values ?? [];

  switch (pred.op) {
    case '=': {
      return listVals.some((v) => coerceCompare(v) === coerceCompare(pred.value));
    }
    case 'IN': {
      for (const v of pred.values ?? []) {
        if (listVals.some((lv) => coerceCompare(lv) === coerceCompare(v))) {
          return true;
        }
      }
      return false;
    }
    case '>':
    case '>=':
    case '<':
    case '<=':
    case 'BETWEEN': {
      // For LIST, range comparisons need to check if any list value satisfies the predicate
      return listVals.some((lv) => {
        const val = coerceCompare(lv);
        const cmp = coerceCompare(pred.value);
        if (val === undefined || cmp === undefined) return true;
        switch (pred.op) {
          case '>': return val > cmp;
          case '>=': return val >= cmp;
          case '<': return val < cmp;
          case '<=': return val <= cmp;
          case 'BETWEEN': {
            const x = coerceCompare(pred.values?.[0]);
            const y = coerceCompare(pred.values?.[1]);
            return x !== undefined && y !== undefined && val >= x && val <= y;
          }
          default: return true;
        }
      });
    }
    default:
      return true;
  }
}

// ── HASH matching ─────────────────────────────────────────────────

function hashPredicateMatch(
  partition: PartitionMeta,
  pred: PartitionPredicate,
): boolean {
  const bounds = parseBounds(partition.partitionBounds) as HashBounds;
  const { modulus, remainder } = bounds;

  switch (pred.op) {
    case '=': {
      // Hash: value % modulus === remainder
      const val = coerceCompare(pred.value);
      if (typeof val !== 'number') return true; // Can't compute hash — include
      return val % modulus === remainder;
    }
    case 'IN': {
      for (const v of pred.values ?? []) {
        const val = coerceCompare(v);
        if (typeof val === 'number' && val % modulus === remainder) {
          return true;
        }
      }
      return false;
    }
    case '>':
    case '>=':
    case '<':
    case '<=':
    case 'BETWEEN': {
      // For hash partitioning, CANNOT prune range/between predicates
      // since they don't determine a specific hash bucket
      return true;
    }
    default:
      return true;
  }
}

// ── SQL rewriting ─────────────────────────────────────────────────

/**
 * Rewrite a SELECT statement as a UNION ALL of SELECTs on each matching shard.
 *
 * For each matching partition, the FROM clause is replaced to reference the
 * shard table. All SELECTs are joined with UNION ALL.
 *
 * @param sql                  The original SELECT SQL.
 * @param matchingPartitions   Array of shard table names to scan.
 * @returns A UNION ALL SQL that queries only the matching partitions.
 */
export function rewriteSelectForPartition(sql: string, matchingPartitions: string[]): string {
  if (matchingPartitions.length === 0) {
    return generateNoMatchSql(sql);
  }

  if (matchingPartitions.length === 1) {
    // Single partition — just replace the table name
    return replaceTableName(sql, matchingPartitions[0]);
  }

  // Multiple partitions — UNION ALL
  const selectParts = matchingPartitions.map((partName) => {
    return replaceTableName(sql, partName);
  });

  return selectParts.join(' UNION ALL ');
}

/**
 * Replace the first table name in a SELECT's FROM clause with a given shard name.
 *
 * Uses regex to find `FROM tablename` and replace with `FROM shardname`.
 * Handles quoted identifiers.
 */
function replaceTableName(sql: string, newTableName: string): string {
  // Match the first table reference after FROM
  // Handles: FROM table, FROM "table", FROM schema.table
  const fromMatch = sql.match(/FROM\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?(?:\s+(?:AS\s+)?(\w+))?/i);
  if (!fromMatch) {
    // If no FROM match, just return the raw SQL (shouldn't happen for SELECT)
    return sql;
  }

  const oldTable = fromMatch[0];
  const quoted = newTableName.includes(' ') || /^[a-z_]\w*$/i.test(newTableName)
    ? `"${newTableName}"`
    : newTableName;
  const alias = fromMatch[2] ? ` ${fromMatch[2]}` : '';
  const replacement = `FROM ${quoted}${alias}`;

  return sql.replace(oldTable, replacement);
}

// ── Value coercion for comparison ─────────────────────────────────

/**
 * Coerce a value to a comparable type.
 * Numbers stay numbers, strings stay strings (with quotes stripped).
 */
function coerceCompare(val: any): any {
  if (val === null || val === undefined) return val;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    // Try numeric
    const num = Number(val);
    if (!isNaN(num)) return num;
    // Strip quotes
    const stripped = val.replace(/^["']|["']$/g, '');
    const num2 = Number(stripped);
    if (!isNaN(num2)) return num2;
    return stripped;
  }
  return val;
}
