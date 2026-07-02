/**
 * RumIndexShim — PostgreSQL RUM index compatibility shim for sqlvec-db.
 *
 * PostgreSQL RUM (an extension to GIN) supports ordering by tsvector similarity
 * and phrase search priority. Since sqlvec-db delegates to SQLite, we
 * simulate RUM-like behavior using:
 *   - FTS5 virtual tables for full-text search (text content indexing)
 *   - An auxiliary metadata table storing ordering/sorting information
 *
 * The strategy is:
 *   1. Create a FTS5 table for the indexed text columns (full-text search).
 *   2. Create a companion `__rum_meta_{indexName}` table storing rowid →
 *      ordering column value mapping.
 *   3. Query the FTS5 table with ordering derived from the metadata table.
 *
 * @module query/RumIndexShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('rum-index-shim');

// ── Types ──────────────────────────────────────────────────────

export interface RumIndexConfig {
  /** The original user table name */
  tableName: string;
  /** Unique index name (used for auxiliary table naming) */
  indexName: string;
  /** Columns to index for full-text search */
  indexedColumns: string[];
  /** Optional column for ordering/sorting support (RUM stores position/rank info) */
  orderByColumn?: string;
}

// ── Constants ──────────────────────────────────────────────────

/** Prefix for the FTS5 virtual table */
const FTS5_TABLE_PREFIX = '__rum_fts_';

/** Prefix for the metadata (ordering) table */
const META_TABLE_PREFIX = '__rum_meta_';

/** Prefix for the content sync trigger */
const TRIGGER_PREFIX = '__rum_sync_';

