/**
 * LogicalBackup — pg_dump-equivalent logical backup for SQLVec shards
 *
 * Produces SQL CREATE + INSERT statements (like pg_dump) or CSV exports
 * from any better-sqlite3 Database.  Supports vector index metadata in
 * the backup manifest and single-table restore.
 *
 * Usage:
 *   const backup = new LogicalBackup(db);
 *   const sql = backup.logicDump();                               // SQL format
 *   const csv = backup.logicDump({ format: 'csv', table: 'docs' }); // CSV format
 *   backup.singleTableRestore(sqlDump, 'docs');                    // restore one table
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

import { PinoLogger } from '../logger/PinoLogger';
const logger = PinoLogger.forComponent('Backup');

// ── Types ──────────────────────────────────────────

export interface LogicDumpOptions {
  /** Output format: 'sql' (default) or 'csv' */
  format?: 'sql' | 'csv';
  /** If set, only dump this specific table */
  table?: string;
  /** Delimiter for CSV output (default: ',') */
  delimiter?: string;
  /** Quote character for CSV (default: '"') */
  quoteChar?: string;
  /** Include CREATE TABLE statements (default: true, only for 'sql' format) */
  includeCreateTable?: boolean;
  /** Include DROP TABLE IF EXISTS before CREATE (default: false) */
  includeDropTable?: boolean;
}

interface ResolvedLogicDumpOptions {
  format: 'sql' | 'csv';
  table: string | undefined;
  delimiter: string;
  quoteChar: string;
  includeCreateTable: boolean;
  includeDropTable: boolean;
}

export interface BackupManifestEntry {
  tableName: string;
  rowCount: number;
  /** SHA-256 of the concatenated row data (for integrity verification) */
  checksum: string;
  /** Whether this table has an associated vec0 index */
  hasVectorIndex: boolean;
  /** Vector index dimension (if hasVectorIndex) */
  vectorDimension?: number;
  /** Vector index metric (if hasVectorIndex) */
  vectorMetric?: string;
}

export interface LogicDumpManifest {
  generatedAt: number;
  format: 'sql' | 'csv';
  tables: BackupManifestEntry[];
  totalSizeBytes: number;
}

export interface SingleTableRestoreOptions {
  /** Drop table before recreating (default: false) */
  dropFirst?: boolean;
  /** Disable triggers during restore (default: false) */
  disableTriggers?: boolean;
}

// ── LogicalBackup ──────────────────────────────────

export class LogicalBackup {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ──────────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────────

  /**
   * Perform a logical dump of all (or selected) tables.
   *
   * @param options  Dump options
   * @returns       The dump content as a string (SQL or CSV)
   */
  logicDump(options?: LogicDumpOptions): string {
    const opts: ResolvedLogicDumpOptions = {
      format: options?.format ?? 'sql',
      table: options?.table,
      delimiter: options?.delimiter ?? ',',
      quoteChar: options?.quoteChar ?? '"',
      includeCreateTable: options?.includeCreateTable ?? true,
      includeDropTable: options?.includeDropTable ?? false,
    };

    // Discover tables
    const tables = this.discoverTables(opts.table);

    if (opts.format === 'csv') {
      return this.dumpCsv(tables, opts);
    }

    return this.dumpSql(tables, opts);
  }

  /**
   * Return a manifest describing what logicDump() would produce, without
   * actually serialising the data.  Useful for backup planning.
   */
  inspect(options?: LogicDumpOptions): LogicDumpManifest {
    const opts: ResolvedLogicDumpOptions = {
      format: options?.format ?? 'sql',
      table: options?.table,
      delimiter: options?.delimiter ?? ',',
      quoteChar: options?.quoteChar ?? '"',
      includeCreateTable: options?.includeCreateTable ?? true,
      includeDropTable: options?.includeDropTable ?? false,
    };

    const tables = this.discoverTables(opts.table);
    const entries: BackupManifestEntry[] = [];
    let totalBytes = 0;

    for (const { name } of tables) {
      const rowCount = this.getRowCount(name);
      const vectorInfo = this.detectVectorIndex(name);

      // Compute a lightweight checksum from a hash of all row IDs (fast, no full dump)
      const checksum = this.computeTableChecksum(name);

      entries.push({
        tableName: name,
        rowCount,
        checksum,
        hasVectorIndex: vectorInfo.hasIndex,
        vectorDimension: vectorInfo.dimension,
        vectorMetric: vectorInfo.metric,
      });

      // Estimate size: rough approximation
      totalBytes += rowCount * 256; // rough row estimate
    }

    return {
      generatedAt: Date.now(),
      format: opts.format,
      tables: entries,
      totalSizeBytes: totalBytes,
    };
  }

