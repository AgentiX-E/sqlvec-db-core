/**
 * PartitionRouter — PostgreSQL-style partitioning for SQLite.
 *
 * Implements range/list/hash-based partitioning routing:
 *   - `CREATE TABLE ... PARTITION BY RANGE (col)` — registers a partitioned table
 *   - `CREATE TABLE ... PARTITION BY LIST (col)` — registers a list-partitioned table
 *   - `CREATE TABLE ... PARTITION BY HASH (col)` — registers a hash-partitioned table
 *   - `CREATE TABLE t PARTITION OF parent FOR VALUES FROM (x) TO (y)` — creates a child partition
 *   - `INSERT INTO parent VALUES (...)` — routes to the correct child partition
 *   - `SELECT ... WHERE col >= x AND col < y` — prunes to matching partitions only
 *
 * Partition metadata is stored in the `_sqlvec_partitions` system table.
 *
 * ## Design
 *
 * A partitioned table acts as a logical view over its child partitions. The
 * QueryRouter intercepts INSERT statements, computes the partition key, and
 * rewrites the target to the appropriate child table. SELECT queries with
 * range predicates on the partition column are pruned to only scan matching
 * partitions.
 *
 * @module query/PartitionRouter
 */

import { PinoLogger } from '../logger/PinoLogger';

// ── Logger ───────────────────────────────────────────────────────


// ── Types ────────────────────────────────────────────────────────

export type PartitionStrategy = 'range' | 'list' | 'hash';

export interface PartitionDefinition {
  /** The partitioned table name (qualified). */
  parentTable: string;
  /** Partitioning strategy ('range', 'list', 'hash'). */
  strategy: PartitionStrategy;
  /** Column name used as the partition key. */
  partitionKey: string;
  /** Registered child partitions, sorted by range start. */
  children: PartitionChild[];
}

export interface PartitionChild {
  /** Child table name. */
  childTable: string;
  /** Inclusive lower bound (for range: FROM (x)). */
  rangeFrom: any;
  /** Exclusive upper bound (for range: TO (y)). */
  rangeTo: any;
  /** For list partitioning: the list of values this partition holds. */
  listValues?: any[];
  /** For hash partitioning: the modulus and remainder. */
  hashModulus?: number;
  hashRemainder?: number;
  /** Whether this child is the default partition. */
  isDefault: boolean;
}

export interface PartitionRouteResult {
  /** The target table to route to (child table name). */
  targetTable: string;
  /** Any rewritten SQL to execute. */
  sql: string;
  /** Whether routing was applied. */
  routed: boolean;
}

// ── System table name ────────────────────────────────────────────

const SYSTEM_TABLE = '_sqlvec_partitions';

// ── PartitionRouter ──────────────────────────────────────────────

export class PartitionRouter {
  private readonly logger = PinoLogger.forComponent('partitionrouter');

  private partitions: Map<string, PartitionDefinition> = new Map();

  // ── DDL: Register / unregister partitions ─────────────────────

  /**
   * Register a partitioned table.
   *
   * Called when processing `CREATE TABLE ... PARTITION BY RANGE (col)`.
   *
   * @param parentTable - Qualified parent table name.
   * @param strategy    - Partitioning strategy.
   * @param partitionKey - Column name used as the partition key.
   */
  registerPartitionedTable(
    parentTable: string,
    strategy: PartitionStrategy,
    partitionKey: string,
  ): void {
    const def: PartitionDefinition = {
      parentTable,
      strategy,
      partitionKey,
      children: [],
    };
    this.partitions.set(parentTable, def);

    this.logger.info({ parentTable, strategy, partitionKey }, 'Partitioned table registered');
  }

  /**
   * Unregister a partitioned table and all its children.
   *
   * @param parentTable - Qualified parent table name.
   */
  unregisterPartitionedTable(parentTable: string): void {
    this.partitions.delete(parentTable);
    this.logger.info({ parentTable }, 'Partitioned table unregistered');
  }