/** Regex to detect CREATE INDEX ... USING rum in SQL */
const RUM_DDL_RE = /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?(\S+)\s+ON\s+(\S+)\s+USING\s+rum\s*\(/i;

// ── Helpers ────────────────────────────────────────────────────

/** Get the FTS5 table name for a given index name */
function fts5TableName(indexName: string): string {
  return `${FTS5_TABLE_PREFIX}${indexName}`;
}

/** Get the metadata table name for a given index name */
function metaTableName(indexName: string): string {
  return `${META_TABLE_PREFIX}${indexName}`;
}

/** Sanitise a table/index name for use in SQL identifiers */
function sanitise(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Check if a column exists in a table */
function columnExists(db: any, tableName: string, columnName: string): boolean {
  try {
    const cols = db.pragma(`table_info('${sanitise(tableName)}')`);
    return cols.some((c: any) => c.name === columnName);
  } catch {
    return false;
  }
}

// ── Core Functions ─────────────────────────────────────────────

/**
 * Create a RUM shim:
 *   - FTS5 virtual table for full-text search over indexed columns.
 *   - Metadata table storing ordering values (if orderByColumn is set).
 *   - Triggers to keep data in sync with the original table.
 *
 * @param db - better-sqlite3 database instance
 * @param config - RUM index configuration
 */
export function createRumShimTable(
  db: any,
  config: RumIndexConfig,
): void {
  const idxName = sanitise(config.indexName);
  const tblName = sanitise(config.tableName);
  const ftsName = fts5TableName(idxName);
  const metaName = metaTableName(idxName);

  // Verify the original table exists
  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(tblName);

  if (!tableExists) {
    throw new Error(`Table '${config.tableName}' does not exist`);
  }

  // Build column list for FTS5 content table
  // Use the indexed columns plus a reference to the original rowid
  const quotedIndexedCols = config.indexedColumns
    .filter(col => columnExists(db, tblName, col))
    .map(col => `"${col}"`);

  if (quotedIndexedCols.length === 0) {
    throw new Error(`No valid indexed columns found in table '${config.tableName}'`);
  }

  const ftsCols = quotedIndexedCols.join(', ');
  // Unquoted column names for use in trigger VALUES expressions
  const unquotedCols = config.indexedColumns
    .filter(col => columnExists(db, tblName, col));

  // Drop existing FTS5 table if it exists
  db.exec(`DROP TABLE IF EXISTS "${ftsName}"`);

  // Create FTS5 virtual table with content sync to original table
  // FTS5 with content=tableName keeps data in the original table, not duplicated
  db.exec(`
    CREATE VIRTUAL TABLE "${ftsName}" USING fts5(
      ${ftsCols},
      content='${tblName}',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);

  // Populate FTS5 index from existing data
  db.exec(`
    INSERT INTO "${ftsName}"("${ftsName}")
    SELECT 'rebuild'
  `);

  // Create metadata table for ordering
  db.exec(`DROP TABLE IF EXISTS "${metaName}"`);

  const triggerName = `${TRIGGER_PREFIX}${idxName}`;

  if (config.orderByColumn) {
    const orderCol = config.orderByColumn;
    if (!columnExists(db, tblName, orderCol)) {
      logger.warn({ tableName: config.tableName, orderByColumn: orderCol },
        'orderByColumn does not exist in table, skipping metadata table');
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS "${metaName}"(
          rowid INTEGER PRIMARY KEY,
          order_value REAL
        )
      `);

      // Populate metadata from existing data
      db.exec(`
        INSERT OR IGNORE INTO "${metaName}"(rowid, order_value)
        SELECT rowid, CAST("${orderCol}" AS REAL) FROM "${tblName}"
        WHERE "${orderCol}" IS NOT NULL
      `);

      // Create triggers to keep metadata table in sync
      // Insert trigger
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS "${triggerName}_insert"
        AFTER INSERT ON "${tblName}"
        BEGIN
          INSERT OR IGNORE INTO "${metaName}"(rowid, order_value)
          VALUES (NEW.rowid, CAST(NEW."${orderCol}" AS REAL));
        END
      `);

      // Update trigger
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS "${triggerName}_update"
        AFTER UPDATE ON "${tblName}"
        BEGIN
          UPDATE "${metaName}"
          SET order_value = CAST(NEW."${orderCol}" AS REAL)
          WHERE rowid = NEW.rowid;
        END
      `);

      // Delete trigger
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS "${triggerName}_delete"
        AFTER DELETE ON "${tblName}"
        BEGIN
          DELETE FROM "${metaName}" WHERE rowid = OLD.rowid;
        END
      `);
    }
  }

  // Create triggers to keep FTS5 index in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS "${triggerName}_fts_insert"
    AFTER INSERT ON "${tblName}"
    BEGIN
      INSERT INTO "${ftsName}"(rowid, ${ftsCols})
      VALUES (NEW.rowid, ${unquotedCols.map(c => 'NEW."' + c + '"').join(', ')});
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS "${triggerName}_fts_delete"
    AFTER DELETE ON "${tblName}"
    BEGIN
      INSERT INTO "${ftsName}"("${ftsName}", rowid)
      VALUES ('delete', OLD.rowid);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS "${triggerName}_fts_update"
    AFTER UPDATE ON "${tblName}"
    BEGIN
      INSERT INTO "${ftsName}"("${ftsName}", rowid)
      VALUES ('delete', OLD.rowid);
      INSERT INTO "${ftsName}"(rowid, ${ftsCols})
      VALUES (NEW.rowid, ${unquotedCols.map(c => 'NEW."' + c + '"').join(', ')});
    END
  `);

  logger.info({
    indexName: config.indexName,
    tableName: config.tableName,
    indexedColumns: config.indexedColumns,
    orderByColumn: config.orderByColumn,
  }, 'RUM shim table created');
}

/**
 * Perform a RUM-like search with full-text search and optional ordering.
 *
 * This queries the FTS5 index for the search terms and joins with the
 * metadata table (if available) to support ORDER BY rank/phrase priority.
 *
 * The FTS5 bm25 ranking is used by default, with additional sorting from
 * the orderByColumn if configured.
 *
 * @param db - better-sqlite3 database instance
 * @param indexName - RUM index name
 * @param searchQuery - Full-text search query (FTS5 syntax)
 * @returns Array of row objects from the original table, ordered by relevance
 */