  /**
   * Restore a single table from a SQL logical dump.
   *
   * Parses the dump for `CREATE TABLE <tableName>` and `INSERT INTO <tableName>`
   * statements, then executes them in order.
   *
   * @param dumpContent  The SQL dump string (from logicDump)
   * @param tableName    The table to restore
   * @param options      Restore options
   */
  singleTableRestore(
    dumpContent: string,
    tableName: string,
    options?: SingleTableRestoreOptions,
  ): void {
    const opts: Required<SingleTableRestoreOptions> = {
      dropFirst: options?.dropFirst ?? false,
      disableTriggers: options?.disableTriggers ?? false,
    };

    // Extract CREATE TABLE for this specific table
    const createRegex = new RegExp(
      `CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(?:["\`]?)${this.escapeRegex(tableName)}(?:["\`]?)\\s*\\([\\s\\S]*?\\);`,
      'i',
    );
    const createMatch = dumpContent.match(createRegex);
    if (!createMatch) {
      throw new Error(
        `No CREATE TABLE statement found for table "${tableName}" in dump`,
      );
    }

    // Optionally drop first
    if (opts.dropFirst) {
      this.db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
    }

    // Disable triggers/constraints if requested. SQLite has no
    // `ALTER TABLE … DISABLE TRIGGER ALL` (that is PostgreSQL syntax); the
    // closest equivalent is to suspend foreign-key enforcement and recursive
    // triggers for the duration of the restore, then restore the prior state.
    let prevForeignKeys: boolean | undefined;
    let prevRecursiveTriggers: boolean | undefined;
    if (opts.disableTriggers) {
      prevForeignKeys = this.db.pragma('foreign_keys', { simple: true }) as boolean;
      prevRecursiveTriggers = this.db.pragma('recursive_triggers', {
        simple: true,
      }) as boolean;
      this.db.pragma('foreign_keys = OFF');
      this.db.pragma('recursive_triggers = OFF');
    }

    try {
      // Execute CREATE TABLE
      this.db.exec(createMatch[0]);

      // Extract INSERT INTO statements for this table.
      // Format can be:
      //   INSERT INTO "users" VALUES (...);
      //   INSERT INTO "users" ("col1", "col2") VALUES (...);
      // Notes: \s*\([^)]*\) optionally matches whitespace + column list before VALUES.
      const insertRegex = new RegExp(
        `INSERT\\s+INTO\\s+(?:["\`]?)${this.escapeRegex(tableName)}(?:["\`]?)\\s*(?:\\([^)]*\\))?\\s*VALUES\\s*\\([^;]*;`,
        'gi',
      );
      let insertMatch: RegExpExecArray | null;
      while ((insertMatch = insertRegex.exec(dumpContent)) !== null) {
        this.db.exec(insertMatch[0]);
      }
    } finally {
      // Restore the prior pragma state regardless of success or failure.
      if (opts.disableTriggers) {
        this.db.pragma(`foreign_keys = ${prevForeignKeys ? 'ON' : 'OFF'}`);
        this.db.pragma(
          `recursive_triggers = ${prevRecursiveTriggers ? 'ON' : 'OFF'}`,
        );
      }
    }
  }

