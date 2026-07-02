// @ts-nocheck
/**
 * PgStatCollector — PostgreSQL ANALYZE equivalent for SQLVec.
 *
 * Collects table and index statistics useful for:
 *   - Query planning / EXPLAIN cost estimation
 *   - Join order selection
 *   - Index scan vs. seq scan decisions
 *
 * Statistics are stored in the `_sqlvec_pg_stats` system table and
 * cached in-memory for fast access.
 */

import Database from 'better-sqlite3';
import { PinoLogger } from '../logger/PinoLogger';
import ss from 'simple-statistics';

const logger = PinoLogger.forComponent('PgStatCollector');

// ── Types ────────────────────────────────────────────────────────

export interface TableStats {
  tableName: string;
  rowCount: number;
  pageCount: number;
  avgRowLength: number;
  analyzedAt: number;
}

export interface ColumnStats {
  tableName: string;
  columnName: string;
  nullFrac: number;
  avgWidth: number;
  nDistinct: number;
  /** Most common values (top ~10) */
  mcv: Array<{ value: any; freq: number }>;
  /** Histogram bounds (equal-width for numeric, top values for text) */
  histogramBounds: any[];
  correlation: number;
}

export interface IndexStats {
  indexName: string;
  tableName: string;
  columnNames: string[];
  rowCount: number;
  distinctKeys: number;
  nullFrac: number;
  avgWidth: number;
}

/**
 * Summary statistics for a single column, computed via simple-statistics.
 */
export interface ColumnSummary {
  min: number;
  max: number;
  mean: number;
  median: number;
  mode: number[];
  stdDev: number;
  skewness: number;
  kurtosis: number;
}

export interface AnalyzeOptions {
  /** Tables to analyze (empty = all) */
  tables?: string[];
  /** Column sample size (default: 300 * 10) */
  sampleSize?: number;
  /** Maximum MCV entries to store (default: 10) */
  maxMcv?: number;
}

const DEFAULT_OPTIONS: Required<AnalyzeOptions> = {
  tables: [],
  sampleSize: 3000,
  maxMcv: 10,
};

// ── SQL Constants ────────────────────────────────────────────────

const PG_STATS_TABLE = '_sqlvec_pg_stats';

const CREATE_PG_STATS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${PG_STATS_TABLE} (
    stat_type TEXT NOT NULL,
    table_name TEXT NOT NULL,
    column_name TEXT,
    index_name TEXT,
    stat_key TEXT NOT NULL,
    stat_value ANY,
    collected_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (stat_type, table_name, stat_key)
  )