export function queryRumShim(
  db: any,
  indexName: string,
  searchQuery: string,
): any[] {
  const idxName = sanitise(indexName);
  const ftsName = fts5TableName(idxName);
  const metaName = metaTableName(idxName);

  // Validate the FTS5 table exists
  const ftsExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(ftsName);

  if (!ftsExists) {
    throw new Error(`RUM shim '${indexName}' not found (FTS5 table missing)`);
  }

  // Get the original table name from the stored config
  const configs = listRumShims(db);
  const config = configs.find(c => c.indexName === indexName);
  if (!config) {
    throw new Error(`RUM shim config for '${indexName}' not found in metadata`);
  }

  const tblName = sanitise(config.tableName);

  // Check if metadata table exists for ordering
  const metaExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(metaName);

  let query: string;
  let params: any[];

  if (metaExists) {
    // Search with ordering from metadata table
    query = `
      SELECT t.*, "${ftsName}".rank AS _rank,
             COALESCE(m.order_value, 0) AS _order_value
      FROM "${ftsName}"
      JOIN "${tblName}" AS t ON t.rowid = "${ftsName}".rowid
      LEFT JOIN "${metaName}" AS m ON m.rowid = "${ftsName}".rowid
      WHERE "${ftsName}" MATCH ?
      ORDER BY
        CASE WHEN m.order_value IS NOT NULL THEN m.order_value ELSE 0 END DESC,
        "${ftsName}".rank ASC
    `;
    params = [searchQuery];
  } else {
    // Search with FTS5 ranking only
    query = `
      SELECT t.*, "${ftsName}".rank AS _rank
      FROM "${ftsName}"
      JOIN "${tblName}" AS t ON t.rowid = "${ftsName}".rowid
      WHERE "${ftsName}" MATCH ?
      ORDER BY "${ftsName}".rank ASC
    `;
    params = [searchQuery];
  }

  try {
    const results = db.prepare(query).all(...params);
    logger.debug({
      indexName,
      searchQuery,
      resultCount: results.length,
    }, 'RUM shim query executed');
    return results;
  } catch (err) {
    logger.error({
      err,
      indexName,
      searchQuery,
    }, 'RUM shim query failed');
    throw err;
  }
}

/**
 * Drop a RUM shim (FTS5 + metadata table + triggers).
 *
 * @param db - better-sqlite3 database instance
 * @param indexName - RUM index name to drop
 */
export function dropRumShim(
  db: any,
  indexName: string,
): void {
  const idxName = sanitise(indexName);
  const ftsName = fts5TableName(idxName);
  const metaName = metaTableName(idxName);
  const triggerName = `${TRIGGER_PREFIX}${idxName}`;

  // Drop FTS5 table
  db.exec(`DROP TABLE IF EXISTS "${ftsName}"`);

  // Drop metadata table
  db.exec(`DROP TABLE IF EXISTS "${metaName}"`);

  // Drop triggers (best effort — drop if they exist)
  const triggers = [
    `${triggerName}_insert`,
    `${triggerName}_update`,
    `${triggerName}_delete`,
    `${triggerName}_fts_insert`,
    `${triggerName}_fts_delete`,
    `${triggerName}_fts_update`,
  ];

  for (const tr of triggers) {
    db.exec(`DROP TRIGGER IF EXISTS "${tr}"`);
  }

  logger.info({ indexName }, 'RUM shim dropped');
}

/**
 * List all RUM shims by inspecting the database schema for FTS5 tables
 * matching the \"__rum_fts_\" prefix.
 *
 * @param db - better-sqlite3 database instance
 * @returns Array of RumIndexConfig objects
 */
