/**
 * LocalColumnarStrategy — Layer 0: always-available local strategy
 *
 * Executes queries directly against the local DuckDB column store tables.
 * No network, no shared storage, no dependencies.
 */
import type { DuckDBAnalyticsManager, DuckDBResult } from '../DuckDBAnalyticsManager';
import type { FederationStrategy } from './FederationStrategy';

export class LocalColumnarStrategy implements FederationStrategy {
  readonly name = 'local';
  readonly priority = 0;

  constructor(private readonly duckDB: DuckDBAnalyticsManager) {}

  /** Always available when DuckDB is available */
  async available(): Promise<boolean> {
    try {
      return this.duckDB.isAvailable;
    } catch {
      return false;
    }
  }

  /** Execute directly against local DuckDB */
  async execute(sql: string): Promise<DuckDBResult> {
    return this.duckDB.execute(sql);
  }
}
