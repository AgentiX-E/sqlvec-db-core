/**
 * FDWExecutor — Foreign Data Wrapper executor for SQLite.
 *
 * Provides the ability to query external data sources as if they were local
 * tables. Supports:
 *   - CSV files (via CsvImporter)
 *   - SQLite databases (another .db file on the same machine)
 *   - DuckDB files (via DuckDB Node bindings)
 *
 * ## Usage
 *
 * ```
 * // Register a foreign table backed by a CSV file
 * fdw.registerForeignServer('csv_orders', { type: 'csv', path: '/data/orders.csv' });
 * fdw.createForeignTable('orders', 'csv_orders');
 *
 * // Query the foreign table
 * const result = await fdw.executeQuery('SELECT * FROM orders WHERE total > 100');
 * ```
 *
 * @module query/FDWExecutor
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { PinoLogger } from '../monitoring/PinoLogger';
import { SqlVecError, SqlVecErrorCode } from '../core/types';

// ── Logger ───────────────────────────────────────────────────────


// ── Types ────────────────────────────────────────────────────────

export type ForeignDataSourceType = 'csv' | 'sqlite' | 'duckdb';

export interface ForeignServerConfig {
  /** Unique server name. */
  name: string;
  /** Data source type. */
  type: ForeignDataSourceType;
  /** File path to the external data. */
  path: string;
  /** Optional: table name within the external database (for sqlite/duckdb). */
  remoteTable?: string;
  /** Optional: options for CSV parsing (delimiter, header, etc.). */
  csvOptions?: {
    delimiter?: string;
    header?: boolean;
    skipLines?: number;
  };
}

export interface ForeignTable {
  /** Name of the foreign table as exposed to SQL queries. */
  localName: string;
  /** Foreign server config this table belongs to. */
  serverConfig: ForeignServerConfig;
  /** Optional: table name within the external data source. */
  remoteTable?: string;
  /** Schema (column names and types) if known. */
  columns?: Array<{ name: string; type: string }>;
}

export interface ForeignQueryResult {
  rows: Record<string, any>[];
  columns: string[];
  rowCount: number;
}

// ── FDWExecutor ──────────────────────────────────────────────────

export class FDWExecutor {
  private readonly logger = PinoLogger.forComponent('fdwexecutor');

  private servers: Map<string, ForeignServerConfig> = new Map();
  private tables: Map<string, ForeignTable> = new Map();
  /** Cache for external database connections. */
  private dbConnections: Map<string, Database.Database> = new Map();

  constructor() {
    this.logger.info('FDWExecutor initialized');
  }

  // ── Server management ──────────────────────────────────────────