export function listRumShims(
  db: any,
): RumIndexConfig[] {
  // Find all FTS5 virtual tables with our prefix (filtering out shadow/internal tables)
  const ftsTables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
  ).all(`${FTS5_TABLE_PREFIX}%`);

  const configs: RumIndexConfig[] = [];

  for (const row of ftsTables as { name: string }[]) {
    const indexName = row.name.replace(FTS5_TABLE_PREFIX, '');

    // Get FTS5 table info to extract indexed column names
    try {
      const ftsInfo = db.pragma(`table_info('${row.name}')`);
      const indexedColumns = (ftsInfo as any[])
        .filter((c: any) => c.name !== 'rank') // skip rank (auto-added by FTS5)
        .map((c: any) => c.name);

      // Try to infer original table name from triggers
      let tableName = '';
      const triggers = db.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name=?`,
      ).all(`${TRIGGER_PREFIX}${indexName}_fts_insert`);

      if (triggers.length > 0) {
        const triggerSql: string = (triggers as any[])[0].sql || '';
        const match = triggerSql.match(/AFTER INSERT ON\s+"?(\w+)"?/i);
        if (match) tableName = match[1];
      }

      // Check for metadata table
      const metaExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      ).get(metaTableName(indexName));

      let orderByColumn: string | undefined;
      if (metaExists) {
        const metaInfo = db.pragma(`table_info('${metaTableName(indexName)}')`);
        const orderCol = (metaInfo as any[]).find((c: any) => c.name === 'order_value');
        if (orderCol) orderByColumn = 'order_value'; // we store it generically
      }

      configs.push({
        tableName,
        indexName,
        indexedColumns,
        orderByColumn,
      });
    } catch {
      // Skip malformed tables
      logger.warn({ tableName: row.name }, 'Could not parse RUM shim table info');
    }
  }

  return configs;
}

/**
 * Detect whether a SQL string contains a CREATE INDEX ... USING rum DDL statement.
 *
 * @param sql - SQL to inspect
 * @returns true if the SQL creates a RUM index
 */
export function detectRumDDL(sql: string): boolean {
  RUM_DDL_RE.lastIndex = 0;
  return RUM_DDL_RE.test(sql.trim());
}

/**
 * Rewrite a CREATE INDEX ... USING rum DDL statement into equivalent
 * FTS5 + metadata table creation calls. Returns the SQL for creating
 * the FTS5 table and metadata, or null if the input is not a RUM index DDL.
 *
 * The rewriting parses the RUM index definition and generates:
 *   1. A comment in SQL to mark the index
 *   2. The column configuration extracted from the DDL
 *
 * @param sql - The original CREATE INDEX ... USING rum SQL
 * @returns A SQL string that creates the FTS5 table, or null if not a RUM DDL
 */
export function rewriteRumCreateIndex(sql: string): string | null {
  RUM_DDL_RE.lastIndex = 0;
  const match = RUM_DDL_RE.exec(sql.trim());

  if (!match) return null;

  const indexName = (match[3] || '').replace(/["']/g, '');
  const tableName = (match[4] || '').replace(/["']/g, '');

  // Extract the column list from the DDL
  const parenStart = sql.indexOf('(');
  const parenEnd = sql.lastIndexOf(')');
  if (parenStart < 0 || parenEnd < 0) return null;

  const colList = sql.substring(parenStart + 1, parenEnd);

  // Parse columns: handle both simple column names and column WITH OPTIONS
  const columns: string[] = [];
  for (const part of colList.split(',')) {
    const trimmed = part.trim();
    // Extract just the column name (before any operator class or options)
    const colMatch = trimmed.match(/^"?(\w+)"?/);
    if (colMatch) {
      columns.push(colMatch[1]);
    }
  }

  if (columns.length === 0) return null;

  // Detect ORDER BY column specification (RUM-specific)
  // e.g., col1, col2 ORDER BY col3
  const orderByMatch = colList.match(/ORDER\s+BY\s+(\w+)/i);
  const orderByColumn = orderByMatch ? orderByMatch[1] : undefined;

  // Generate rewritten SQL as a comment + configuration marker
  const ftsCols = columns.join(', ');
  const configJson = JSON.stringify({
    __rum_config: true,
    indexName,
    tableName,
    columns,
    orderByColumn: orderByColumn || null,
  });

  // Return the rewritten form:
  // 1. A comment that can be parsed back
  // 2. If columns were specified, generate a CREATE VIRTUAL TABLE statement
  const orderByClause = orderByColumn
    ? ` RUM_ORDER_BY(${orderByColumn})`
    : '';

  return [
    `-- RUM INDEX: ${indexName} ON ${tableName} (${ftsCols})${orderByClause}`,
    `-- RUM_CONFIG: ${configJson}`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS "${FTS5_TABLE_PREFIX}${indexName}" USING fts5(${ftsCols}, content='${tableName}', content_rowid='rowid');`,
  ].join('\n');
}
