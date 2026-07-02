/**
 * ColumnEncryptionRewriter — SQL query rewriter for transparent column
 * encryption/decryption at the SQL layer.
 *
 * Works alongside ColumnEncryption (key management) to automatically:
 *   - Encrypt values on INSERT into encrypted columns
 *   - Decrypt values on SELECT from encrypted columns
 *   - Rewrite WHERE equality comparisons to use hashed lookup + decryption verify
 *
 * ## Usage pattern
 *
 * ```typescript
 * const ce = new ColumnEncryption(masterKey);
 * ce.createColumnEncryptionKey('ssn_cek');
 * const rewriter = new ColumnEncryptionRewriter(ce, masterKey);
 * rewriter.registerEncryptedColumn('employees', 'ssn');
 *
 * const encryptedInsert = rewriter.rewriteInsert(
 *   "INSERT INTO employees (name, ssn) VALUES ('Alice', '123-45-6789')"
 * );
 * // → INSERT INTO employees (name, ssn_hash, ssn) VALUES (
 * //     'Alice', ENC('123-45-6789'), HASH('123-45-6789')
 * //   )
 *
 * const decryptedSelect = rewriter.rewriteSelect(
 *   "SELECT ssn FROM employees"
 * );
 * // → SELECT DECRYPT(ssn) AS ssn FROM employees
 *
 * const secureWhere = rewriter.rewriteSelect(
 *   "SELECT * FROM employees WHERE ssn = '123-45-6789'"
 * );
 * // → SELECT DECRYPT(ssn) AS ssn FROM employees
 * //   WHERE ssn_hash = HASH('123-45-6789') AND DECRYPT(ssn) = '123-45-6789'
 * ```
 *
 * @module encryption/ColumnEncryptionRewriter
 */

import * as crypto from 'node:crypto';
import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('ColumnEncryptionRewriter');

// ── Configuration ────────────────────────────────────────────────────────

export interface EncryptedColumnConfig {
  table: string;
  column: string;
  /** Column name that stores the deterministic hash for equality lookup. */
  hashColumn?: string;
  /** Encryption key name in ColumnEncryption. */
  keyName?: string;
}

// ── ColumnEncryptionRewriter ──────────────────────────────────────────────

export class ColumnEncryptionRewriter {
  private readonly logger = PinoLogger.forComponent('ColumnEncryptionRewriter');
  private readonly encryption: any; // ColumnEncryption instance
  private readonly masterKey: Buffer;
  /** Registered encrypted columns: Map<table → Map<column → config>> */
  private readonly encryptedColumns: Map<string, Map<string, EncryptedColumnConfig>> = new Map();
  /** Cache of encryption keys per table:column */
  private readonly keyCache: Map<string, Buffer> = new Map();

  /**
   * @param encryption - A ColumnEncryption instance (or compatible duck-typed object).
   * @param masterKey  - Master key Buffer used for deriving column encryption keys.
   */
  constructor(encryption: any, masterKey: Buffer) {
    this.encryption = encryption;
    this.masterKey = masterKey;
  }

  // ── Registration ───────────────────────────────────────────────────────

  /**
   * Register a column as encrypted.
   *
   * @param table  - Table name (case-insensitive, stored lowercase).
   * @param column - Column name (case-insensitive, stored lowercase).
   * @param config - Optional override config.
   */
  registerEncryptedColumn(table: string, column: string, config?: Partial<EncryptedColumnConfig>): void {
    const tKey = table.toLowerCase();
    const cKey = column.toLowerCase();

    if (!this.encryptedColumns.has(tKey)) {
      this.encryptedColumns.set(tKey, new Map());
    }

    const tableMap = this.encryptedColumns.get(tKey)!;

    if (tableMap.has(cKey)) {
      // Already registered — update if new config provided
      if (config) {
        tableMap.set(cKey, { ...tableMap.get(cKey)!, ...config });
      }
      return;
    }

    const hashCol = config?.hashColumn ?? `${column}_hash`;
    const keyName = config?.keyName ?? `${tKey}_${cKey}_cek`;

    tableMap.set(cKey, {
      table: tKey,
      column: cKey,
      hashColumn: hashCol,
      keyName,
    });

    this.logger.info({ table: tKey, column: cKey }, 'Registered encrypted column');

    // Ensure key exists in ColumnEncryption
    this.ensureEncryptionKey(keyName);
  }

