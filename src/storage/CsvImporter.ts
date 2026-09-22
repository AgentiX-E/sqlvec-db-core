/**
 * CsvImporter — CSV file import into a better-sqlite3 database
 *
 * Features:
 * - Schema inference from CSV header + sample rows
 * - Batch inserts for performance
 * - Configurable delimiter, header, skipLines, quoteChar
 * - Error modes: skip (log + continue) or abort (throw)
 * - Auto-detects column types (INTEGER, REAL, TEXT, BLOB)
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as readline from 'readline';

// ── Types ──────────────────────────────────────────

export interface CsvImportOptions {
  /** Column delimiter (default: ',') */
  delimiter?: string;
  /** Whether the first row is a header (default: true) */
  header?: boolean;
  /** Number of lines to skip before the header/data (default: 0) */
  skipLines?: number;
  /** Quote character (default: '"') */
  quoteChar?: string;
  /** Error handling mode (default: 'abort') */
  errorMode?: 'skip' | 'abort';
  /** Target table name (default: inferred from filename or 'imported_data') */
  tableName?: string;
  /** Batch size for inserts (default: 100) */
  batchSize?: number;
  /** If true, infer schema from sample rows (default: true) */
  inferTypes?: boolean;
  /** Number of sample rows for type inference (default: 100) */
  sampleSize?: number;
  /** Character encoding (default: 'utf-8') */
  encoding?: BufferEncoding;
  /** Whether to create the table (default: true) */
  createTable?: boolean;
  /** If table exists, behaviour: 'append', 'replace', 'error' (default: 'error') */
  ifExists?: 'append' | 'replace' | 'error';
}

export interface CsvImportResult {
  /** Number of rows successfully imported */
  rowsImported: number;
  /** Number of rows skipped (parse errors or type errors) */
  rowsSkipped: number;
  /** Table name used */
  tableName: string;
  /** Inferred column names */
  columns: string[];
  /** Inferred column types */
  columnTypes: string[];
  /** Elapsed time in ms */
  elapsedMs: number;
  /** Error messages for skipped rows */
  errors: string[];
}

export type InferredType = 'INTEGER' | 'REAL' | 'TEXT' | 'NULL';

// ── CsvImporter ────────────────────────────────────