  /**
   * Add a child partition to a previously registered parent.
   *
   * Called when processing `CREATE TABLE t PARTITION OF parent FOR VALUES FROM (x) TO (y)`.
   *
   * @param childTable  - Child table name.
   * @param parentTable - Parent partitioned table name.
   * @param rangeFrom   - Inclusive lower bound (any comparable value).
   * @param rangeTo     - Exclusive upper bound (any comparable value).
   * @param isDefault   - Whether this is the default partition.
   * @throws {Error} If the parent table is not registered as partitioned.
   */
  addChildPartition(
    childTable: string,
    parentTable: string,
    rangeFrom: any,
    rangeTo: any,
    isDefault: boolean = false,
    listValues?: any[],
    hashModulus?: number,
    hashRemainder?: number,
  ): void {
    const parent = this.partitions.get(parentTable);
    if (!parent) {
      throw new Error(
        `Cannot add child partition "${childTable}": parent "${parentTable}" is not a partitioned table`,
      );
    }

    const child: PartitionChild = {
      childTable,
      rangeFrom,
      rangeTo,
      isDefault,
      listValues,
      hashModulus,
      hashRemainder,
    };
    parent.children.push(child);

    // Keep children sorted by rangeFrom for efficient pruning.
    parent.children.sort((a, b) => {
      if (a.isDefault) return 1;
      if (b.isDefault) return -1;
      if (a.hashModulus !== undefined && b.hashModulus !== undefined) {
        return (a.hashRemainder || 0) - (b.hashRemainder || 0);
      }
      return String(a.rangeFrom).localeCompare(String(b.rangeFrom));
    });

    this.logger.info(
      { childTable, parentTable, rangeFrom, rangeTo, isDefault, listValues, hashModulus, hashRemainder },
      'Child partition added',
    );
  }

  /**
   * Drop a child partition from a parent.
   *
   * @param childTable  - Child table name to remove.
   * @param parentTable - Parent partitioned table name.
   */
  removeChildPartition(childTable: string, parentTable: string): void {
    const parent = this.partitions.get(parentTable);
    if (!parent) return;

    parent.children = parent.children.filter((c) => c.childTable !== childTable);
    this.logger.info({ childTable, parentTable }, 'Child partition removed');
  }

  // ── Query routing ─────────────────────────────────────────────

  /**
   * Route an INSERT into the parent table to the correct child partition.
   *
   * Parses the partition key value from the VALUES clause and finds the
   * matching child partition.
   *
   * @param parentTable - Target parent table.
   * @param insertSql   - The full INSERT statement.
   * @param partitionKeyValue - The extracted partition key value.
   * @returns The route result with the target child table name.
   * @throws {Error} If no matching partition is found.
   */
  routeInsert(
    parentTable: string,
    insertSql: string,
    partitionKeyValue: any,
  ): PartitionRouteResult {
    const parent = this.partitions.get(parentTable);
    if (!parent) {
      return { targetTable: parentTable, sql: insertSql, routed: false };
    }

    const child = this.findChild(parent, partitionKeyValue);
    if (!child) {
      throw new Error(
        `No partition found for key value "${partitionKeyValue}" on table "${parentTable}"`,
      );
    }

    // Rewrite the INSERT to target the child table.
    const rewrittenSql = insertSql.replace(
      new RegExp(`\\b${escapeRegex(parentTable)}\\b`, 'i'),
      child.childTable,
    );

    this.logger.debug(
      { parentTable, childTable: child.childTable, key: partitionKeyValue },
      'INSERT routed to partition',
    );

    return { targetTable: child.childTable, sql: rewrittenSql, routed: true };
  }

  /**
   * Predicate type for partition pruning.
   */
  static PartitionPredicateType = {
    GE: '>=' as const,
    LE: '<=' as const,
    GT: '>' as const,
    LT: '<' as const,
    EQ: '=' as const,
    IN: 'IN' as const,
    BETWEEN: 'BETWEEN' as const,
  };