  /**
   * Check if a column is registered as encrypted.
   */
  isEncryptedColumn(table: string, column: string): boolean {
    const tableMap = this.encryptedColumns.get(table.toLowerCase());
    if (!tableMap) return false;
    return tableMap.has(column.toLowerCase());
  }

  /**
   * Get the encrypted column config for a given table+column.
   */
  getColumnConfig(table: string, column: string): EncryptedColumnConfig | undefined {
    return this.encryptedColumns.get(table.toLowerCase())?.get(column.toLowerCase());
  }

  /**
   * Remove all registered encrypted columns.
   */
  clearRegistration(): void {
    this.encryptedColumns.clear();
    this.keyCache.clear();
  }

  // ── SQL Rewriting ──────────────────────────────────────────────────────

  /**
   * Rewrite an INSERT statement to encrypt designated columns.
   *
   * For each encrypted column, the value is replaced with:
   *   encrypt(value, key)
   *
   * The corresponding hash column is also added:
   *   hash_column = hash(value)
   *
   * @param sql - The original INSERT SQL.
   * @returns The rewritten INSERT SQL with encryption functions applied.
   */
  rewriteInsert(sql: string): string {
    const parsed = this.parseInsert(sql);
    if (!parsed) return sql;

    const { table, columns, values } = parsed;
    const tableMap = this.encryptedColumns.get(table.toLowerCase());

    if (!tableMap || tableMap.size === 0) return sql;

    const newColumns: string[] = [...columns];
    const newValues: string[] = [...values];
    const addedColumns: string[] = [];
    const addedValues: string[] = [];

    for (let i = 0; i < columns.length; i++) {
      const colName = columns[i].toLowerCase();
      const config = tableMap.get(colName);

      if (!config || !config.keyName) continue;

      const origValue = values[i];

      // Replace value with encrypt function call
      newValues[i] = this.makeEncryptCall(origValue, config.keyName);

      // Add corresponding hash column + value if not already present
      const hashColName = config.hashColumn || `${columns[i]}_hash`;
      const hashValue = this.makeHashCall(origValue);

      // Only add the hash column if it's not already in the column list
      const hashColExists = columns.some(c => c.toLowerCase() === hashColName.toLowerCase());
      if (!hashColExists) {
        addedColumns.push(hashColName);
        addedValues.push(hashValue);
      }
    }

    // Append any added columns (hash columns)
    newColumns.push(...addedColumns);
    newValues.push(...addedValues);

    return this.buildInsert(table, newColumns, newValues);
  }

  /**
   * Rewrite a SELECT statement to decrypt designated columns.
   *
   * For each encrypted column in the result set, wrap with decrypt():
   *   SELECT decrypt(col) AS col
   *
   * For WHERE equality on encrypted columns, rewrite to:
   *   WHERE col_hash = hash(value) AND decrypt(col) = value
   *
   * @param sql - The original SELECT SQL.
   * @returns The rewritten SELECT SQL.
   */
  rewriteSelect(sql: string): string {
    if (!this.hasAnyEncryptedColumns()) return sql;

    const lowerSql = sql.toLowerCase();
    const tables = this.extractTableNames(sql);

    if (tables.length === 0) return sql;

    // Determine which table(s) are involved
    const table = tables[0]; // primary table
    const tableMap = this.encryptedColumns.get(table.toLowerCase());
    if (!tableMap || tableMap.size === 0) return sql;

    let rewritten = sql;

    // Phase 1: Rewrite column references in SELECT list
    // (DECRYPT(col) AS col for each encrypted column in the result)
    rewritten = this.rewriteSelectColumns(rewritten, tableMap);

    // Phase 2: Rewrite WHERE clauses for encrypted columns
    rewritten = this.rewriteWhereClauses(rewritten, tableMap);

    return rewritten;
  }

  // ── Internal: INSERT parsing ───────────────────────────────────────────

  /**
   * Very basic INSERT parser — extracts table, columns, and values from
   * `INSERT INTO table (col1, col2) VALUES (v1, v2)` style.
   */
  private parseInsert(sql: string): { table: string; columns: string[]; values: string[] } | null {
    const match = sql.match(
      /^\s*INSERT\s+INTO\s+(\w+(?:\.\w+)?)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*;?\s*$/i,
    );
    if (!match) return null;

    const table = match[1];
    const columns = match[2].split(',').map(c => c.trim());
    const values = this.parseValuesList(match[3]);

    return { table, columns, values };
  }