export class CsvImporter {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Import a CSV file into the database.
   *
   * @param filePath  Path to the CSV file
   * @param options   Import options
   * @returns         Import result with stats
   */
  async importCSV(
    filePath: string,
    options?: CsvImportOptions & { tableName?: string },
  ): Promise<CsvImportResult> {
    const start = Date.now();

    const opts: Required<CsvImportOptions> = {
      delimiter: options?.delimiter ?? ',',
      header: options?.header ?? true,
      skipLines: options?.skipLines ?? 0,
      quoteChar: options?.quoteChar ?? '"',
      errorMode: options?.errorMode ?? 'abort',
      tableName: options?.tableName ?? this.inferTableName(filePath),
      batchSize: options?.batchSize ?? 100,
      inferTypes: options?.inferTypes ?? true,
      sampleSize: options?.sampleSize ?? 100,
      encoding: options?.encoding ?? 'utf-8',
      createTable: options?.createTable ?? true,
      ifExists: options?.ifExists ?? 'error',
    };

    // Read all lines from the file
    const allLines = await this.readLines(filePath, opts.encoding);

    // Skip preamble lines
    let lineIdx = opts.skipLines;

    // Parse header or generate default column names
    let columns: string[];
    if (opts.header && lineIdx < allLines.length) {
      columns = this.parseCsvLine(allLines[lineIdx], opts.delimiter, opts.quoteChar);
      lineIdx++;
    } else {
      // No header — read first data line to determine column count
      const firstDataLine =
        lineIdx < allLines.length
          ? this.parseCsvLine(allLines[lineIdx], opts.delimiter, opts.quoteChar)
          : [];
      columns = firstDataLine.map((_, i) => `col_${i + 1}`);
    }

    if (columns.length === 0) {
      throw new Error('CSV file has no columns');
    }

    // Sanitize column names
    columns = columns.map((c) => this.sanitizeColumnName(c));

    // Deduplicate column names
    columns = this.deduplicateColumns(columns);

    // Sample data for type inference
    const dataLines: string[][] = [];
    let sampleEnd = lineIdx + opts.sampleSize;
    for (let i = lineIdx; i < Math.min(sampleEnd, allLines.length); i++) {
      const row = this.parseCsvLine(allLines[i], opts.delimiter, opts.quoteChar);
      if (row.length > 0) dataLines.push(row);
    }

    // Infer types from sample
    let columnTypes: string[];
    if (opts.inferTypes && dataLines.length > 0) {
      columnTypes = this.inferColumnTypes(columns, dataLines);
    } else {
      columnTypes = columns.map(() => 'TEXT');
    }

    // Handle existing table
    if (opts.createTable) {
      this.ensureTable(opts.tableName, columns, columnTypes, opts.ifExists);
    }

    // Batch insert
    const errors: string[] = [];
    let rowsImported = 0;
    let rowsSkipped = 0;

    // Prepare insert statement (reused for performance)
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO "${opts.tableName}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`;
    const insertStmt = this.db.prepare(insertSql);

    const insertBatch = this.db.transaction((batch: string[][]) => {
      for (const row of batch) {
        try {
          const typedValues = this.coerceValues(row, columns.length, columnTypes);
          insertStmt.run(...typedValues);
          rowsImported++;
        } catch (err: any) {
          rowsSkipped++;
          errors.push(`Row ${rowsImported + rowsSkipped}: ${err.message}`);
          if (opts.errorMode === 'abort') {
            throw err;
          }
        }
      }
    });

    // Process remaining data lines
    let batch: string[][] = [];
    for (let i = lineIdx; i < allLines.length; i++) {
      const row = this.parseCsvLine(allLines[i], opts.delimiter, opts.quoteChar);
      if (row.length === 0) continue; // skip empty lines

      batch.push(row);

      if (batch.length >= opts.batchSize) {
        try {
          insertBatch(batch);
        } catch (err: any) {
          if (opts.errorMode === 'abort') {
            throw err;
          }
          // count skipped
          rowsSkipped += batch.length;
        }
        batch = [];
      }
    }

    // Flush remaining batch
    if (batch.length > 0) {
      try {
        insertBatch(batch);
      } catch (err: any) {
        if (opts.errorMode === 'abort') {
          throw err;
        }
        rowsSkipped += batch.length;
      }
    }

    return {
      rowsImported,
      rowsSkipped,
      tableName: opts.tableName,
      columns,
      columnTypes,
      elapsedMs: Date.now() - start,
      errors,
    };
  }

  // ──────────────────────────────────────────────
  //  Private: CSV parsing
  // ──────────────────────────────────────────────

  /**
   * Parse a single CSV line into fields, respecting quoted fields.
   */
  private parseCsvLine(
    line: string,
    delimiter: string,
    quoteChar: string,
  ): string[] {
    // A blank line (whitespace only, or empty) is not a data row — return an
    // empty array so the caller's `row.length === 0` guard can skip it. Without
    // this, an empty line parses to `['']` (a single empty field) and is
    // imported as a spurious NULL row.
    if (line.trim() === '') return [];

    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = i + 1 < line.length ? line[i + 1] : '';

      if (inQuotes) {
        if (ch === quoteChar && next === quoteChar) {
          // Escaped quote
          current += quoteChar;
          i++;
        } else if (ch === quoteChar) {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === quoteChar) {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }

    fields.push(current);
    return fields;
  }

  // ──────────────────────────────────────────────
  //  Private: file reading
  // ──────────────────────────────────────────────

  private async readLines(
    filePath: string,
    encoding: BufferEncoding,
  ): Promise<string[]> {
    const lines: string[] = [];

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lines.push(line);
    }

    return lines;
  }

  // ──────────────────────────────────────────────
  //  Private: schema inference
  // ──────────────────────────────────────────────

  private sanitizeColumnName(name: string): string {
    // Replace non-alphanumeric characters with underscore
    let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');
    // Trim leading/trailing underscores first — otherwise a numeric-leading
    // name would gain a `_` prefix only to have it stripped again below.
    sanitized = sanitized.replace(/^_+|_+$/g, '');
    // Ensure the identifier starts with a letter or underscore (a bare digit
    // is not a valid SQL identifier, even when double-quoted in some engines).
    if (/^[0-9]/.test(sanitized)) {
      sanitized = '_' + sanitized;
    }
    // Fallback if empty
    return sanitized || 'column';
  }

