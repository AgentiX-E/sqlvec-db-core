/**
 * HttpfsStrategy — Layer 2: read Parquet via DuckDB httpfs extension
 *
 * DataBridge exports columnar data as Parquet to S3/MinIO periodically.
 * This strategy uses DuckDB's httpfs + parquet extensions to read them
 * with full column pruning and predicate pushdown.
 */
import type { DuckDBAnalyticsManager, DuckDBResult } from '../DuckDBAnalyticsManager';
import type { FederationStrategy, HttpfsConfig } from './FederationStrategy';

export class HttpfsStrategy implements FederationStrategy {
  readonly name = 'httpfs';
  readonly priority = 20;

  private initialized = false;
  private knownTables = new Set<string>();

  constructor(
    private readonly duckDB: DuckDBAnalyticsManager,
    private readonly config: HttpfsConfig,
  ) {}

  /** Ensure httpfs + parquet extensions are loaded and S3 credentials set */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.duckDB.execSQL('LOAD httpfs');
      console.debug('[HttpfsStrategy] LOAD httpfs OK');
    } catch {
      // httpfs might already be compiled in (DuckDB ≥ v0.10)
    }

    try {
      await this.duckDB.execSQL('LOAD parquet');
      console.debug('[HttpfsStrategy] LOAD parquet OK');
    } catch {
      // parquet might already be compiled in
    }

    await this.duckDB.execSQL(`SET s3_region='${this.config.region}'`);
    await this.duckDB.execSQL(`SET s3_access_key_id='${this.config.accessKey}'`);
    await this.duckDB.execSQL(`SET s3_secret_access_key='${this.config.secretKey}'`);
    if (this.config.s3Endpoint) {
      await this.duckDB.execSQL(`SET s3_endpoint='${this.config.s3Endpoint}'`);
    }

    this.initialized = true;
  }

  /** Check that the bucket/prefix is accessible */
  async available(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const healthPath = `${this.config.endpoint}/.analytics_health`;
      await this.duckDB.execute(`SELECT COUNT(*) FROM read_parquet('${healthPath}')`);
      return true;
    } catch {
      return false;
    }
  }

  /** Rewrite SQL table references to Parquet paths and execute */
  async execute(sql: string): Promise<DuckDBResult> {
    await this.ensureInitialized();
    const rewritten = this.rewriteTableRefs(sql);
    return this.duckDB.execute(rewritten);
  }

  /**
   * Register known OLAP tables so rewriteTableRefs can map them.
   * Called by AnalyticsFederationClient or externally.
   */
  registerTable(tableName: string): void {
    this.knownTables.add(tableName);
  }

  /**
   * Replace table-name references with read_parquet() calls.
   *
   * Simple heuristic: if a word after FROM/JOIN matches a registered
   * table, replace it with read_parquet('s3://.../*.parquet').
   *
   * For production use, use a proper SQL parser; this covers the
   * common TPC-H patterns.
   */
  private rewriteTableRefs(sql: string): string {
    let result = sql;
    for (const table of this.knownTables) {
      const path = `${this.config.endpoint}/${table}/*.parquet`;
      // Match: `from tableName` and `join tableName` (case-insensitive)
      const fromPattern = new RegExp(`\\bfrom\\s+["\`]?${table}["\`]?(\\s|$|\\()`, 'gi');
      const joinPattern = new RegExp(`\\bjoin\\s+["\`]?${table}["\`]?(\\s|$|\\()`, 'gi');
      result = result.replace(fromPattern, (match) =>
        match.replace(new RegExp(table, 'i'), `read_parquet('${path}') ${table}_p`),
      );
      result = result.replace(joinPattern, (match) =>
        match.replace(new RegExp(table, 'i'), `read_parquet('${path}') ${table}_p`),
      );
    }
    return result;
  }
}