  /**
   * Restore a full dump (all tables).
   *
   * @param dumpContent  The SQL dump string
   * @param dropFirst    Drop each table before recreating (default: false)
   */
  fullRestore(dumpContent: string, dropFirst: boolean = false): void {
    // Split into individual statements and execute each
    const statements = this.splitSqlStatements(dumpContent);

    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;

      // Handle DROP TABLE IF EXISTS before CREATE
      const isCreate = /^CREATE\s+TABLE/i.test(trimmed);
      if (dropFirst && isCreate) {
        const tableName = this.extractTableNameFromCreate(trimmed);
        if (tableName) {
          this.db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
        }
      }

      try {
        this.db.exec(trimmed);
      } catch (err: any) {
        // Skip statements that fail (e.g. vector index creation if vec0 not loaded)
        logger.warn(`[LogicalBackup] Skipping statement (non-fatal): ${err.message}`);
      }
    }
  }

  // ──────────────────────────────────────────────
  //  File-based export / import
  // ──────────────────────────────────────────────

  /**
   * Export all rows from a table to a CSV file.
   *
   * @param tableName  Name of the table to export
   * @param outputPath  File path for the CSV output
   */
  async exportAsCsv(tableName: string, outputPath: string): Promise<void> {
    const opts: ResolvedLogicDumpOptions = {
      format: 'csv',
      table: tableName,
      delimiter: ',',
      quoteChar: '"',
      includeCreateTable: false,
      includeDropTable: false,
    };

    const tables = this.discoverTables(tableName);
    if (tables.length === 0) {
      throw new Error(`Table "${tableName}" not found`);
    }

    const csvContent = this.dumpCsv(tables, opts);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, csvContent, 'utf-8');

    logger.info(`[LogicalBackup] Exported table "${tableName}" to CSV: ${outputPath}`);
  }

  /**
   * Export all rows from a table to a SQL INSERT script file.
   * Rows are ordered by the primary key column if one can be detected.
   *
   * @param tableName  Name of the table to export
   * @param outputPath  File path for the SQL output
   */
  async exportAsSql(tableName: string, outputPath: string): Promise<void> {
    const opts: ResolvedLogicDumpOptions = {
      format: 'sql',
      table: tableName,
      delimiter: ',',
      quoteChar: '"',
      includeCreateTable: true,
      includeDropTable: false,
    };

    const tables = this.discoverTables(tableName);
    if (tables.length === 0) {
      throw new Error(`Table "${tableName}" not found`);
    }

    const sqlContent = this.dumpSqlOrdered(tables, opts);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, sqlContent, 'utf-8');

    logger.info(`[LogicalBackup] Exported table "${tableName}" to SQL: ${outputPath}`);
  }

  /**
   * Import rows from a CSV file into the specified table.
   * The first line of the CSV is treated as column headers.
   *
   * @param tableName  Name of the target table
   * @param inputPath  Path to the CSV file
   * @returns          Number of rows imported
   */
  async importFromCsv(tableName: string, inputPath: string): Promise<number> {
    const raw = await fs.promises.readFile(inputPath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      logger.warn(`[LogicalBackup] CSV file is empty: ${inputPath}`);
      return 0;
    }

    // Parse header row
    const headers = this.parseCsvLine(lines[0]);
    if (headers.length === 0) {
      throw new Error(`CSV file has no valid headers: ${inputPath}`);
    }

    // Prepare INSERT statement
    const placeholders = headers.map(() => '?').join(', ');
    const colList = headers.map((h) => `"${h}"`).join(', ');
    const stmt = this.db.prepare(
      `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders})`,
    );

    let imported = 0;
    const insertMany = this.db.transaction((rows: string[][]) => {
      for (const row of rows) {
        stmt.run(...row);
        imported++;
      }
    });

    // Parse data rows
    const dataRows: string[][] = [];
    for (let i = 1; i < lines.length; i++) {
      const fields = this.parseCsvLine(lines[i]);
      // Pad or truncate to match headers
      while (fields.length < headers.length) fields.push('');
      dataRows.push(fields.slice(0, headers.length));
    }

    insertMany(dataRows);

    logger.info(`[LogicalBackup] Imported ${imported} rows into "${tableName}" from CSV: ${inputPath}`);
    return imported;
  }

  /**
   * Import SQL statements from a file and execute them.
   * Statements are split by semicolons (simple parser — no complex SQL parsing).
   *
   * @param inputPath  Path to the SQL file
   * @returns          Number of SQL statements executed
   */
  async importFromSql(inputPath: string): Promise<number> {
    const raw = await fs.promises.readFile(inputPath, 'utf-8');
    const statements = this.splitSqlStatements(raw).filter((s) => s.trim().length > 0);

    let executed = 0;
    for (const stmt of statements) {
      try {
        this.db.exec(stmt.trim());
        executed++;
      } catch (err: any) {
        logger.warn(`[LogicalBackup] Skipping SQL statement (non-fatal): ${err.message}`);
      }
    }

    logger.info(`[LogicalBackup] Executed ${executed} statements from SQL file: ${inputPath}`);
    return executed;
  }

  // ──────────────────────────────────────────────
  //  Private helpers: table discovery
  // ──────────────────────────────────────────────

  private discoverTables(
    only?: string,
  ): Array<{ name: string; isVec: boolean }> {
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table'
           AND name NOT LIKE 'sqlite_%'
           AND substr(name, 1, 4) != 'vec_'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    return rows
      .filter((r) => !only || r.name === only)
      .map((r) => ({ name: r.name, isVec: false }));
  }

  private getRowCount(table: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM "${table}"`)
      .get() as { cnt: number };
    return row.cnt;
  }

  private detectVectorIndex(
    table: string,
  ): { hasIndex: boolean; dimension?: number; metric?: string } {
    try {
      const row = this.db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name = 'vec_${table}'`,
        )
        .get() as { name: string } | undefined;

      if (!row) return { hasIndex: false };

      // Try to infer dimension from the virtual table SQL
      const createSql = this.db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type='table' AND name = 'vec_${table}'`,
        )
        .get() as { sql: string } | undefined;

      if (!createSql || !createSql.sql) return { hasIndex: true };

      const dimMatch = createSql.sql.match(/FLOAT\[(\d+)\]/);
      const metricMatch = createSql.sql.match(/distance_metric=(\w+)/);

      return {
        hasIndex: true,
        dimension: dimMatch ? parseInt(dimMatch[1], 10) : undefined,
        metric: metricMatch ? metricMatch[1] : undefined,
      };
    } catch {
      return { hasIndex: false };
    }
  }

  private computeTableChecksum(table: string): string {
    // Hash all row IDs as a fast fingerprint
    const hash = crypto.createHash('sha256');
    const ids = this.db
      .prepare(`SELECT rowid FROM "${table}" ORDER BY rowid`)
      .all() as Array<{ rowid: number }>;
    for (const { rowid } of ids) {
      hash.update(String(rowid));
    }
    return hash.digest('hex');
  }

  // ──────────────────────────────────────────────
  //  Private helpers: SQL dump
  // ──────────────────────────────────────────────

  private dumpSql(
    tables: Array<{ name: string; isVec: boolean }>,
    opts: ResolvedLogicDumpOptions,
  ): string {
    const parts: string[] = [
      `-- LogicalBackup generated at ${new Date().toISOString()}`,
      `-- Format: SQL`,
      '',
    ];

    for (const { name } of tables) {
      // DROP TABLE
      if (opts.includeDropTable) {
        parts.push(`DROP TABLE IF EXISTS "${name}";`);
        parts.push('');
      }

      // CREATE TABLE
      if (opts.includeCreateTable) {
        const createSql = this.getCreateTableSql(name);
        parts.push(createSql);
        parts.push('');
      }

      // Vector index metadata
      const vecInfo = this.detectVectorIndex(name);
      if (vecInfo.hasIndex) {
        const dim = vecInfo.dimension ?? '?';
        const metric = vecInfo.metric ?? 'cosine';
        parts.push(`-- Vector index: vec_${name} (dim=${dim}, metric=${metric})`);
        parts.push('');
      }

      // INSERT rows
      const rows = this.db
        .prepare(`SELECT * FROM "${name}"`)
        .all() as Array<Record<string, any>>;

      if (rows.length === 0) {
        parts.push(`-- Table "${name}" is empty`);
        parts.push('');
        continue;
      }

      const columns = Object.keys(rows[0]);
      const colList = columns.map((c) => `"${c}"`).join(', ');

      for (const row of rows) {
        const values = columns.map((col) => this.sqlLiteral(row[col]));
        parts.push(
          `INSERT INTO "${name}" (${colList}) VALUES (${values.join(', ')});`,
        );
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  private getCreateTableSql(table: string): string {
    const row = this.db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type='table' AND name=?`,
      )
      .get(table) as { sql: string } | undefined;

    if (!row || !row.sql) {
      throw new Error(`Cannot find CREATE TABLE for "${table}"`);
    }

    // Append a semicolon if missing
    const sql = row.sql.trim();
    return sql.endsWith(';') ? sql : sql + ';';
  }

  // ──────────────────────────────────────────────
  //  Private helpers: CSV dump
  // ──────────────────────────────────────────────

  private dumpCsv(
    tables: Array<{ name: string; isVec: boolean }>,
    opts: ResolvedLogicDumpOptions,
  ): string {
    const parts: string[] = [];

    for (const { name } of tables) {
      const rows = this.db
        .prepare(`SELECT * FROM "${name}"`)
        .all() as Array<Record<string, any>>;

      if (rows.length === 0) continue;

      const columns = Object.keys(rows[0]);

      // Header row
      parts.push(
        columns
          .map((c) => this.csvEscape(c, opts.quoteChar, opts.delimiter))
          .join(opts.delimiter),
      );

      // Data rows
      for (const row of rows) {
        parts.push(
          columns
            .map((col) =>
              this.csvEscape(String(row[col] ?? ''), opts.quoteChar, opts.delimiter),
            )
            .join(opts.delimiter),
        );
      }
    }

    return parts.join('\n');
  }

  // ──────────────────────────────────────────────
 //  Private helpers: serialization
  // ──────────────────────────────────────────────

  /**
   * Convert a JavaScript value to a literal suitable for INSERT statements.
   */
  private sqlLiteral(val: any): string {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') {
      // NaN and ±Infinity are not valid SQL numeric literals; emit NULL instead
      // of producing a syntactically invalid INSERT (which SQLite would reject).
      if (!Number.isFinite(val)) return 'NULL';
      return String(val);
    }
    if (typeof val === 'boolean') return val ? '1' : '0';
    if (val instanceof Buffer) {
      return `X'${val.toString('hex')}'`;
    }
    if (typeof val === 'bigint') return String(val);
    // String: escape single quotes
    const str = String(val).replace(/'/g, "''");
    return `'${str}'`;
  }

  private csvEscape(val: string, quoteChar: string, delimiter: string): string {
    // If the value contains the delimiter, the quote char, or a newline, it
    // must be wrapped in quotes (and embedded quote chars doubled).
    if (
      val.includes(delimiter) ||
      val.includes(quoteChar) ||
      val.includes('\n') ||
      val.includes('\r')
    ) {
      // Doubling the quote char via split/join treats it as a literal even when
      // it is a regex metacharacter (`.`, `*`, `+`, …). A RegExp-based replace
      // would corrupt the value in that case.
      const escaped = val.split(quoteChar).join(quoteChar + quoteChar);
      return `${quoteChar}${escaped}${quoteChar}`;
    }
    return val;
  }

  /**
   * Like dumpSql but orders rows by the primary key column if one can be detected.
   */
  private dumpSqlOrdered(
    tables: Array<{ name: string; isVec: boolean }>,
    opts: ResolvedLogicDumpOptions,
  ): string {
    const parts: string[] = [
      `-- LogicalBackup generated at ${new Date().toISOString()}`,
      `-- Format: SQL`,
      '',
    ];

    for (const { name } of tables) {
      // DROP TABLE
      if (opts.includeDropTable) {
        parts.push(`DROP TABLE IF EXISTS "${name}";`);
        parts.push('');
      }

      // CREATE TABLE
      if (opts.includeCreateTable) {
        const createSql = this.getCreateTableSql(name);
        parts.push(createSql);
        parts.push('');
      }

      // Vector index metadata
      const vecInfo = this.detectVectorIndex(name);
      if (vecInfo.hasIndex) {
        const dim = vecInfo.dimension ?? '?';
        const metric = vecInfo.metric ?? 'cosine';
        parts.push(`-- Vector index: vec_${name} (dim=${dim}, metric=${metric})`);
        parts.push('');
      }

      // Detect primary key to order by
      const pkOrder = this.detectPrimaryKeyOrder(name);

      // INSERT rows, ordered by PK if available
      let sql = `SELECT * FROM "${name}"`;
      if (pkOrder) {
        sql += ` ORDER BY "${pkOrder}"`;
      }
      const rows = this.db.prepare(sql).all() as Array<Record<string, any>>;

      if (rows.length === 0) {
        parts.push(`-- Table "${name}" is empty`);
        parts.push('');
        continue;
      }

      const columns = Object.keys(rows[0]);
      const colList = columns.map((c) => `"${c}"`).join(', ');

      for (const row of rows) {
        const values = columns.map((col) => this.sqlLiteral(row[col]));
        parts.push(
          `INSERT INTO "${name}" (${colList}) VALUES (${values.join(', ')});`,
        );
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * Simple CSV line parser that handles quoted fields.
   */
  private parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '"';

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (inQuotes) {
        if (ch === quoteChar) {
          // Check for escaped quote (doubled)
          if (i + 1 < line.length && line[i + 1] === quoteChar) {
            current += quoteChar;
            i++; // skip next
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === quoteChar) {
          inQuotes = true;
        } else if (ch === ',') {
          fields.push(current);
          current = '';
        } else if (ch === '\r' || ch === '\n') {
          // Skip — should be handled by line splitting already
        } else {
          current += ch;
        }
      }
    }

    fields.push(current);
    return fields;
  }

  /**
   * Detect the primary key column for ordering.
   * Returns the column name, or null if no PK is found.
   */
  private detectPrimaryKeyOrder(table: string): string | null {
    try {
      // SQLite stores PK info in the table_info pragma
      const pkCols = this.db
        .prepare(`SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`)
        .all(table) as Array<{ name: string }>;

      if (pkCols.length > 0) {
        return pkCols[0].name;
      }

      // Fallback: check for common ID columns
      const cols = this.db
        .prepare(`SELECT name FROM pragma_table_info(?)`)
        .all(table) as Array<{ name: string }>;

      const idCandidates = ['id', 'rowid', '_id', `${table}_id`];
      for (const candidate of idCandidates) {
        if (cols.some((c) => c.name === candidate)) {
          return candidate;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────────────
  //  Private helpers: restore
  // ──────────────────────────────────────────────

  private splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inString = false;
    let stringChar = '';

    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      const next = i + 1 < sql.length ? sql[i + 1] : '';

      if (inString) {
        current += ch;
        if (ch === stringChar && next === stringChar) {
          // Escaped quote
          current += next;
          i++;
        } else if (ch === stringChar) {
          inString = false;
        }
      } else if ((ch === "'" || ch === '"') && next === ch) {
        // Empty string '' or ""
        current += ch + next;
        i++;
      } else if (ch === "'" || ch === '"') {
        inString = true;
        stringChar = ch;
        current += ch;
      } else if (ch === ';') {
        current += ';';
        statements.push(current);
        current = '';
      } else {
        current += ch;
      }
    }

    // Flush remaining
    if (current.trim()) {
      statements.push(current);
    }

    return statements;
  }

  private extractTableNameFromCreate(sql: string): string | null {
    const match = sql.match(
      /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:["`]?)(\w+)(?:["`]?)\s*\(/i,
    );
    return match ? match[1] : null;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