  /**
   * Extract the WHERE clause from a SELECT SQL string.
   *
   * Returns the text between WHERE and the next clause keyword
   * (GROUP BY, ORDER BY, LIMIT, HAVING, etc.), or null if no WHERE exists.
   *
   * @param sql - The SELECT SQL string.
   * @returns The WHERE clause text, or null if not found.
   */
  static extractWhereClause(sql: string): string | null {
    const whereMatch = sql.match(/\bWHERE\b\s+/i);
    if (!whereMatch) return null;

    const afterWhere = sql.slice((whereMatch.index || 0) + whereMatch[0].length);

    // Find the next clause keyword that ends the WHERE clause.
    const clauseMatch = afterWhere.match(
      /\b(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|OFFSET|FOR\s+UPDATE|FOR\s+SHARE|WINDOW|INTERSECT|EXCEPT|UNION)\b/i,
    );

    if (clauseMatch) {
      return afterWhere.slice(0, clauseMatch.index).trim();
    }

    // No following clause — everything after WHERE is the WHERE clause.
    return afterWhere.trim();
  }

  /**
   * Prune a SELECT query to only scan matching partitions.
   *
   * Uses predicates on the partition key to determine which child
   * partitions are relevant. Returns the list of child tables to scan and
   * optionally a rewritten query.
   *
   * Supports RANGE predicates (>=, <=, >, <, =), LIST predicates (IN, =),
   * and HASH predicates (= for hash routing).
   *
   * @param parentTable - The partitioned table being queried.
   * @param selectSql   - The full SELECT statement.
   * @param predicates  - An array of predicates on the partition key.
   * @returns The list of child tables to union-scan.
   */
  pruneSelect(
    parentTable: string,
    selectSql: string,
    predicates?: Array<{ op: '>=' | '<' | '>' | '<=' | '=' | 'IN' | 'BETWEEN'; value: any; values?: any[] }>,
  ): { targetTables: string[]; sql: string } {
    const parent = this.partitions.get(parentTable);
    if (!parent || parent.children.length === 0) {
      return { targetTables: [parentTable], sql: selectSql };
    }

    // If no predicates are provided, scan all children.
    if (!predicates || predicates.length === 0) {
      const targetTables = parent.children.map((c) => c.childTable);
      const rewrittenSql = this.buildUnionSelect(targetTables, selectSql, parentTable);
      return { targetTables, sql: rewrittenSql };
    }

    // Route pruning based on strategy
    let matchingChildren: PartitionChild[];

    switch (parent.strategy) {
      case 'list':
        matchingChildren = this.listPartitionPrune(parent.children, predicates);
        break;
      case 'hash':
        matchingChildren = this.hashPartitionPrune(parent.children, predicates);
        break;
      case 'range':
      default:
        matchingChildren = this.rangePartitionPrune(parent.children, predicates);
        break;
    }

    if (matchingChildren.length === 0) {
      this.logger.warn(
        { parentTable, predicates, strategy: parent.strategy },
        'No matching partitions found — falling back to all children',
      );
      const allTables = parent.children.map((c) => c.childTable);
      return { targetTables: allTables, sql: selectSql };
    }

    const targetTables = matchingChildren.map((c) => c.childTable);
    const rewrittenSql = this.buildUnionSelect(targetTables, selectSql, parentTable);

    this.logger.debug(
      { parentTable, strategy: parent.strategy, matched: targetTables.length, total: parent.children.length },
      'Partition pruning applied',
    );

    return { targetTables, sql: rewrittenSql };
  }

  /**
   * Prune range partitions based on predicates.
   * Returns children whose range overlaps with the predicate conditions.
   */
  private rangePartitionPrune(
    children: PartitionChild[],
    predicates: Array<{ op: '>=' | '<' | '>' | '<=' | '=' | 'IN' | 'BETWEEN'; value: any; values?: any[] }>,
  ): PartitionChild[] {
    const matchingChildren: PartitionChild[] = [];

    for (const child of children) {
      if (child.isDefault) {
        matchingChildren.push(child);
        continue;
      }

      const qualifies = predicates.every((p) => {
        switch (p.op) {
          case '>=':
          case '>':
            // The child's upper bound must be > (or >=) the predicate value.
            return compare(child.rangeTo, p.value) > 0;
          case '<':
          case '<=':
            // The child's lower bound must be < (or <=) the predicate value.
            return compare(child.rangeFrom, p.value) < 0;
          case '=':
            // The value must fall within this child's range.
            return (
              compare(p.value, child.rangeFrom) >= 0 &&
              compare(p.value, child.rangeTo) < 0
            );
          case 'BETWEEN':
            // The child's range overlaps with [betweenLow, betweenHigh]
            return (
              compare(child.rangeFrom, p.values![1]) < 0 &&
              compare(child.rangeTo, p.values![0]) > 0
            );
          case 'IN':
            // At least one IN value falls within this child's range
            return (p.values || []).some((v: any) =>
              compare(v, child.rangeFrom) >= 0 &&
              compare(v, child.rangeTo) < 0
            );
          default:
            return true;
        }
      });

      if (qualifies) {
        matchingChildren.push(child);
      }
    }

    return matchingChildren;
  }