  /**
   * Parse comma-separated values respecting string literals.
   */
  private parseValuesList(valuesStr: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuote = false;
    let parenDepth = 0;

    for (let i = 0; i < valuesStr.length; i++) {
      const ch = valuesStr[i];

      if (ch === "'" && !inQuote) {
        inQuote = true;
        current += ch;
      } else if (ch === "'" && inQuote) {
        inQuote = false;
        current += ch;
      } else if (ch === '(' && !inQuote) {
        parenDepth++;
        current += ch;
      } else if (ch === ')' && !inQuote) {
        parenDepth--;
        current += ch;
      } else if (ch === ',' && !inQuote && parenDepth === 0) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }

    if (current.trim()) {
      values.push(current.trim());
    }

    return values;
  }

  // ── Internal: SELECT rewriting ─────────────────────────────────────────

  /**
   * Check if any encrypted columns are registered.
   */
  private hasAnyEncryptedColumns(): boolean {
    return this.encryptedColumns.size > 0;
  }

  /**
   * Extract table names from a SQL query (simplified).
   */
  private extractTableNames(sql: string): string[] {
    const tables: string[] = [];
    const fromMatch = sql.match(/\bFROM\s+(\w+(?:\.\w+)?(?:\s*,\s*\w+(?:\.\w+)?)*)/i);
    if (fromMatch) {
      const parts = fromMatch[1].split(',').map(p => p.trim().split(/\s+/)[0]);
      tables.push(...parts);
    }
    // Also check JOIN
    const joinMatch = sql.match(/\bJOIN\s+(\w+(?:\.\w+)?)/gi);
    if (joinMatch) {
      for (const m of joinMatch) {
        const table = m.replace(/JOIN\s+/i, '').trim();
        tables.push(table);
      }
    }
    return tables;
  }