  /**
   * Register a foreign server configuration.
   *
   * @param serverConfig - The server configuration to register.
   */
  registerForeignServer(serverConfig: ForeignServerConfig): void {
    // Validate: file must exist.
    if (!fs.existsSync(serverConfig.path)) {
      throw new SqlVecError(
        `Foreign server path does not exist: ${serverConfig.path}`,
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }

    this.servers.set(serverConfig.name, serverConfig);
    this.logger.info({ serverConfig }, 'Foreign server registered');
  }

  /**
   * Unregister a foreign server and drop all associated tables.
   *
   * @param serverName - Name of the server to unregister.
   */
  unregisterForeignServer(serverName: string): void {
    this.servers.delete(serverName);

    // Drop any cached connections.
    const connKey = `server:${serverName}`;
    const conn = this.dbConnections.get(connKey);
    if (conn) {
      conn.close();
      this.dbConnections.delete(connKey);
    }

    // Drop all tables referencing this server.
    for (const [localName, table] of this.tables) {
      if (table.serverConfig.name === serverName) {
        this.tables.delete(localName);
      }
    }

    this.logger.info({ serverName }, 'Foreign server unregistered');
  }

  /**
   * Get a registered server by name.
   *
   * @param serverName - Server name.
   * @returns The server config, or `undefined`.
   */
  getServer(serverName: string): ForeignServerConfig | undefined {
    return this.servers.get(serverName);
  }

  /**
   * Get all registered servers.
   */
  getAllServers(): ForeignServerConfig[] {
    return Array.from(this.servers.values());
  }

  // ── Table management ──────────────────────────────────────────

  /**
   * Create a foreign table mapping a local name to a foreign server.
   *
   * Optionally infers the schema from the source.
   *
   * @param localName  - Name to expose to SQL queries.
   * @param serverName - Foreign server name (must be registered).
   * @param remoteTable - Optional: table name in the remote source.
   */
  createForeignTable(localName: string, serverName: string, remoteTable?: string): void {
    const serverConfig = this.servers.get(serverName);
    if (!serverConfig) {
      throw new SqlVecError(
        `Foreign server "${serverName}" not found`,
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }

    const table: ForeignTable = {
      localName,
      serverConfig,
      remoteTable: remoteTable || path.basename(serverConfig.path, path.extname(serverConfig.path)),
    };

    this.tables.set(localName, table);

    this.logger.info({ localName, serverName, remoteTable: table.remoteTable }, 'Foreign table created');
  }

  /**
   * Drop a foreign table.
   *
   * @param localName - Local table name to drop.
   */
  dropForeignTable(localName: string): void {
    this.tables.delete(localName);
    this.logger.info({ localName }, 'Foreign table dropped');
  }

  /**
   * Check whether a table name is a registered foreign table.
   *
   * @param tableName - Table name to check.
   * @returns `true` if it is a foreign table.
   */
  isForeignTable(tableName: string): boolean {
    return this.tables.has(tableName);
  }

  /**
   * Get the foreign table definition for a local name.
   *
   * @param tableName - Local table name.
   * @returns Foreign table definition, or `undefined`.
   */
  getForeignTable(tableName: string): ForeignTable | undefined {
    return this.tables.get(tableName);
  }

  /**
   * Get all registered foreign tables.
   */
  getAllForeignTables(): ForeignTable[] {
    return Array.from(this.tables.values());
  }

  // ── Query execution ───────────────────────────────────────────

  /**
   * Execute a query against a foreign table.
   *
   * Detects the table from the SQL and routes to the appropriate
   * backend (CSV, SQLite, or DuckDB).
   *
   * @param sql - The SQL query to execute (e.g. `SELECT * FROM orders WHERE ...`).
   * @returns Query results with rows and columns.
   */
  async executeQuery(sql: string): Promise<ForeignQueryResult> {
    const tableName = this.extractTableName(sql);
    if (!tableName) {
      throw new SqlVecError(
        `Could not extract table name from: ${sql.substring(0, 80)}`,
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }

    const table = this.tables.get(tableName);
    if (!table) {
      throw new SqlVecError(
        `Foreign table not found: ${tableName}`,
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }

    switch (table.serverConfig.type) {
      case 'csv':
        return this.queryCsv(table, sql);
      case 'sqlite':
        return this.querySqlite(table, sql);
      case 'duckdb':
        return this.queryDuckdb(table, sql);
      default:
        throw new SqlVecError(
          `Unsupported foreign data source type: ${table.serverConfig.type}`,
          SqlVecErrorCode.SHARD_UNAVAILABLE,
        );
    }
  }

  /**
   * Close all open connections and reset state.
   */
  close(): void {
    for (const [key, conn] of this.dbConnections) {
      conn.close();
    }
    this.dbConnections.clear();
    this.servers.clear();
    this.tables.clear();
    this.logger.info('FDWExecutor closed');
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.close();
  }

  // ── Backend-specific query methods ────────────────────────────

  /**
   * Query a CSV file by loading it into a temporary in-memory SQLite table.
   */
  private async queryCsv(table: ForeignTable, _sql: string): Promise<ForeignQueryResult> {
    const cfg = table.serverConfig;
    const csvOptions = cfg.csvOptions || {};

    // Use CsvImporter-style parsing.
    const lines = fs.readFileSync(cfg.path, 'utf-8').split('\n');
    const skipLines = csvOptions.skipLines || 0;
    const headerLine = lines[skipLines];
    const hasHeader = csvOptions.header !== false;

    const columns = hasHeader
      ? headerLine.split(csvOptions.delimiter || ',').map((c) => c.trim().replace(/"/g, ''))
      : Array.from({ length: lines[0].split(csvOptions.delimiter || ',').length }, (_, i) => `col${i + 1}`);

    const dataStart = skipLines + (hasHeader ? 1 : 0);
    const rows: Record<string, any>[] = [];

    for (let i = dataStart; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = this.parseCsvLine(line, csvOptions.delimiter || ',');
      const row: Record<string, any> = {};
      columns.forEach((col, idx) => {
        row[col] = idx < (parts as string[]).length ? (parts as string[])[idx] : null;
      });
      rows.push(row);
    }

    // Apply basic WHERE filtering (simplified).
    const filtered = this.applyWhereClause(rows, _sql);

    return {
      rows: filtered,
      columns,
      rowCount: filtered.length,
    };
  }

  /**
   * Query another SQLite database file.
   */
  private querySqlite(table: ForeignTable, sql: string): ForeignQueryResult {
    const cfg = table.serverConfig;
    let conn = this.dbConnections.get(cfg.path);

    if (!conn) {
      conn = new Database(cfg.path, { readonly: true });
      this.dbConnections.set(cfg.path, conn);
      this.logger.debug({ path: cfg.path }, 'Opened SQLite connection for FDW');
    }

    // Rewrite the SQL — replace the local table name with the remote table name.
    const remoteTable = table.remoteTable || cfg.remoteTable || '';
    const rewrittenSql = sql.replace(
      new RegExp(`\\b${escapeRegex(table.localName)}\\b`, 'i'),
      remoteTable,
    );

    const stmt = conn.prepare(rewrittenSql);
    const rows = stmt.all();
    const columns = stmt.columns().map((c) => c.name);

    return {
      rows: rows as Record<string, any>[],
      columns,
      rowCount: rows.length,
    };
  }

  /**
   * Query a DuckDB database file.
   */
  private async queryDuckdb(table: ForeignTable, sql: string): Promise<ForeignQueryResult> {
    const cfg = table.serverConfig;
    const remoteTable = table.remoteTable || cfg.remoteTable || '';

    // Dynamic import — DuckDB may not always be available.
    let duckdb: any;
    try {
      duckdb = require('duckdb');
    } catch {
      throw new SqlVecError(
        'DuckDB module is not available — cannot query DuckDB foreign data sources',
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }

    return new Promise((resolve, reject) => {
      const db = new duckdb.Database(cfg.path);
      const rewrittenSql = sql.replace(
        new RegExp(`\\b${escapeRegex(table.localName)}\\b`, 'i'),
        remoteTable,
      );

      db.all(rewrittenSql, (err: any, rows: any[]) => {
        db.close();
        if (err) {
          reject(
            new SqlVecError(`DuckDB query failed: ${err.message}`, SqlVecErrorCode.SHARD_UNAVAILABLE),
          );
          return;
        }

        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        resolve({
          rows,
          columns,
          rowCount: rows.length,
        });
      });
    });
  }

  // ── Private helpers ───────────────────────────────────────────

  /**
   * Extract a table name from a simple SELECT statement.
   */
  private extractTableName(sql: string): string | null {
    const match = sql.match(/\bFROM\s+([`"\w.]+)/i);
    if (!match) return null;
    return match[1].replace(/[`"']/g, '');
  }

  /**
   * Parse a CSV line respecting quoted fields.
   */
  private parseCsvLine(line: string, delimiter: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    parts.push(current.trim());
    return parts;
  }

  /**
   * Apply a simplified WHERE clause filter on in-memory rows.
   *
   * Supports: `WHERE <col> <op> <value>` with =, <, >, <=, >=, LIKE.
   */
  private applyWhereClause(rows: Record<string, any>[], sql: string): Record<string, any>[] {
    const whereMatch = sql.match(/\bWHERE\s+(.+?)(?:\s+(?:ORDER|LIMIT|GROUP)|$)/i);
    if (!whereMatch) return rows;

    const conditions = whereMatch[1].split(/\s+AND\s+/i);
    return rows.filter((row) => {
      return conditions.every((cond) => this.evaluateCondition(row, cond));
    });
  }

  /**
   * Evaluate a single WHERE condition against a row.
   */
  private evaluateCondition(row: Record<string, any>, condition: string): boolean {
    const match = condition.match(/^([`"\w.]+)\s*(=|!=|<|>|<=|>=|LIKE|NOT\s+LIKE)\s*(.+)$/i);
    if (!match) return true;

    const [, col, op, rawValue] = match;
    const colName = col.replace(/[`"']/g, '');
    const colValue = row[colName];
    const val = rawValue.trim().replace(/^['"]|['"]$/g, '');

    switch (op.toUpperCase()) {
      case '=':
        return String(colValue) === val;
      case '!=':
        return String(colValue) !== val;
      case '<':
        return Number(colValue) < Number(val);
      case '>':
        return Number(colValue) > Number(val);
      case '<=':
        return Number(colValue) <= Number(val);
      case '>=':
        return Number(colValue) >= Number(val);
      case 'LIKE':
        return this.likeMatch(String(colValue), val);
      case 'NOT LIKE':
        return !this.likeMatch(String(colValue), val);
      default:
        return true;
    }
  }

  /**
   * Simple LIKE pattern matching (% and _ wildcards).
   */
  private likeMatch(value: string, pattern: string): boolean {
    const regexStr = '^' + pattern.replace(/%/g, '.*').replace(/_/g, '.') + '$';
    return new RegExp(regexStr, 'i').test(value);
  }

  // ── G28: FDW Connector public API ─────────────────────────────

  /**
   * Execute a query against a CSV foreign table.
   * Public wrapper around queryCSV.
   *
   * @param sql          - SQL query with conditions
   * @param foreignTable - Foreign table definition with CSV options
   * @returns Array of result rows
   */
  executeCSV(sql: string, foreignTable: ForeignTable): Promise<ForeignQueryResult> {
    return this.queryCsv(foreignTable, sql);
  }

  /**
   * Execute a query against a SQLite foreign database.
   * Public wrapper around querySqlite.
   *
   * @param sql          - SQL query
   * @param foreignTable - Foreign table definition with connection options
   * @returns Array of result rows
   */
  executeSQLite(sql: string, foreignTable: ForeignTable): ForeignQueryResult {
    return this.querySqlite(foreignTable, sql);
  }

  /**
   * Execute a query against a DuckDB foreign database.
   * Public wrapper around queryDuckDB.
   *
   * @param sql          - SQL query
   * @param foreignTable - Foreign table definition with connection options
   * @returns Array of result rows
   */
  executeDuckDB(sql: string, foreignTable: ForeignTable): Promise<ForeignQueryResult> {
    return this.queryDuckdb(foreignTable, sql);
  }
}

// ── Utility ──────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