  /**
   * Prune list partitions based on predicates.
   * Returns children whose list values match the predicate conditions.
   */
  private listPartitionPrune(
    children: PartitionChild[],
    predicates: Array<{ op: string; value: any; values?: any[] }>,
  ): PartitionChild[] {
    const matchingChildren: PartitionChild[] = [];
    const matchedValues = new Set<any>();

    for (const pred of predicates) {
      if (pred.op === '=') {
        matchedValues.add(pred.value);
      } else if (pred.op === 'IN') {
        for (const v of pred.values || []) {
          matchedValues.add(v);
        }
      }
    }

    if (matchedValues.size === 0) {
      // No equality/IN predicates — return all children
      return children;
    }

    for (const child of children) {
      if (child.isDefault) {
        matchingChildren.push(child);
        continue;
      }

      // Check if any match value is in this child's list values
      const hasMatch = (child.listValues || []).some((lv: any) =>
        matchedValues.has(lv) || [...matchedValues].some((mv: any) => compare(mv, lv) === 0),
      );
      if (hasMatch) {
        matchingChildren.push(child);
      }
    }

    return matchingChildren;
  }

  /**
   * Prune hash partitions based on predicates.
   * For hash partitioning, only = predicates are meaningful.
   * We compute hash(value) % modulus and match against the child's hashRemainder.
   */
  private hashPartitionPrune(
    children: PartitionChild[],
    predicates: Array<{ op: string; value: any; values?: any[] }>,
  ): PartitionChild[] {
    // Collect all concrete values from = and IN predicates
    const values: any[] = [];
    for (const pred of predicates) {
      if (pred.op === '=') {
        values.push(pred.value);
      } else if (pred.op === 'IN') {
        values.push(...(pred.values || []));
      }
    }

    if (values.length === 0) {
      // No equality/IN predicates — return all children
      return children;
    }

    const matchingChildren: PartitionChild[] = [];
    const neededRemainders = new Set<number>();

    // Compute which remainders are needed
    for (const v of values) {
      const hashVal = this.hashValue(v);
      for (const child of children) {
        if (child.hashModulus !== undefined) {
          const remainder = hashVal % child.hashModulus;
          neededRemainders.add(remainder);
        }
      }
    }

    for (const child of children) {
      if (child.isDefault) {
        matchingChildren.push(child);
        continue;
      }
      if (
        child.hashRemainder !== undefined &&
        neededRemainders.has(child.hashRemainder)
      ) {
        matchingChildren.push(child);
      }
    }

    return matchingChildren;
  }

  /**
   * Check whether a table is a registered partitioned table.
   *
   * @param tableName - Table name to check.
   * @returns `true` if the table is a registered partitioned parent.
   */
  isPartitioned(tableName: string): boolean {
    return this.partitions.has(tableName);
  }

  /**
   * Get the partition definition for a table.
   *
   * @param tableName - Table name.
   * @returns The partition definition, or `undefined` if not registered.
   */
  getPartition(tableName: string): PartitionDefinition | undefined {
    return this.partitions.get(tableName);
  }

  /**
   * Get all registered partition definitions (for system table querying).
   */
  getAllPartitions(): PartitionDefinition[] {
    return Array.from(this.partitions.values());
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.partitions.clear();
    this.logger.info('PartitionRouter state reset');
  }

  // ── Private helpers ───────────────────────────────────────────