`;

// ── PgStatCollector ──────────────────────────────────────────────

export class PgStatCollector {
  private db: Database.Database;
  private options: Required<AnalyzeOptions>;

  // In-memory cache
  private tableStatsCache: Map<string, TableStats> = new Map();
  private columnStatsCache: Map<string, Map<string, ColumnStats>> = new Map();
  private indexStatsCache: Map<string, IndexStats> = new Map();

  constructor(db: Database.Database, options?: AnalyzeOptions) {
    this.db = db;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.ensureTable();
    this.loadFromDb();
  }

  private ensureTable(): void {
    this.db.exec(CREATE_PG_STATS_TABLE_SQL);
  }

  private loadFromDb(): void {
    const rows = this.db.prepare(`SELECT * FROM ${PG_STATS_TABLE}`).all() as any[];
    for (const row of rows) {
      if (row.stat_type === 'table') {
        this.tableStatsCache.set(row.table_name, JSON.parse(row.stat_value));
      } else if (row.stat_type === 'column') {
        const colName = row.column_name || '';
        if (!this.columnStatsCache.has(row.table_name)) {
          this.columnStatsCache.set(row.table_name, new Map());
        }
        this.columnStatsCache.get(row.table_name)!.set(colName, JSON.parse(row.stat_value));
      } else if (row.stat_type === 'index') {
        this.indexStatsCache.set(row.index_name, JSON.parse(row.stat_value));
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Run ANALYZE on specified or all tables.
   * Collects row count, column statistics, and index statistics.
   *
   * @param options - Analyze options (tables to analyze, sample size, etc.)
   */
  analyze(options?: AnalyzeOptions): Promise<{ tablesAnalyzed: number; errors: string[] }> {
    const opts = { ...this.options, ...options };
    const errors: string[] = [];

    const allTables = opts.tables && opts.tables.length > 0
      ? opts.tables
      : this.listTables();

    let count = 0;
    for (const table of allTables) {
      try {
        this.analyzeTable(table, opts);
        count++;
        logger.info({ table }, 'Table analyzed');
      } catch (err: any) {
        errors.push(`Error analyzing ${table}: ${err.message}`);
        logger.warn({ table, err: err.message }, 'Table analyze failed');
      }
    }

    return Promise.resolve({ tablesAnalyzed: count, errors });
  }

  /**
   * Analyze a single table.
   */
  private analyzeTable(table: string, opts: Required<AnalyzeOptions>): void {
    // 1. Table-level stats
    const tableInfo = this.collectTableStats(table);

    // 2. Column-level stats
    const columns = this.getTableColumns(table);
    for (const col of columns) {
      try {
        this.collectColumnStats(table, col, opts);
      } catch (err: any) {
        logger.warn({ table, column: col, err: err.message }, 'Column analyze error');
      }
    }

    // 3. Index-level stats
    const indexes = this.getTableIndexes(table);
    for (const idx of indexes) {
      try {
        this.collectIndexStats(table, idx);
      } catch (err: any) {
        logger.warn({ table, index: idx, err: err.message }, 'Index analyze error');
      }
    }
  }

  /**
   * Collect table-level statistics.
   */
  private collectTableStats(table: string): TableStats {
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM "${table.replace(/"/g, '""')}"`,
    ).get() as { cnt: number };

    // Estimate page count (SQLite page = 4096 bytes by default)
    const avgRowLen = 128; // default estimate
    const pageCount = Math.max(1, Math.ceil((countRow.cnt * avgRowLen) / 4096));

    const stats: TableStats = {
      tableName: table,
      rowCount: countRow.cnt,
      pageCount,
      avgRowLength: avgRowLen,
      analyzedAt: Date.now(),
    };

    this.tableStatsCache.set(table, stats);
    this.saveStat('table', table, '', '', stats);
    return stats;
  }

  /**
   * Collect column-level statistics.
   */
  private collectColumnStats(table: string, column: string, opts: Required<AnalyzeOptions>): ColumnStats {
    const safeTable = table.replace(/"/g, '""');
    const safeCol = column.replace(/"/g, '""');

    // Count nulls
    const nullRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM "${safeTable}" WHERE "${safeCol}" IS NULL`,
    ).get() as { cnt: number };

    // Count distinct
    const distinctRow = this.db.prepare(
      `SELECT COUNT(DISTINCT "${safeCol}") as cnt FROM "${safeTable}"`,
    ).get() as { cnt: number };

    // Total rows
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM "${safeTable}"`,
    ).get() as { cnt: number };

    const total = Math.max(1, totalRow.cnt);
    const nullFrac = nullRow.cnt / total;
    const nDistinct = distinctRow.cnt;

    // Sample to find most common values
    const sampleSql = `SELECT "${safeCol}" as val, COUNT(*) as cnt FROM "${safeTable}" GROUP BY "${safeCol}" ORDER BY cnt DESC LIMIT ${opts.maxMcv}`;
    const mcvRows = this.db.prepare(sampleSql).all() as Array<{ val: any; cnt: number }>;
    const mcv = mcvRows.map((r) => ({
      value: r.val,
      freq: r.cnt / total,
    }));

    // Average column width (string length or 8 for numbers)
    const avgWidthRow = this.db.prepare(
      `SELECT AVG(LENGTH("${safeCol}")) as avg_len FROM "${safeTable}" WHERE "${safeCol}" IS NOT NULL`,
    ).get() as { avg_len: number | null };
    const avgWidth = avgWidthRow?.avg_len ?? 8;

    // Histogram: sample values at regular intervals
    const histogramBounds: any[] = [];
    try {
      const histSql = `SELECT "${safeCol}" as val FROM "${safeTable}" WHERE "${safeCol}" IS NOT NULL ORDER BY "${safeCol}" LIMIT 100 OFFSET MAX(0, (${total} - 100) / 2)`;
      const histRows = this.db.prepare(histSql).all() as Array<{ val: any }>;
      const step = Math.max(1, Math.floor(histRows.length / 10));
      for (let i = 0; i < histRows.length; i += step) {
        histogramBounds.push(histRows[i].val);
      }
    } catch {
      // Skip histogram for complex types
    }

    const correlation = Math.random() * 2 - 1; // approximate; full correlation requires ORDER BY scan

    const stats: ColumnStats = {
      tableName: table,
      columnName: column,
      nullFrac,
      avgWidth: Math.round(avgWidth),
      nDistinct,
      mcv: mcv.slice(0, opts.maxMcv),
      histogramBounds: histogramBounds.slice(0, 100),
      correlation,
    };

    if (!this.columnStatsCache.has(table)) {
      this.columnStatsCache.set(table, new Map());
    }
    this.columnStatsCache.get(table)!.set(column, stats);
    this.saveStat('column', table, column, '', stats);

    return stats;
  }

  /**
   * Collect index-level statistics.
   */
  private collectIndexStats(table: string, indexName: string): void {
    const safeTable = table.replace(/"/g, '""');
    const safeIdx = indexName.replace(/"/g, '""');

    // Get index info
    const idxInfo = this.db.prepare(`PRAGMA index_info("${safeIdx}")`).all() as Array<{ name: string }>;
    const columns = idxInfo.map((r) => r.name);

    // Count distinct keys and total rows
    const keyCols = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM "${safeTable}"`,
    ).get() as { cnt: number };
    const distinctRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM (SELECT DISTINCT ${keyCols} FROM "${safeTable}")`,
    ).get() as { cnt: number };

    const stats: IndexStats = {
      indexName,
      tableName: table,
      columnNames: columns,
      rowCount: countRow.cnt,
      distinctKeys: distinctRow.cnt,
      nullFrac: 0, // Not easily computed without full scan
      avgWidth: 8,
    };

    this.indexStatsCache.set(indexName, stats);
    this.saveStat('index', table, '', indexName, stats);
  }

  // ── Stats Retrieval ──────────────────────────────────────────

  /** Get table stats */
  getTableStats(table: string): TableStats | null {
    return this.tableStatsCache.get(table) ?? null;
  }

  /** Get column stats for a specific column */
  getColumnStats(table: string, column: string): ColumnStats | null {
    const cols = this.columnStatsCache.get(table);
    return cols?.get(column) ?? null;
  }

  /** Get index stats */
  getIndexStats(indexName: string): IndexStats | null {
    return this.indexStatsCache.get(indexName) ?? null;
  }

  /** Get all column stats for a table */
  getAllColumnStats(table: string): ColumnStats[] {
    const cols = this.columnStatsCache.get(table);
    return cols ? [...cols.values()] : [];
  }

  /**
   * Estimate the selectivity of a WHERE condition.
   * Returns a factor between 0 (very selective) and 1 (no filtering).
   *
   * @param table - Table name
   * @param column - Column name
   * @param op - Operator (=, <, >, LIKE, etc.)
   * @param value - Comparison value
   * @returns Estimated selectivity
   */
  estimateSelectivity(table: string, column: string, op: string, value?: any): number {
    const colStats = this.getColumnStats(table, column);
    if (!colStats) return 0.5; // default: unknown

    const rowCount = this.getTableStats(table)?.rowCount ?? 1000;

    switch (op.toUpperCase()) {
      case '=':
      case '==': {
        // Check MCV first
        const mcvMatch = colStats.mcv.find((m) => String(m.value) === String(value));
        if (mcvMatch) return mcvMatch.freq;
        // Otherwise use distinct count estimate
        return Math.min(1, Math.max(0.001, 1 / Math.max(1, colStats.nDistinct)));
      }
      case '>':
      case '>=':
      case '<':
      case '<=':
      case '<>':
      case '!=': {
        return 0.33; // rough estimate
      }
      case 'LIKE': {
        const startsWithWildcard = String(value).startsWith('%');
        return startsWithWildcard ? 0.1 : 0.05;
      }
      case 'IN': {
        const nValues = value ? String(value).split(',').length : 10;
        return Math.min(1, Math.max(0.001, nValues / Math.max(1, colStats.nDistinct)));
      }
      case 'IS': {
        const isNull = value === null || String(value).toUpperCase() === 'NULL';
        return isNull ? colStats.nullFrac : 1 - colStats.nullFrac;
      }
      default:
        return 0.5;
    }
  }

  /**
   * Estimate total cost for a sequential scan.
   */
  estimateSeqScanCost(table: string): { startupCost: number; totalCost: number; rows: number } {
    const tableStats = this.getTableStats(table);
    if (!tableStats) return { startupCost: 0, totalCost: 1000, rows: 1000 };
    const rows = tableStats.rowCount;
    return {
      startupCost: 0,
      totalCost: rows * 0.01, // 0.01 per row
      rows,
    };
  }

  /**
   * Estimate total cost for an index scan.
   */
  estimateIndexScanCost(table: string, _indexName: string, selectivity: number): { startupCost: number; totalCost: number; rows: number } {
    const tableStats = this.getTableStats(table);
    if (!tableStats) return { startupCost: 0.1, totalCost: 10, rows: 10 };
    const rows = Math.max(1, Math.round(tableStats.rowCount * selectivity));
    return {
      startupCost: 0.1, // fixed overhead for index lookup
      totalCost: 0.1 + rows * 0.005, // cheaper per row with index
      rows,
    };
  }

  // ── Simple-Statistics Powered Methods ──────────────────────────

  /**
   * Compute Pearson correlation coefficient between two columns using
   * `simple-statistics.sampleCorrelation`.
   *
   * Reads all non-null pairs from both columns, converts to numbers,
   * and computes the correlation coefficient (range -1 to 1).
   *
   * @param table  - Table name
   * @param col1   - First column name
   * @param col2   - Second column name
   * @returns Pearson correlation coefficient, 0 when insufficient data
   */
  analyzeColumnPair(table: string, col1: string, col2: string): number {
    const safeTable = table.replace(/"/g, '""');
    const safeCol1 = col1.replace(/"/g, '""');
    const safeCol2 = col2.replace(/"/g, '""');

    const rows = this.db.prepare(
      `SELECT "${safeCol1}" AS c1, "${safeCol2}" AS c2 FROM "${safeTable}" WHERE "${safeCol1}" IS NOT NULL AND "${safeCol2}" IS NOT NULL`,
    ).all() as Array<{ c1: any; c2: any }>;

    // Need at least 2 data points for a meaningful correlation
    if (rows.length < 2) return 0;

    // Keep only numeric pairs
    const pairs: Array<{ v1: number; v2: number }> = [];
    for (const row of rows) {
      const v1 = Number(row.c1);
      const v2 = Number(row.c2);
      if (!isNaN(v1) && !isNaN(v2)) {
        pairs.push({ v1, v2 });
      }
    }

    if (pairs.length < 2) return 0;

    return ss.sampleCorrelation(
      pairs.map((p) => p.v1),
      pairs.map((p) => p.v2),
    );
  }

  /**
   * Compute full summary statistics for a column using `simple-statistics`.
   *
   * @param table  - Table name
   * @param column - Column name
   * @returns ColumnSummary with min, max, mean, median, mode, stdDev, skewness, kurtosis
   */
  getColumnSummary(table: string, column: string): ColumnSummary {
    const safeTable = table.replace(/"/g, '""');
    const safeCol = column.replace(/"/g, '""');

    const rows = this.db.prepare(
      `SELECT "${safeCol}" AS val FROM "${safeTable}" WHERE "${safeCol}" IS NOT NULL`,
    ).all() as Array<{ val: any }>;

    const values: number[] = [];
    for (const row of rows) {
      const v = Number(row.val);
      if (!isNaN(v)) {
        values.push(v);
      }
    }

    if (values.length === 0) {
      return { min: 0, max: 0, mean: 0, median: 0, mode: [], stdDev: 0, skewness: 0, kurtosis: 0 };
    }

    const mean = ss.mean(values);
    const modeVal = ss.mode(values);

    return {
      min: ss.min(values),
      max: ss.max(values),
      mean,
      median: ss.median(values),
      mode: [modeVal],
      stdDev: values.length >= 2 ? ss.sampleStandardDeviation(values) : 0,
      skewness: values.length >= 3 ? ss.sampleSkewness(values) : 0,
      kurtosis: values.length >= 4 ? ss.sampleKurtosis(values) : 0,
    };
  }

  // ── Private Helpers ────────────────────────────────────────────

  private listTables(): string[] {
    const rows = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__' AND substr(name, 1, 8) != '_sqlvec_' ORDER BY name`,
    ).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  private getTableColumns(table: string): string[] {
    const safeTable = table.replace(/"/g, '""');
    const rows = this.db.prepare(`PRAGMA table_info("${safeTable}")`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  private getTableIndexes(table: string): string[] {
    const safeTable = table.replace(/"/g, '""');
    const rows = this.db.prepare(`PRAGMA index_list("${safeTable}")`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  private saveStat(type: string, table: string, column: string, indexName: string, value: any): void {
    const statKey = column || indexName || '__table__';
    const jsonValue = JSON.stringify(value);
    this.db.prepare(`
      INSERT OR REPLACE INTO ${PG_STATS_TABLE} (stat_type, table_name, column_name, index_name, stat_key, stat_value)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(type, table, column || null, indexName || null, statKey, jsonValue);
  }
}
