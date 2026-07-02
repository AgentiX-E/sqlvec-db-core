/**
 * CsvExporter — Export database tables to CSV format
 *
 * Thin wrapper around LogicalBackup's CSV export, plus a direct
 * SQL → CSV export function for arbitrary queries.
 *
 * Usage:
 *   const exporter = new CsvExporter(db);
 *   const csv = exporter.exportTable('users');          // Export entire table
 *   const csv = exporter.exportQuery('SELECT ...');     // Export query result
 *   await exporter.exportToFile('users', '/tmp/users.csv');
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';

// ── Types ──────────────────────────────────────────

export interface CsvExportOptions {
  /** Column delimiter (default: ',') */
  delimiter?: string;
  /** Quote character (default: '"') */
  quoteChar?: string;
  /** Include header row (default: true) */
  header?: boolean;
  /** Line ending (default: '\n') */
  lineEnding?: string;
  /** Encoding for file output (default: 'utf-8') */
  encoding?: BufferEncoding;
}

// ── CsvExporter ────────────────────────────────────

export class CsvExporter {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Export a table as a CSV string.
   *
   * @param tableName  Table to export
   * @param options    Export options
   * @returns          CSV string
   */
  exportTable(tableName: string, options?: CsvExportOptions): string {
    const rows = this.db
      .prepare(`SELECT * FROM "${tableName}"`)
      .all() as Array<Record<string, any>>;

    return this.rowsToCsv(rows, options);
  }

  /**
   * Export the result of an arbitrary SQL query as CSV.
   *
   * @param sql       SQL query
   * @param params    Optional query parameters
   * @param options   Export options
   * @returns         CSV string
   */
  exportQuery(
    sql: string,
    params?: any[],
    options?: CsvExportOptions,
  ): string {
    const rows = this.db
      .prepare(sql)
      .all(...(params || [])) as Array<Record<string, any>>;

    return this.rowsToCsv(rows, options);
  }

  /**
   * Export a table directly to a file.
   *
   * @param tableName  Table to export
   * @param filePath   Output file path
   * @param options    Export options
   */
  async exportToFile(
    tableName: string,
    filePath: string,
    options?: CsvExportOptions,
  ): Promise<void> {
    const csv = this.exportTable(tableName, options);
    const opts: Required<CsvExportOptions> = {
      delimiter: options?.delimiter ?? ',',
      quoteChar: options?.quoteChar ?? '"',
      header: options?.header ?? true,
      lineEnding: options?.lineEnding ?? '\n',
      encoding: options?.encoding ?? 'utf-8',
    };
    fs.writeFileSync(filePath, csv, opts.encoding);
  }

  /**
   * Export a query result directly to a file.
   *
   * @param sql       SQL query
   * @param filePath  Output file path
   * @param params    Optional query parameters
   * @param options   Export options
   */
  async exportQueryToFile(
    sql: string,
    filePath: string,
    params?: any[],
    options?: CsvExportOptions,
  ): Promise<void> {
    const csv = this.exportQuery(sql, params, options);
    const opts: Required<CsvExportOptions> = {
      delimiter: options?.delimiter ?? ',',
      quoteChar: options?.quoteChar ?? '"',
      header: options?.header ?? true,
      lineEnding: options?.lineEnding ?? '\n',
      encoding: options?.encoding ?? 'utf-8',
    };
    fs.writeFileSync(filePath, csv, opts.encoding);
  }

  // ──────────────────────────────────────────────
  //  Private
  // ──────────────────────────────────────────────

  private rowsToCsv(
    rows: Array<Record<string, any>>,
    options?: CsvExportOptions,
  ): string {
    const opts: Required<CsvExportOptions> = {
      delimiter: options?.delimiter ?? ',',
      quoteChar: options?.quoteChar ?? '"',
      header: options?.header ?? true,
      lineEnding: options?.lineEnding ?? '\n',
      encoding: options?.encoding ?? 'utf-8',
    };

    if (rows.length === 0) return '';

    const columns = Object.keys(rows[0]);
    const lines: string[] = [];

    // Header
    if (opts.header) {
      lines.push(
        columns
          .map((c) => this.csvEscape(c, opts.quoteChar, opts.delimiter))
          .join(opts.delimiter),
      );
    }

    // Data rows
    for (const row of rows) {
      lines.push(
        columns
          .map((col) => {
            const val = row[col];
            if (val === null || val === undefined) return '';
            return this.csvEscape(String(val), opts.quoteChar, opts.delimiter);
          })
          .join(opts.delimiter),
      );
    }

    return lines.join(opts.lineEnding);
  }

  private csvEscape(
    val: string,
    quoteChar: string,
    delimiter: string,
  ): string {
    const needsQuoting =
      val.includes(delimiter) ||
      val.includes(quoteChar) ||
      val.includes('\n') ||
      val.includes('\r');

    if (needsQuoting) {
      const escaped = val.replace(new RegExp(quoteChar, 'g'), quoteChar + quoteChar);
      return `${quoteChar}${escaped}${quoteChar}`;
    }
    return val;
  }
}