  /**
   * Rewrite SELECT column list: wrap encrypted columns with decrypt().
   */
  private rewriteSelectColumns(sql: string, tableMap: Map<string, EncryptedColumnConfig>): string {
    // Try to isolate the SELECT list
    const selectMatch = sql.match(/^\s*SELECT\s+(.*?)\s+FROM\s/is);
    if (!selectMatch) return sql;

    const selectList = selectMatch[1];
    const beforeFrom = sql.substring(0, selectMatch.index! + 7); // "SELECT "
    const afterSelect = sql.substring(selectMatch.index! + 7 + selectList.length);

    const columns = this.parseSelectColumns(selectList);
    const newColumns: string[] = [];

    for (const col of columns) {
      const { expression, alias } = col;
      const colLower = expression.toLowerCase().replace(/^["`]|["`]$/g, '');

      if (tableMap.has(colLower)) {
        const config = tableMap.get(colLower)!;
        const decryptedAlias = alias || expression;
        newColumns.push(`${this.makeDecryptCall(expression, config.keyName!)} AS ${decryptedAlias}`);
      } else {
        newColumns.push(col.raw);
      }
    }

    const newSelectList = newColumns.join(', ');
    return `${beforeFrom}${newSelectList}${afterSelect}`;
  }

  /**
   * Parse a SELECT column list into individual column references.
   */
  private parseSelectColumns(selectList: string): Array<{ raw: string; expression: string; alias?: string }> {
    const columns: Array<{ raw: string; expression: string; alias?: string }> = [];
    let current = '';
    let depth = 0;
    let inQuote = false;
    let inString = false;

    for (let i = 0; i < selectList.length; i++) {
      const ch = selectList[i];

      if (ch === "'" && !inString) {
        inString = !inString;
      } else if (ch === '(' && !inString) {
        depth++;
      } else if (ch === ')' && !inString) {
        depth--;
      } else if (ch === ',' && depth === 0 && !inString) {
        columns.push(this.parseColumnRef(current.trim()));
        current = '';
        continue;
      }

      current += ch;
    }

    if (current.trim()) {
      columns.push(this.parseColumnRef(current.trim()));
    }

    if (columns.length === 0 && selectList.trim() === '*') {
      columns.push({ raw: '*', expression: '*' });
    }

    return columns;
  }

  /**
   * Parse a single column reference, extracting alias if present.
   */
  private parseColumnRef(colStr: string): { raw: string; expression: string; alias?: string } {
    // Handle AS alias (case-insensitive)
    const asMatch = colStr.match(/^(.*?)\s+AS\s+(.+)$/i);
    if (asMatch) {
      return {
        raw: colStr,
        expression: asMatch[1].trim(),
        alias: asMatch[2].trim(),
      };
    }

    // Handle alias without AS (space-separated, but not function calls)
    const hasFunction = colStr.includes('(') || colStr.includes(')');
    if (!hasFunction) {
      const parts = colStr.split(/\s+/);
      if (parts.length >= 2) {
        return {
          raw: colStr,
          expression: parts[0],
          alias: parts.slice(1).join(' '),
        };
      }
    }

    return { raw: colStr, expression: colStr, alias: undefined };
  }

  /**
   * Rewrite WHERE clause: for equality comparisons on encrypted columns,
   * replace `col = value` with `col_hash = hash(value) AND decrypt(col) = value`.
   */
  private rewriteWhereClauses(sql: string, tableMap: Map<string, EncryptedColumnConfig>): string {
    // Find WHERE clause
    const whereMatch = sql.match(/\bWHERE\s+(.*)$/is);
    if (!whereMatch) return sql;

    const whereClause = whereMatch[1];
    const whereIndex = whereMatch.index!;

    // For each encrypted column, find equality comparisons
    for (const [colName, config] of tableMap) {
      const colRegex = new RegExp(
        `\\b${this.escapeRegex(colName)}\\s*=\\s*('[^']*'|\\d+(?:\\.\\d+)?|true|false|null|\\w+)`,
        'gi',
      );

      const newWhere = whereClause.replace(colRegex, (match, value) => {
        const hashCol = config.hashColumn || `${colName}_hash`;
        return `${hashCol} = ${this.makeHashCall(value)} AND ${this.makeDecryptCall(colName, config.keyName!)} = ${value}`;
      });

      if (newWhere !== whereClause) {
        // Rebuild the SQL with rewritten WHERE
        const beforeWhere = sql.substring(0, whereIndex + 6); // "WHERE "
        return beforeWhere + newWhere;
      }
    }

    return sql;
  }

  // ── Crypto helpers ───────────────────────────────────────────────────── 

  /**
   * Derive or retrieve the encryption key for a given key name.
   */
  private getEncryptionKey(keyName: string): Buffer {
    const cached = this.keyCache.get(keyName);
    if (cached) return cached;

    // Try to get key from ColumnEncryption instance
    if (this.encryption && typeof this.encryption.getKey === 'function') {
      const key = this.encryption.getKey(keyName);
      if (key) {
        this.keyCache.set(keyName, key);
        return key;
      }
    }

    // Derive key from master key using HKDF-like derivation
    const derived = crypto.createHmac('sha256', this.masterKey)
      .update(keyName)
      .digest()
      .subarray(0, 32);

    this.keyCache.set(keyName, derived);
    return derived;
  }

  /**
   * Ensure an encryption key exists in ColumnEncryption.
   */
  private ensureEncryptionKey(keyName: string): void {
    if (this.encryption && typeof this.encryption.createColumnEncryptionKey === 'function') {
      try {
        this.encryption.createColumnEncryptionKey(keyName);
      } catch {
        // Key may already exist — that's fine
      }
    }
  }

  /**
   * Make an encrypt() function call expression.
   */
  private makeEncryptCall(value: string, keyName: string): string {
    return `encrypt(${value}, '${keyName}')`;
  }

  /**
   * Make a decrypt() function call expression.
   */
  private makeDecryptCall(column: string, keyName: string): string {
    return `decrypt(${column}, '${keyName}')`;
  }

  /**
   * Make a hash() function call expression for deterministic equality lookup.
   */
  private makeHashCall(value: string): string {
    return `sha256(${value})`;
  }

  // ── SQL construction ───────────────────────────────────────────────────

  /**
   * Build an INSERT SQL string from components.
   */
  private buildInsert(table: string, columns: string[], values: string[]): string {
    const colList = columns.join(', ');
    const valList = values.join(', ');
    return `INSERT INTO ${table} (${colList}) VALUES (${valList})`;
  }

  // ── Utility ────────────────────────────────────────────────────────────

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