  /**
   * Find the child partition that contains the given key value.
   * Supports range, list, and hash strategies.
   */
  private findChild(parent: PartitionDefinition, value: any): PartitionChild | undefined {
    switch (parent.strategy) {
      case 'range':
        // First try non-default children.
        for (const child of parent.children) {
          if (child.isDefault) continue;
          if (compare(value, child.rangeFrom) >= 0 && compare(value, child.rangeTo) < 0) {
            return child;
          }
        }
        // Fall through to the default partition, if any.
        return parent.children.find((c) => c.isDefault);

      case 'list':
        for (const child of parent.children) {
          if (child.listValues && child.listValues.some((lv) => compare(lv, value) === 0)) {
            return child;
          }
        }
        return parent.children.find((c) => c.isDefault);

      case 'hash': {
        // Convert value to a numeric hash
        const hashVal = this.hashValue(value);
        for (const child of parent.children) {
          if (
            child.hashModulus !== undefined &&
            child.hashRemainder !== undefined &&
            hashVal % child.hashModulus === child.hashRemainder
          ) {
            return child;
          }
        }
        return parent.children.find((c) => c.isDefault);
      }

      default:
        return parent.children.find((c) => c.isDefault);
    }
  }

  /**
   * Route an UPDATE or DELETE statement to the correct partition(s).
   * If the WHERE clause contains a partition key predicate, we can route
   * to a single partition; otherwise we apply to all partitions.
   *
   * @param parentTable - Target parent table.
   * @param dmlSql   - The full UPDATE or DELETE statement.
   * @param partitionKeyValue - Optional extracted partition key value from WHERE.
   * @returns The route result with the target child table name(s).
   */
  routeDML(
    parentTable: string,
    dmlSql: string,
    partitionKeyValue?: any,
  ): PartitionRouteResult & { targetTables?: string[] } {
    const parent = this.partitions.get(parentTable);
    if (!parent) {
      return { targetTable: parentTable, sql: dmlSql, routed: false };
    }

    if (partitionKeyValue !== undefined) {
      const child = this.findChild(parent, partitionKeyValue);
      if (!child) {
        throw new Error(
          `No partition found for key value "${partitionKeyValue}" on table "${parentTable}"`,
        );
      }
      const rewrittenSql = dmlSql.replace(
        new RegExp(`\\b${escapeRegex(parentTable)}\\b`, 'i'),
        child.childTable,
      );
      return { targetTable: child.childTable, targetTables: [child.childTable], sql: rewrittenSql, routed: true };
    }

    // No partition key — apply to all children
    if (parent.children.length === 0) {
      return { targetTable: parentTable, sql: dmlSql, routed: false };
    }

    // Return the list of all child tables for multi-target routing
    const targetTables = parent.children.filter(c => !c.isDefault).map(c => c.childTable);
    return { targetTable: parentTable, targetTables, sql: dmlSql, routed: true };
  }

  /**
   * Compute a hash value for hash partitioning from the partition key value.
   * Returns a non-negative integer.
   */
  private hashValue(value: any): number {
    if (typeof value === 'number') {
      return Math.abs(Math.floor(value));
    }
    if (typeof value === 'string') {
      let hash = 0;
      for (let i = 0; i < value.length; i++) {
        const char = value.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      return Math.abs(hash);
    }
    return 0;
  }

  /**
   * Build a UNION ALL SELECT over multiple child partitions.
   *
   * Replaces the FROM clause pointing to the parent with a UNION ALL over
   * the matching child tables.
   */
  private buildUnionSelect(
    targetTables: string[],
    originalSql: string,
    parentTable: string,
  ): string {
    if (targetTables.length === 1) {
      // Single partition — just rewrite the table name.
      const sql = originalSql.replace(
        new RegExp(`\\b${escapeRegex(parentTable)}\\b`, 'i'),
        targetTables[0],
      );
      return sql;
    }

    // Multiple partitions — replace the parent relation with a UNION ALL
    // subquery over the matching children, preserving the original SELECT
    // list, WHERE, and other clauses.
    const childQueries = targetTables
      .map((t) => `SELECT * FROM ${t}`)
      .join('\nUNION ALL\n');
    return originalSql.replace(
      new RegExp(`\\b${escapeRegex(parentTable)}\\b`, 'i'),
      `(\n${childQueries}\n)`,
    );
  }
}

// ── Utility functions ────────────────────────────────────────────

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compare two values that may be strings, numbers, or Dates.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
function compare(a: any, b: any): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  return String(a).localeCompare(String(b));
}