  private deduplicateColumns(columns: string[]): string[] {
    const seen = new Map<string, number>();
    return columns.map((col) => {
      if (seen.has(col)) {
        const count = seen.get(col)! + 1;
        seen.set(col, count);
        return `${col}_${count}`;
      }
      seen.set(col, 1);
      return col;
    });
  }

  private inferColumnTypes(
    columns: string[],
    sampleRows: string[][],
  ): string[] {
    const types: InferredType[] = columns.map(() => 'NULL');

    for (const row of sampleRows) {
      for (let i = 0; i < Math.min(row.length, columns.length); i++) {
        const val = row[i].trim();
        const currentType = types[i];
        const inferred = this.inferType(val);

        // Merge: NULL + any = any; otherwise pick the broader type
        if (currentType === 'NULL') {
          types[i] = inferred;
        } else if (inferred !== 'NULL' && inferred !== currentType) {
          // Prefer REAL over INTEGER, TEXT over everything else
          types[i] = this.widenType(currentType, inferred);
        }
      }
    }

    return types.map((t) => (t === 'NULL' ? 'TEXT' : t));
  }

  private inferType(value: string): InferredType {
    if (value === '' || value === '\\N') return 'NULL';

    // Try INTEGER
    if (/^-?\d+$/.test(value)) return 'INTEGER';

    // Try REAL
    if (/^-?\d+\.?\d*(?:[eE][+-]?\d+)?$/.test(value)) return 'REAL';

    // Boolean-like
    if (/^(true|false|t|f|yes|no)$/i.test(value)) return 'INTEGER';

    return 'TEXT';
  }

  /**
   * Coerce a value to an INTEGER, honouring the boolean spellings that
   * `inferType` classifies as INTEGER (true/t/f/yes/no → 1/0). Returns NaN for
   * genuinely non-numeric text so callers can detect a coercion failure.
   */
  private coerceInteger(value: string): number {
    if (/^(true|t|yes)$/i.test(value)) return 1;
    if (/^(false|f|no)$/i.test(value)) return 0;
    return parseInt(value, 10);
  }

  private widenType(a: InferredType, b: InferredType): InferredType {
    if (a === 'TEXT' || b === 'TEXT') return 'TEXT';
    if (a === 'REAL' || b === 'REAL') return 'REAL';
    if (a === 'INTEGER' || b === 'INTEGER') return 'INTEGER';
    return 'TEXT';
  }

  // ──────────────────────────────────────────────
  //  Private: table management
  // ──────────────────────────────────────────────

  private ensureTable(
    tableName: string,
    columns: string[],
    types: string[],
    ifExists: 'append' | 'replace' | 'error',
  ): void {
    const exists = this.tableExists(tableName);

    if (exists) {
      switch (ifExists) {
        case 'error':
          throw new Error(
            `Table "${tableName}" already exists. Use ifExists: 'append' or 'replace'.`,
          );
        case 'replace':
          this.db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
          break;
        case 'append':
          // Table exists and we're appending — validate columns exist
          // (insert will fail if columns mismatch)
          return;
      }
    }

    if (!exists || ifExists === 'replace') {
      const columnDefs = columns
        .map((col, i) => `"${col}" ${types[i]}`)
        .join(', ');
      this.db.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${columnDefs})`);
    }
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      )
      .get(name);
    return !!row;
  }

  private inferTableName(filePath: string): string {
    // Extract the basename without its extension.
    const basename = filePath.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '');
    // If the basename contains no usable identifier characters at all, fall
    // back to a stable default. (sanitizeColumnName would otherwise return its
    // own 'column' fallback, which is the wrong semantics for a table name.)
    if (/^[^a-zA-Z0-9_]*$/.test(basename)) return 'imported_data';
    return this.sanitizeColumnName(basename);
  }

  // ──────────────────────────────────────────────
  //  Private: value coercion
  // ──────────────────────────────────────────────

  private coerceValues(
    row: string[],
    expectedLength: number,
    types: string[],
  ): any[] {
    const values: any[] = [];

    for (let i = 0; i < expectedLength; i++) {
      const raw = i < row.length ? row[i] : '';
      const trimmed = raw.trim();

      if (trimmed === '' || trimmed === '\\N') {
        values.push(null);
        continue;
      }

      switch (types[i]) {
        case 'INTEGER':
          values.push(this.coerceInteger(trimmed));
          break;
        case 'REAL':
          values.push(parseFloat(trimmed));
          break;
        default:
          values.push(trimmed);
          break;
      }
    }

    return values;
  }
}
