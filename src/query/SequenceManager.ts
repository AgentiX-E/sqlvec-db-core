/**
 * SequenceManager — PostgreSQL SEQUENCE management for SQLVec.
 *
 * Provides CREATE SEQUENCE, DROP SEQUENCE, ALTER SEQUENCE, nextval/currval/setval
 * via the _sqlvec_sequences table.
 *
 * Schema:
 *   _sqlvec_sequences (
 *     name TEXT PRIMARY KEY,
 *     last_value BIGINT NOT NULL DEFAULT 0,
 *     increment BIGINT NOT NULL DEFAULT 1,
 *     min_value BIGINT NOT NULL DEFAULT 1,
 *     max_value BIGINT,
 *     start_value BIGINT NOT NULL DEFAULT 1,
 *     cache_size BIGINT NOT NULL DEFAULT 1,
 *     is_cycling BOOLEAN NOT NULL DEFAULT 0
 *   )
 */

import Database from 'better-sqlite3';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('SequenceManager');

// ── Types ────────────────────────────────────────────────────────

export interface SequenceDef {
  name: string;
  lastValue: number;
  increment: number;
  minValue: number;
  maxValue: number | null;
  startValue: number;
  cacheSize: number;
  isCycling: boolean;
}

export interface SequenceManagerOptions {
  /** Default cache size for sequences */
  defaultCacheSize: number;
}

const DEFAULT_OPTIONS: SequenceManagerOptions = {
  defaultCacheSize: 1,
};

// ── SQL Constants ────────────────────────────────────────────────

const SEQUENCES_TABLE = '_sqlvec_sequences';

const CREATE_SEQUENCES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${SEQUENCES_TABLE} (
    name TEXT PRIMARY KEY,
    last_value BIGINT NOT NULL DEFAULT 0,
    increment BIGINT NOT NULL DEFAULT 1,
    min_value BIGINT NOT NULL DEFAULT 1,
    max_value BIGINT,
    start_value BIGINT NOT NULL DEFAULT 1,
    cache_size BIGINT NOT NULL DEFAULT 1,
    is_cycling INTEGER NOT NULL DEFAULT 0
  )
`;

// ── SequenceManager ──────────────────────────────────────────────

export class SequenceManager {
  private db: Database.Database;
  private options: SequenceManagerOptions;

  constructor(db: Database.Database, options?: Partial<SequenceManagerOptions>) {
    this.db = db;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(CREATE_SEQUENCES_TABLE_SQL);
  }

  /**
   * Parse a CREATE SEQUENCE statement and execute it.
   *
   * Supported syntax:
   *   CREATE SEQUENCE [IF NOT EXISTS] name
   *     [AS {SMALLINT|INT|BIGINT}]
   *     [INCREMENT [BY] inc]
   *     [MINVALUE min | NO MINVALUE]
   *     [MAXVALUE max | NO MAXVALUE]
   *     [START [WITH] start]
   *     [CACHE cache]
   *     [CYCLE | NO CYCLE]
   *
   * @param sql - The CREATE SEQUENCE SQL
   * @returns The created sequence definition
   */
  createSequence(sql: string): SequenceDef {
    const trimmed = sql.trim();
    const match = /^\s*CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)(.*)$/i.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid CREATE SEQUENCE: ${trimmed}`);
    }

    const name = match[1].replace(/["`]/g, '');
    const opts = match[2].trim();

    // Parse options
    const increment = this.extractNumericOpt(opts, /INCREMENT\s+(?:BY\s+)?([-+]?\d+)/i, 1);
    const minValue = this.extractOpt(opts, /MINVALUE\s+([-+]?\d+)/i);
    const noMinValue = /\bNO\s+MINVALUE\b/i.test(opts);
    const maxValue = this.extractOpt(opts, /MAXVALUE\s+([-+]?\d+)/i);
    const noMaxValue = /\bNO\s+MAXVALUE\b/i.test(opts);
    const startValue = this.extractNumericOpt(opts, /START\s+(?:WITH\s+)?([-+]?\d+)/i, 1);
    const cacheSize = this.extractNumericOpt(opts, /CACHE\s+(\d+)/i, this.options.defaultCacheSize);
    const isCycling = /\bCYCLE\b/i.test(opts) && !/\bNO\s+CYCLE\b/i.test(opts);

    // Determine min/max based on increment direction
    const inc = increment;
    const min = noMinValue ? (inc > 0 ? 1 : -(2 ** 63)) : (minValue !== null ? parseInt(minValue, 10) : (inc > 0 ? 1 : -(2 ** 63)));
    const max = noMaxValue ? (inc > 0 ? 2 ** 63 - 1 : -1) : (maxValue !== null ? parseInt(maxValue, 10) : (inc > 0 ? 2 ** 63 - 1 : -1));

    // Determine if sequence already exists
    const existing = this.db.prepare(
      `SELECT name FROM ${SEQUENCES_TABLE} WHERE name = ?`,
    ).get(name) as { name: string } | undefined;

    if (existing) {
      if (/IF\s+NOT\s+EXISTS/i.test(trimmed)) {
        logger.warn({ sequence: name }, 'CREATE SEQUENCE IF NOT EXISTS: sequence already exists, skipping');
        return this.getSequenceDef(name)!;
      }
      throw new Error(`Sequence "${name}" already exists`);
    }

    // Calculate initial last_value: start_value - increment (so nextval returns start_value)
    const initialLast = startValue - inc;

    const stmt = this.db.prepare(`
      INSERT INTO ${SEQUENCES_TABLE} (name, last_value, increment, min_value, max_value, start_value, cache_size, is_cycling)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(name, initialLast, inc, min, max, startValue, cacheSize, isCycling ? 1 : 0);

    logger.info({ sequence: name, start: startValue, inc, cache: cacheSize }, 'Sequence created');

    return {
      name,
      lastValue: initialLast,
      increment: inc,
      minValue: min,
      maxValue: max,
      startValue,
      cacheSize,
      isCycling,
    };
  }

  /**
   * Drop a sequence.
   *
   * @param sql - DROP SEQUENCE [IF EXISTS] name
   */
  dropSequence(sql: string): boolean {
    const trimmed = sql.trim();
    const match = /^\s*DROP\s+SEQUENCE\s+(?:IF\s+EXISTS\s+)?(\S+)/i.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid DROP SEQUENCE: ${trimmed}`);
    }

    const name = match[1].replace(/["`]/g, '');
    const result = this.db.prepare(
      `DELETE FROM ${SEQUENCES_TABLE} WHERE name = ?`,
    ).run(name);

    if (result.changes === 0 && !/IF\s+EXISTS/i.test(trimmed)) {
      throw new Error(`Sequence "${name}" does not exist`);
    }

    logger.info({ sequence: name }, 'Sequence dropped');
    return result.changes > 0;
  }

  /**
   * Get the next value from a sequence.
   *
   * @param sequenceName - Sequence name (optionally quoted as 'seqname'::regclass)
   * @returns Next integer value
   */
  nextVal(sequenceName: string): number {
    const name = this.resolveSequenceName(sequenceName);

    // Atomic update using SQLite
    const result = this.db.transaction(() => {
      const seq = this.getSequenceDef(name, true);
      if (!seq) {
        throw new Error(`Sequence "${name}" does not exist`);
      }

      let nextValue = seq.lastValue + seq.increment;

      // Boundary check must be direction-aware: an ascending sequence can only
      // exceed its upper bound, and a descending sequence can only fall below
      // its lower bound. Checking both bounds unconditionally breaks descending
      // sequences — their default maxValue is -1 (matching PostgreSQL), so any
      // legitimate produced value (10, 9, ...) was wrongly reported as having
      // exceeded the maximum on the very first nextval.
      if (seq.increment > 0) {
        if (seq.maxValue !== null && nextValue > seq.maxValue) {
          if (seq.isCycling) {
            nextValue = seq.minValue;
          } else {
            throw new Error(`nextval: reached maximum value of sequence "${name}" (${seq.maxValue})`);
          }
        }
      } else {
        if (nextValue < seq.minValue) {
          if (seq.isCycling && seq.maxValue !== null) {
            nextValue = seq.maxValue;
          } else if (seq.isCycling) {
            nextValue = seq.minValue;
          } else {
            throw new Error(`nextval: reached minimum value of sequence "${name}" (${seq.minValue})`);
          }
        }
      }

      this.db.prepare(
        `UPDATE ${SEQUENCES_TABLE} SET last_value = ? WHERE name = ?`,
      ).run(nextValue, name);

      return nextValue;
    })();

    logger.debug({ sequence: name, value: result }, 'nextval');
    return result;
  }

  /**
   * Get the current value of a sequence (last value returned by nextval).
   *
   * @param sequenceName - Sequence name
   * @returns Current value, or throws if sequence doesn't exist
   */
  currVal(sequenceName: string): number {
    const name = this.resolveSequenceName(sequenceName);
    const seq = this.getSequenceDef(name, true)!;
    return seq.lastValue;
  }

  /**
   * Set a sequence to a specific value.
   *
   * @param sequenceName - Sequence name
   * @param value - New value (setval will set last_value so the next nextval returns this value - increment)
   * @param isCalled - If true, last_value is set to `value` so the next nextval
   *                   returns `value + increment`; if false, last_value is set to
   *                   `value - increment` so the next nextval returns `value`.
   * @returns The `value` argument (matching PostgreSQL's setval, which returns
   *          the value it was given regardless of `isCalled`).
   */
  setVal(sequenceName: string, value: number, isCalled: boolean = true): number {
    const name = this.resolveSequenceName(sequenceName);

    this.db.transaction(() => {
      const seq = this.getSequenceDef(name, true)!;
      // If isCalled=false, set last_value = value - increment so nextval returns value
      // If isCalled=true, set last_value = value so nextval returns value + increment
      const lastValue = isCalled ? value : value - seq.increment;
      this.db.prepare(
        `UPDATE ${SEQUENCES_TABLE} SET last_value = ? WHERE name = ?`,
      ).run(lastValue, name);
    })();

    logger.info({ sequence: name, value, isCalled }, 'setval');
    return value;
  }

  /**
   * Get sequence definition.
   */
  getSequenceDef(name: string, required: boolean = false): SequenceDef | null {
    const row = this.db.prepare(
      `SELECT name, last_value, increment, min_value, max_value, start_value, cache_size, is_cycling FROM ${SEQUENCES_TABLE} WHERE name = ?`,
    ).get(name) as any;

    if (!row) {
      if (required) throw new Error(`Sequence "${name}" does not exist`);
      return null;
    }

    return {
      name: row.name,
      lastValue: row.last_value,
      increment: row.increment,
      minValue: row.min_value,
      maxValue: row.max_value,
      startValue: row.start_value,
      cacheSize: row.cache_size,
      isCycling: row.is_cycling === 1,
    };
  }

  /**
   * Parse an ALTER SEQUENCE statement.
   */
  alterSequence(sql: string): SequenceDef {
    const trimmed = sql.trim();
    const match = /^\s*ALTER\s+SEQUENCE\s+(?:IF\s+EXISTS\s+)?(\S+)(.*)$/i.exec(trimmed);
    if (!match) throw new Error(`Invalid ALTER SEQUENCE: ${trimmed}`);

    const name = match[1].replace(/["`]/g, '');
    const opts = match[2].trim();

    const current = this.getSequenceDef(name, true)!;
    const changes: string[] = [];

    const newIncrement = this.extractOpt(opts, /INCREMENT\s+(?:BY\s+)?([-+]?\d+)/i);
    const newMin = this.extractOpt(opts, /MINVALUE\s+([-+]?\d+)/i);
    const newMax = this.extractOpt(opts, /MAXVALUE\s+([-+]?\d+)/i);
    const hasNoMin = /\bNO\s+MINVALUE\b/i.test(opts);
    const hasNoMax = /\bNO\s+MAXVALUE\b/i.test(opts);
    const newCache = this.extractOpt(opts, /CACHE\s+(\d+)/i);
    const hasBareRestart = /\bRESTART\b/i.test(opts) && !/RESTART\s+WITH\s+[-+]?\d+/i.test(opts);
    const newRestart = this.extractOpt(opts, /RESTART\s+(?:WITH\s+)?([-+]?\d+)/i);
    const isCycling = /\b(?:CYCLE|NO\s+CYCLE)\b/i.test(opts);

    const updateParts: string[] = [];

    if (newIncrement !== null) {
      updateParts.push(`increment = ${parseInt(newIncrement, 10)}`);
      changes.push(`increment=${newIncrement}`);
    }
    if (newMin !== null) {
      updateParts.push(`min_value = ${parseInt(newMin, 10)}`);
      changes.push(`min=${newMin}`);
    }
    if (hasNoMin) {
      const val = current.increment > 0 ? 1 : -(2 ** 63);
      updateParts.push(`min_value = ${val}`);
      changes.push(`min=NO MINVALUE`);
    }
    if (newMax !== null) {
      updateParts.push(`max_value = ${parseInt(newMax, 10)}`);
      changes.push(`max=${newMax}`);
    }
    if (hasNoMax) {
      const val = current.increment > 0 ? 2 ** 63 - 1 : -1;
      updateParts.push(`max_value = ${val}`);
      changes.push(`max=NO MAXVALUE`);
    }
    if (newCache !== null) {
      updateParts.push(`cache_size = ${parseInt(newCache, 10)}`);
      changes.push(`cache=${newCache}`);
    }
    if (isCycling) {
      const cycle = /\bCYCLE\b/i.test(opts) && !/\bNO\s+CYCLE\b/i.test(opts) ? 1 : 0;
      updateParts.push(`is_cycling = ${cycle}`);
      changes.push(`cycle=${cycle}`);
    }
    if (hasBareRestart) {
      // RESTART without WITH value: reset to start_value
      const newLastValue = current.startValue - current.increment;
      updateParts.push(`last_value = ${newLastValue}`);
      changes.push('restart');
    } else if (newRestart !== null) {
      const restartVal = parseInt(newRestart, 10);
      const newLastValue = restartVal - current.increment;
      updateParts.push(`last_value = ${newLastValue}, start_value = ${restartVal}`);
      changes.push(`restart=${restartVal}`);
    }

    if (updateParts.length > 0) {
      this.db.prepare(
        `UPDATE ${SEQUENCES_TABLE} SET ${updateParts.join(', ')} WHERE name = ?`,
      ).run(name);
    }

    logger.info({ sequence: name, changes: changes.join(', ') }, 'Sequence altered');
    return this.getSequenceDef(name, true)!;
  }

  /**
   * List all sequences.
   */
  listSequences(): SequenceDef[] {
    const rows = this.db.prepare(
      `SELECT name, last_value, increment, min_value, max_value, start_value, cache_size, is_cycling FROM ${SEQUENCES_TABLE} ORDER BY name`,
    ).all() as any[];

    return rows.map((row) => ({
      name: row.name,
      lastValue: row.last_value,
      increment: row.increment,
      minValue: row.min_value,
      maxValue: row.max_value,
      startValue: row.start_value,
      cacheSize: row.cache_size,
      isCycling: row.is_cycling === 1,
    }));
  }

  // ── Private Helpers ────────────────────────────────────────────

  private resolveSequenceName(input: string): string {
    // Handle 'name'::regclass or "name" patterns
    let clean = input.trim();
    clean = clean.replace(/'[^']*'::regclass/g, (m) => m.slice(1, m.indexOf("'::")));
    clean = clean.replace(/::regclass/gi, '');
    clean = clean.replace(/["`]/g, '');
    return clean.trim();
  }

  private extractNumericOpt(text: string, re: RegExp, defaultVal: number): number {
    const match = re.exec(text);
    return match ? parseInt(match[1], 10) : defaultVal;
  }

  private extractOpt(text: string, re: RegExp): string | null {
    const match = re.exec(text);
    return match ? match[1] : null;
  }

  // ── IDENTITY Columns ─────────────────────────

  /** System table name for identity column metadata */
  private static readonly IDENTITY_COLUMNS_TABLE = '_sqlvec_identity_columns';

  private static readonly CREATE_IDENTITY_COLUMNS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS _sqlvec_identity_columns (
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      sequence_name TEXT NOT NULL,
      always INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (table_name, column_name)
    )
  `;

  private ensureIdentityColumnsTable(): void {
    this.db.exec(SequenceManager.CREATE_IDENTITY_COLUMNS_TABLE_SQL);
  }

  /**
   * Parse a GENERATED {ALWAYS|BY DEFAULT} AS IDENTITY column definition.
   *
   * Format:
   *   col_name data_type GENERATED {ALWAYS|BY DEFAULT} AS IDENTITY
   *     [ ( sequence_options ) ]
   *
   * @param colType - The column type definition string (e.g. "INTEGER GENERATED ALWAYS AS IDENTITY")
   * @returns Parsed identity info or null
   */
  parseIdentityColumn(colType: string): {
    always: boolean;
    sequenceOptions?: string;
  } | null {
    const trimmed = colType.trim();
    const match = /^\s*(\w+(?:\s*\([^)]*\))?)\s+GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\s*(?:\(\s*(.*?)\s*\))?\s*$/i.exec(trimmed);
    if (!match) return null;

    return {
      always: match[2].toUpperCase() === 'ALWAYS',
      sequenceOptions: match[3] ? match[3].trim() : undefined,
    };
  }

  /**
   * Register identity column metadata in the tracking table.
   */
  private registerIdentityColumn(
    tableName: string,
    columnName: string,
    sequenceName: string,
    always: boolean,
  ): void {
    this.ensureIdentityColumnsTable();
    this.db.prepare(`
      INSERT OR REPLACE INTO _sqlvec_identity_columns (table_name, column_name, sequence_name, always)
      VALUES (?, ?, ?, ?)
    `).run(tableName, columnName, sequenceName, always ? 1 : 0);
  }

  /**
   * Unregister identity column metadata.
   */
  private unregisterIdentityColumn(tableName: string, columnName: string): boolean {
    this.ensureIdentityColumnsTable();
    const result = this.db.prepare(
      `DELETE FROM _sqlvec_identity_columns WHERE table_name = ? AND column_name = ?`,
    ).run(tableName, columnName);
    return result.changes > 0;
  }

  /**
   * Get identity column info for a specific table column.
   */
  getIdentityColumnInfo(tableName: string, columnName: string): {
    tableName: string;
    columnName: string;
    sequenceName: string;
    always: boolean;
  } | null {
    this.ensureIdentityColumnsTable();
    const row = this.db.prepare(
      `SELECT table_name, column_name, sequence_name, always FROM _sqlvec_identity_columns WHERE table_name = ? AND column_name = ?`,
    ).get(tableName, columnName) as any;

    if (!row) return null;
    return {
      tableName: row.table_name,
      columnName: row.column_name,
      sequenceName: row.sequence_name,
      always: row.always === 1,
    };
  }

  /**
   * List all identity columns for a table.
   */
  listIdentityColumns(tableName: string): Array<{
    columnName: string;
    sequenceName: string;
    always: boolean;
  }> {
    this.ensureIdentityColumnsTable();
    const rows = this.db.prepare(
      `SELECT column_name, sequence_name, always FROM _sqlvec_identity_columns WHERE table_name = ? ORDER BY column_name`,
    ).all(tableName) as any[];

    return rows.map((r) => ({
      columnName: r.column_name,
      sequenceName: r.sequence_name,
      always: r.always === 1,
    }));
  }

  /**
   * Build the auto-generated sequence name for an identity column.
   */
  static buildIdentitySequenceName(tableName: string, columnName: string): string {
    return `${tableName}_${columnName}_seq`.replace(/["`]/g, '').toLowerCase();
  }

  /**
   * Create a sequence for an IDENTITY column and register metadata.
   * Returns the auto-generated sequence name (table_col_seq).
   *
   * @param tableName - The table name (unquoted)
   * @param columnName - The column name (unquoted)
   * @param identityInfo - Parsed identity info
   * @returns The sequence name
   */
  createIdentitySequence(
    tableName: string,
    columnName: string,
    identityInfo: { always: boolean; sequenceOptions?: string },
  ): string {
    this.ensureIdentityColumnsTable();
    const seqName = SequenceManager.buildIdentitySequenceName(tableName, columnName);

    // Check if already registered
    const existingReg = this.getIdentityColumnInfo(tableName, columnName);
    if (existingReg) return existingReg.sequenceName;

    // Build CREATE SEQUENCE SQL
    let seqSql = `CREATE SEQUENCE ${seqName}`;
    if (identityInfo.sequenceOptions) {
      seqSql += ` ${identityInfo.sequenceOptions}`;
    }

    this.createSequence(seqSql);

    // Register identity metadata
    this.registerIdentityColumn(tableName, columnName, seqName, identityInfo.always);
    logger.info(
      { tableName, columnName, seqName, always: identityInfo.always },
      'Identity sequence created',
    );

    return seqName;
  }

  /**
   * Get the next value from an identity sequence.
   *
   * @param tableName - Table name
   * @param columnName - Column name
   * @returns Next sequence value
   */
  nextIdentityVal(tableName: string, columnName: string): number {
    const seqName = SequenceManager.buildIdentitySequenceName(tableName, columnName);
    return this.nextVal(`'${seqName}'::regclass`);
  }

  /**
   * Validate an INSERT value for an IDENTITY column.
   *
   * @param identityInfo - The identity column info
   * @param explicitValue - The value being inserted for this column (undefined if not in INSERT)
   * @throws Error if GENERATED ALWAYS and an explicit value is provided (without OVERRIDING)
   */
  validateIdentityInsert(
    identityInfo: { always: boolean },
    explicitValue: any,
  ): void {
    if (identityInfo.always && explicitValue !== undefined && explicitValue !== null && explicitValue !== DEFAULT_PLACEHOLDER) {
      throw new Error(
        `Cannot insert explicit value for GENERATED ALWAYS AS IDENTITY column. ` +
        `Use OVERRIDING SYSTEM VALUE or use GENERATED BY DEFAULT AS IDENTITY.`,
      );
    }
  }

  /**
   * Parse OVERRIDING clause from an INSERT statement.
   *
   * @param sql - INSERT SQL text
   * @returns Parsed overriding info
   */
  parseInsertOverriding(sql: string): {
    overridden: boolean;
    kind: 'NONE' | 'SYSTEM' | 'USER';
    cleanSql: string;
  } {
    const trimmed = sql.trim();

    // Match: OVERRIDING {SYSTEM|USER} VALUE at the end (before VALUES or after table name)
    let cleanSql = trimmed;
    let kind: 'NONE' | 'SYSTEM' | 'USER' = 'NONE';

    // Try multiple patterns: before the VALUES clause or after the table name
    const patterns: Array<{ re: RegExp; kindIdx: number }> = [
      // After table name: INSERT INTO t OVERRIDING SYSTEM VALUE (col) VALUES (...)
      { re: /(INSERT\s+(?:INTO\s+)?\S+)\s+OVERRIDING\s+(SYSTEM|USER)\s+VALUE\s*(\()/i, kindIdx: 2 },
      // Before VALUES: INSERT INTO t (col) OVERRIDING SYSTEM VALUE VALUES (...)
      { re: /\s+OVERRIDING\s+(SYSTEM|USER)\s+VALUE\s+VALUE/i, kindIdx: 1 },
      // At end: INSERT INTO t (col) VALUES (...) OVERRIDING SYSTEM VALUE
      { re: /\s+OVERRIDING\s+(SYSTEM|USER)\s+VALUE\s*$/i, kindIdx: 1 },
    ];

    for (const { re, kindIdx } of patterns) {
      const m = re.exec(cleanSql);
      if (m) {
        const kindStr = m[kindIdx].toUpperCase();
        kind = kindStr === 'SYSTEM' ? 'SYSTEM' : 'USER';
        cleanSql = cleanSql.replace(
          new RegExp(`\\s+OVERRIDING\\s+${kindStr}\\s+VALUE`, 'i'),
          '',
        );
        break;
      }
    }

    return { overridden: kind !== 'NONE', kind, cleanSql };
  }

  /**
   * Rewrite an INSERT statement to handle IDENTITY columns properly.
   *
   * For GENERATED ALWAYS:
   *   - Without OVERRIDING: reject explicit values
   *   - With OVERRIDING SYSTEM VALUE: allow explicit values
   *
   * For GENERATED BY DEFAULT:
   *   - Without OVERRIDING: allow explicit values (user overrides)
   *   - With OVERRIDING USER VALUE: replace user values with nextval
   *
   * @param sql - The INSERT SQL
   * @param tableName - Table name
   * @returns Rewritten SQL and a map of identity column -> generated value
   */
  rewriteIdentityInsert(
    sql: string,
    tableName: string,
  ): { sql: string; identityValues: Map<string, number> } {
    const identityValues = new Map<string, number>();
    const identityCols = this.listIdentityColumns(tableName);
    if (identityCols.length === 0) {
      return { sql, identityValues };
    }

    // Parse OVERRIDING clause
    const { kind, cleanSql } = this.parseInsertOverriding(sql);
    let rewritten = cleanSql;

    // Parse INSERT to find column list and VALUES
    // Pattern: INSERT INTO table (col1, col2, ...) VALUES (val1, val2, ...)
    const insertMatch = rewritten.match(
      /^\s*INSERT\s+(?:INTO\s+)?\S+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*;?\s*$/i,
    );

    if (!insertMatch) {
      // INSERT without explicit column list or VALUES
      return { sql: rewritten, identityValues };
    }

    const columns = insertMatch[1].split(',').map((c) => c.trim());
    const values = insertMatch[2].split(',').map((v) => v.trim());

    // Build identity column lookup by name
    const identitySet = new Set(identityCols.map((ic) => ic.columnName.toLowerCase()));

    // Process each column
    const newColumns: string[] = [];
    const newValues: string[] = [];

    for (let i = 0; i < columns.length; i++) {
      const colName = columns[i].replace(/["`]/g, '');
      const colLower = colName.toLowerCase();
      const identInfo = identityCols.find((ic) => ic.columnName.toLowerCase() === colLower);

      if (!identInfo) {
        // Non-identity column — pass through
        newColumns.push(columns[i]);
        newValues.push(values[i]);
        continue;
      }

      const hasExplicitValue = values[i].toUpperCase() !== 'DEFAULT';

      if (identInfo.always) {
        // GENERATED ALWAYS
        if (kind === 'SYSTEM') {
          // OVERRIDING SYSTEM VALUE: user provides the value
          newColumns.push(columns[i]);
          newValues.push(values[i]);
          identityValues.set(colName, Number(values[i]));
        } else if (hasExplicitValue) {
          throw new Error(
            `Cannot insert explicit value for GENERATED ALWAYS AS IDENTITY column "${colName}" ` +
            `without OVERRIDING SYSTEM VALUE.`,
          );
        } else {
          // DEFAULT keyword — generate nextval
          const nextVal = this.nextIdentityVal(tableName, colName);
          newColumns.push(columns[i]);
          newValues.push(String(nextVal));
          identityValues.set(colName, nextVal);
        }
      } else {
        // GENERATED BY DEFAULT
        if (kind === 'USER') {
          // OVERRIDING USER VALUE: ignore user value, use nextval
          const nextVal = this.nextIdentityVal(tableName, colName);
          newValues.push(String(nextVal));
          newColumns.push(columns[i]);
          identityValues.set(colName, nextVal);
        } else if (hasExplicitValue) {
          // User provides the value — allowed
          newColumns.push(columns[i]);
          newValues.push(values[i]);
          identityValues.set(colName, Number(values[i]));
        } else {
          // DEFAULT keyword — generate nextval
          const nextVal = this.nextIdentityVal(tableName, colName);
          newColumns.push(columns[i]);
          newValues.push(String(nextVal));
          identityValues.set(colName, nextVal);
        }
      }
    }

    // Rebuild SQL
    const tableNameInSql = (sql.match(/INSERT\s+(?:INTO\s+)?(\S+)/i) || [])[1] || tableName;
    rewritten = `INSERT INTO ${tableNameInSql} (${newColumns.join(', ')}) VALUES (${newValues.join(', ')})`;

    return { sql: rewritten, identityValues };
  }

  /**
   * Alter an identity column.
   *
   * Supported actions:
   *   - SET GENERATED {ALWAYS | BY DEFAULT}
   *   - RESTART [WITH restart_value]
   *   - SET START WITH start_value
   *   - SET INCREMENT BY increment
   *   - SET MAXVALUE max | NO MAXVALUE
   *   - SET MINVALUE min | NO MINVALUE
   *   - SET CACHE cache
   *   - SET CYCLE | SET NO CYCLE
   *
   * @param tableName - Table name
   * @param columnName - Column name
   * @param action - The ALTER action SQL fragment (e.g. 'RESTART WITH 100', 'SET GENERATED BY DEFAULT')
   * @returns Updated identity column info
   */
  alterIdentityColumn(
    tableName: string,
    columnName: string,
    action: string,
  ): { tableName: string; columnName: string; sequenceName: string; always: boolean } {
    const info = this.getIdentityColumnInfo(tableName, columnName);
    if (!info) {
      throw new Error(
        `Column "${columnName}" of table "${tableName}" is not an identity column`,
      );
    }

    const trimmedAction = action.trim().toUpperCase();

    // SET GENERATED {ALWAYS | BY DEFAULT}
    const setGeneratedMatch = /^SET\s+GENERATED\s+(ALWAYS|BY\s+DEFAULT)$/i.exec(trimmedAction);
    if (setGeneratedMatch) {
      const newAlways = setGeneratedMatch[1].toUpperCase() === 'ALWAYS';
      this.db.prepare(
        `UPDATE _sqlvec_identity_columns SET always = ? WHERE table_name = ? AND column_name = ?`,
      ).run(newAlways ? 1 : 0, tableName, columnName);
      info.always = newAlways;
      logger.info(
        { tableName, columnName, always: newAlways },
        'Identity column GENERATED strategy changed',
      );
      return { ...info };
    }

    // RESTART [WITH restart_value]
    const restartMatch = /^RESTART(?:\s+WITH\s+(-?\d+))?$/i.exec(trimmedAction);
    if (restartMatch) {
      const restartVal = restartMatch[1] ? parseInt(restartMatch[1], 10) : undefined;
      const seqName = info.sequenceName;
      this.alterSequence(
        `ALTER SEQUENCE ${seqName} ${restartVal !== undefined ? `RESTART WITH ${restartVal}` : 'RESTART'}`,
      );
      logger.info(
        { tableName, columnName, seqName, restartVal },
        'Identity column sequence restarted',
      );
      return { ...info };
    }

    // SET START WITH start_value
    const startWithMatch = /^SET\s+START\s+WITH\s+(-?\d+)$/i.exec(trimmedAction);
    if (startWithMatch) {
      const startVal = parseInt(startWithMatch[1], 10);
      const seqName = info.sequenceName;
      // RESTART WITH sets the start value effectively
      this.alterSequence(`ALTER SEQUENCE ${seqName} RESTART WITH ${startVal}`);
      logger.info(
        { tableName, columnName, seqName, startVal },
        'Identity column start value changed',
      );
      return { ...info };
    }

    // SET INCREMENT BY increment
    const incMatch = /^SET\s+INCREMENT\s+(?:BY\s+)?(-?\d+)$/i.exec(trimmedAction);
    if (incMatch) {
      const inc = parseInt(incMatch[1], 10);
      const seqName = info.sequenceName;
      this.alterSequence(`ALTER SEQUENCE ${seqName} INCREMENT BY ${inc}`);
      logger.info(
        { tableName, columnName, seqName, inc },
        'Identity column increment changed',
      );
      return { ...info };
    }

    // SET MAXVALUE max | NO MAXVALUE
    const maxValMatch = /^SET\s+MAXVALUE\s+(-?\d+)$/i.exec(trimmedAction);
    if (maxValMatch) {
      const maxVal = parseInt(maxValMatch[1], 10);
      const seqName = info.sequenceName;
      this.alterSequence(`ALTER SEQUENCE ${seqName} MAXVALUE ${maxVal}`);
      logger.info({ tableName, columnName, seqName, maxVal }, 'Identity column maxvalue changed');
      return { ...info };
    }
    if (/^SET\s+NO\s+MAXVALUE$/i.test(trimmedAction)) {
      const seqName = info.sequenceName;
      this.alterSequence(`ALTER SEQUENCE ${seqName} NO MAXVALUE`);
      logger.info({ tableName, columnName, seqName }, 'Identity column maxvalue set to NO MAXVALUE');
      return { ...info };
    }

    // SET MINVALUE min | NO MINVALUE
    const minValMatch = /^SET\s+MINVALUE\s+(-?\d+)$/i.exec(trimmedAction);
    if (minValMatch) {
      const minVal = parseInt(minValMatch[1], 10);
      const seqName = info.sequenceName;
      this.alterSequence(`ALTER SEQUENCE ${seqName} MINVALUE ${minVal}`);
      logger.info({ tableName, columnName, seqName, minVal }, 'Identity column minvalue changed');
      return { ...info };
    }
    if (/^SET\s+NO\s+MINVALUE$/i.test(trimmedAction)) {
      const seqName = info.sequenceName;
      this.alterSequence(`ALTER SEQUENCE ${seqName} NO MINVALUE`);
      logger.info({ tableName, columnName, seqName }, 'Identity column minvalue set to NO MINVALUE');
      return { ...info };
    }

    // SET CACHE cache
    const cacheMatch = /^SET\s+CACHE\s+(\d+)$/i.exec(trimmedAction);
    if (cacheMatch) {
      const cache = parseInt(cacheMatch[1], 10);
      const seqName = info.sequenceName;
      this.alterSequence(`ALTER SEQUENCE ${seqName} CACHE ${cache}`);
      logger.info({ tableName, columnName, seqName, cache }, 'Identity column cache changed');
      return { ...info };
    }

    // SET CYCLE | SET NO CYCLE
    if (/^SET\s+CYCLE$/i.test(trimmedAction)) {
      const seqName = info.sequenceName;
      this.alterSequence(`ALTER SEQUENCE ${seqName} CYCLE`);
      logger.info({ tableName, columnName, seqName }, 'Identity column cycle enabled');
      return { ...info };
    }
    if (/^SET\s+NO\s+CYCLE$/i.test(trimmedAction)) {
      const seqName = info.sequenceName;
      this.alterSequence(`ALTER SEQUENCE ${seqName} NO CYCLE`);
      logger.info({ tableName, columnName, seqName }, 'Identity column cycle disabled');
      return { ...info };
    }

    throw new Error(`Unsupported ALTER IDENTITY action: "${action}"`);
  }

  /**
   * Drop the identity sequence and metadata for a column.
   *
   * @param tableName - Table name
   * @param columnName - Column name
   * @returns true if the identity was removed
   */
  dropIdentitySequence(tableName: string, columnName: string): boolean {
    const info = this.getIdentityColumnInfo(tableName, columnName);
    if (!info) return false;

    // Drop the sequence
    this.dropSequence(`DROP SEQUENCE IF EXISTS ${info.sequenceName}`);

    // Remove metadata
    this.unregisterIdentityColumn(tableName, columnName);

    logger.info({ tableName, columnName, seqName: info.sequenceName }, 'Identity sequence dropped');
    return true;
  }
}

/** Placeholder value for DEFAULT keyword */
export const DEFAULT_PLACEHOLDER = Symbol('DEFAULT');
