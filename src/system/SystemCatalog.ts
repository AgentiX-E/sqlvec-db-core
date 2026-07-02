/**
 * SystemCatalog — information_schema runtime view support
 *
 * Provides static, in-memory rows for all standard information_schema views.
 * Tables report default metadata — no real storage queries performed.
 * Extend by adding table definitions to the tables map and registering
 * column metadata.
 */

import { SystemFunctionRegistry, getCurrentDbRef } from './SystemFunctions';

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface SystemViewRow {
  [column: string]: any;
}

export interface SystemViewColumn {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
  ordinalPosition: number;
  characterMaximumLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  comment: string | null;
}

export interface SystemViewDefinition {
  name: string;
  schema: string;
  type: 'BASE TABLE' | 'VIEW' | 'SYSTEM VIEW';
  columns: SystemViewColumn[];
  rows: SystemViewRow[];
}

export interface TableEntry {
  tableSchema: string;
  tableName: string;
  tableType: string;
  rowEstimate: number;
}

// ──────────────────────────────────────────────
//  Table metadata
// ──────────────────────────────────────────────

/** Default user tables that would exist in a typical database */
const DEFAULT_USER_TABLES: TableEntry[] = [
  { tableSchema: 'public', tableName: 'documents', tableType: 'BASE TABLE', rowEstimate: 0 },
  { tableSchema: 'public', tableName: 'vectors', tableType: 'BASE TABLE', rowEstimate: 0 },
  { tableSchema: 'public', tableName: 'embeddings', tableType: 'BASE TABLE', rowEstimate: 0 },
  { tableSchema: 'public', tableName: '__sqlvec_meta', tableType: 'SYSTEM TABLE', rowEstimate: 1 },
];

/** Information schema internal tables always visible */
const META_TABLES: TableEntry[] = [
  { tableSchema: 'information_schema', tableName: 'tables', tableType: 'SYSTEM VIEW', rowEstimate: 10 },
  { tableSchema: 'information_schema', tableName: 'columns', tableType: 'SYSTEM VIEW', rowEstimate: 50 },
  { tableSchema: 'information_schema', tableName: 'schemata', tableType: 'SYSTEM VIEW', rowEstimate: 3 },
  { tableSchema: 'information_schema', tableName: 'routines', tableType: 'SYSTEM VIEW', rowEstimate: 25 },
  { tableSchema: 'information_schema', tableName: 'views', tableType: 'SYSTEM VIEW', rowEstimate: 10 },
  { tableSchema: 'information_schema', tableName: 'sequences', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'information_schema', tableName: 'table_constraints', tableType: 'SYSTEM VIEW', rowEstimate: 10 },
  { tableSchema: 'information_schema', tableName: 'key_column_usage', tableType: 'SYSTEM VIEW', rowEstimate: 20 },
  { tableSchema: 'information_schema', tableName: 'check_constraints', tableType: 'SYSTEM VIEW', rowEstimate: 5 },
  { tableSchema: 'information_schema', tableName: 'referential_constraints', tableType: 'SYSTEM VIEW', rowEstimate: 5 },
  { tableSchema: 'information_schema', tableName: 'constraint_column_usage', tableType: 'SYSTEM VIEW', rowEstimate: 20 },
  { tableSchema: 'information_schema', tableName: 'table_privileges', tableType: 'SYSTEM VIEW', rowEstimate: 20 },
  { tableSchema: 'information_schema', tableName: 'role_table_grants', tableType: 'SYSTEM VIEW', rowEstimate: 20 },
  { tableSchema: 'information_schema', tableName: 'column_privileges', tableType: 'SYSTEM VIEW', rowEstimate: 50 },
  { tableSchema: 'information_schema', tableName: 'role_column_grants', tableType: 'SYSTEM VIEW', rowEstimate: 50 },
  { tableSchema: 'information_schema', tableName: 'domain_constraints', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'information_schema', tableName: 'column_domain_usage', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'information_schema', tableName: 'parameters', tableType: 'SYSTEM VIEW', rowEstimate: 30 },
  { tableSchema: 'information_schema', tableName: 'triggers', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'information_schema', tableName: 'domains', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'information_schema', tableName: 'usage_privileges', tableType: 'SYSTEM VIEW', rowEstimate: 3 },
  { tableSchema: 'information_schema', tableName: 'enabled_roles', tableType: 'SYSTEM VIEW', rowEstimate: 1 },
];

const PG_CATALOG_TABLES: TableEntry[] = [
  { tableSchema: 'pg_catalog', tableName: 'pg_class', tableType: 'SYSTEM TABLE', rowEstimate: 30 },
  { tableSchema: 'pg_catalog', tableName: 'pg_attribute', tableType: 'SYSTEM TABLE', rowEstimate: 150 },
  { tableSchema: 'pg_catalog', tableName: 'pg_type', tableType: 'SYSTEM TABLE', rowEstimate: 400 },
  { tableSchema: 'pg_catalog', tableName: 'pg_index', tableType: 'SYSTEM TABLE', rowEstimate: 10 },
  { tableSchema: 'pg_catalog', tableName: 'pg_proc', tableType: 'SYSTEM TABLE', rowEstimate: 200 },
  { tableSchema: 'pg_catalog', tableName: 'pg_namespace', tableType: 'SYSTEM TABLE', rowEstimate: 5 },
  { tableSchema: 'pg_catalog', tableName: 'pg_database', tableType: 'SYSTEM TABLE', rowEstimate: 1 },
  { tableSchema: 'pg_catalog', tableName: 'pg_tables', tableType: 'SYSTEM VIEW', rowEstimate: 10 },
  { tableSchema: 'pg_catalog', tableName: 'pg_indexes', tableType: 'SYSTEM VIEW', rowEstimate: 10 },
  { tableSchema: 'pg_catalog', tableName: 'pg_views', tableType: 'SYSTEM VIEW', rowEstimate: 10 },
  { tableSchema: 'pg_catalog', tableName: 'pg_settings', tableType: 'SYSTEM VIEW', rowEstimate: 200 },
  { tableSchema: 'pg_catalog', tableName: 'pg_stat_activity', tableType: 'SYSTEM VIEW', rowEstimate: 1 },
  { tableSchema: 'pg_catalog', tableName: 'pg_stat_user_tables', tableType: 'SYSTEM VIEW', rowEstimate: 5 },
  { tableSchema: 'pg_catalog', tableName: 'pg_stat_user_indexes', tableType: 'SYSTEM VIEW', rowEstimate: 5 },
  { tableSchema: 'pg_catalog', tableName: 'pg_attrdef', tableType: 'SYSTEM VIEW', rowEstimate: 5 },
  { tableSchema: 'pg_catalog', tableName: 'pg_sequences', tableType: 'SYSTEM VIEW', rowEstimate: 3 },
  { tableSchema: 'pg_catalog', tableName: 'pg_stat_database', tableType: 'SYSTEM VIEW', rowEstimate: 1 },
  { tableSchema: 'pg_catalog', tableName: 'pg_stat_all_indexes', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'pg_catalog', tableName: 'pg_statio_all_tables', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'pg_catalog', tableName: 'pg_statio_all_indexes', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'pg_catalog', tableName: 'pg_stat_user_functions', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'pg_catalog', tableName: 'pg_stat_xact_user_tables', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'pg_catalog', tableName: 'pg_stat_progress_vacuum', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'pg_catalog', tableName: 'pg_stat_progress_create_index', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
  { tableSchema: 'pg_catalog', tableName: 'pg_stat_progress_copy', tableType: 'SYSTEM VIEW', rowEstimate: 0 },
];

// ──────────────────────────────────────────────
//  SystemCatalog
// ──────────────────────────────────────────────

export class SystemCatalog {
  private static initialized = false;
  private static views: Map<string, SystemViewDefinition> = new Map();

  /** Override tables — allows callers to register real table metadata */
  static userTables: TableEntry[] = [...DEFAULT_USER_TABLES];

  /**
   * Initialize the system catalog with all view definitions.
   * Safe to call multiple times.
   */
  static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // ── information_schema.tables ──
    this.registerView('tables', 'information_schema', [
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: 'Database name' },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: 'Schema name' },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: 'Table name' },
      { columnName: 'table_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: 'Table type' },
      { columnName: 'self_referencing_column_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'reference_generation', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'user_defined_type_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'user_defined_type_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'user_defined_type_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 9, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_insertable_into', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 10, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_typed', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 11, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'commit_action', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 12, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => {
      const allTables = [...this.userTables, ...META_TABLES, ...PG_CATALOG_TABLES];
      return allTables.map(t => ({
        table_catalog: 'postgres',
        table_schema: t.tableSchema,
        table_name: t.tableName,
        table_type: t.tableType,
        self_referencing_column_name: null,
        reference_generation: null,
        user_defined_type_catalog: null,
        user_defined_type_schema: null,
        user_defined_type_name: null,
        is_insertable_into: t.tableType === 'BASE TABLE' ? 'YES' : 'NO',
        is_typed: 'NO',
        commit_action: null,
      }));
    });

    // ── information_schema.columns ──
    this.registerView('columns', 'information_schema', [
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'column_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'ordinal_position', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'column_default', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_nullable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'data_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'character_maximum_length', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 9, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'character_octet_length', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 10, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'numeric_precision', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 11, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'numeric_precision_radix', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 12, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'numeric_scale', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 13, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'datetime_precision', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 14, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => {
      return this.buildColumnRows();
    });

    // ── information_schema.schemata ──
    this.registerView('schemata', 'information_schema', [
      { columnName: 'catalog_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'schema_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'schema_owner', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'default_character_set_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'default_character_set_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'default_character_set_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'sql_path', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => [
      { catalog_name: 'postgres', schema_name: 'public', schema_owner: 'postgres', default_character_set_catalog: null, default_character_set_schema: null, default_character_set_name: 'UTF8', sql_path: null },
      { catalog_name: 'postgres', schema_name: 'information_schema', schema_owner: 'postgres', default_character_set_catalog: null, default_character_set_schema: null, default_character_set_name: 'UTF8', sql_path: null },
      { catalog_name: 'postgres', schema_name: 'pg_catalog', schema_owner: 'postgres', default_character_set_catalog: null, default_character_set_schema: null, default_character_set_name: 'UTF8', sql_path: null },
    ]);

    // ── information_schema.routines ──
    this.registerView('routines', 'information_schema', [
      { columnName: 'specific_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'specific_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'specific_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'routine_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'routine_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'routine_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'routine_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'data_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => {
      const functions = SystemFunctionRegistry.getAllFunctions();
      return functions.map((fn, idx) => ({
        specific_catalog: 'postgres',
        specific_schema: 'pg_catalog',
        specific_name: `${fn.name}_${idx}`,
        routine_catalog: 'postgres',
        routine_schema: 'pg_catalog',
        routine_name: fn.name,
        routine_type: 'FUNCTION',
        data_type: fn.returnType,
      }));
    });

    // ── information_schema.views ──
    this.registerView('views', 'information_schema', [
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'view_definition', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'check_option', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_updatable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_insertable_into', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_trigger_updatable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_trigger_deletable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 9, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_trigger_insertable_into', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 10, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => {
      return PG_CATALOG_TABLES
        .filter(t => t.tableType === 'SYSTEM VIEW')
        .map(t => ({
          table_catalog: 'postgres',
          table_schema: t.tableSchema,
          table_name: t.tableName,
          view_definition: `SELECT ... FROM information_schema.${t.tableName}`,
          check_option: 'NONE',
          is_updatable: 'NO',
          is_insertable_into: 'NO',
          is_trigger_updatable: 'NO',
          is_trigger_deletable: 'NO',
          is_trigger_insertable_into: 'NO',
        }));
    });

    // ── information_schema.sequences ──
    this.registerView('sequences', 'information_schema', [
      { columnName: 'sequence_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'sequence_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'sequence_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'data_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'numeric_precision', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'numeric_precision_radix', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'numeric_scale', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'start_value', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'minimum_value', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 9, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'maximum_value', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 10, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'increment', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 11, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'cycle_option', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 12, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []); // No sequences by default

    // ══════════════════════════════════════════════
    //  New information_schema views (Batch A)
    // ══════════════════════════════════════════════

    // ── information_schema.table_constraints ──
    this.registerView('table_constraints', 'information_schema', [
      { columnName: 'constraint_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_deferrable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'initially_deferred', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 9, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'enforced', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 10, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.key_column_usage ──
    this.registerView('key_column_usage', 'information_schema', [
      { columnName: 'constraint_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'column_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'ordinal_position', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'position_in_unique_constraint', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 9, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.check_constraints ──
    this.registerView('check_constraints', 'information_schema', [
      { columnName: 'constraint_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'check_clause', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.referential_constraints ──
    this.registerView('referential_constraints', 'information_schema', [
      { columnName: 'constraint_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'unique_constraint_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'unique_constraint_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'unique_constraint_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'match_option', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'update_rule', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'delete_rule', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 9, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'deferrable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 10, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'initially_deferred', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 11, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.constraint_column_usage ──
    this.registerView('constraint_column_usage', 'information_schema', [
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'column_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.table_privileges ──
    this.registerView('table_privileges', 'information_schema', [
      { columnName: 'grantor', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'grantee', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'privilege_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_grantable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'with_hierarchy', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.role_table_grants ──
    this.registerView('role_table_grants', 'information_schema', [
      { columnName: 'grantor', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'grantee', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'privilege_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_grantable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'with_hierarchy', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.column_privileges ──
    this.registerView('column_privileges', 'information_schema', [
      { columnName: 'grantor', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'grantee', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'column_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'privilege_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_grantable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.role_column_grants ──
    this.registerView('role_column_grants', 'information_schema', [
      { columnName: 'grantor', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'grantee', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'column_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'privilege_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_grantable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.domain_constraints ──
    this.registerView('domain_constraints', 'information_schema', [
      { columnName: 'constraint_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'constraint_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'domain_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'domain_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'domain_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_deferrable', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'initially_deferred', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.column_domain_usage ──
    this.registerView('column_domain_usage', 'information_schema', [
      { columnName: 'domain_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'domain_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'domain_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'table_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'column_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);

    // ── information_schema.parameters ──
    this.registerView('parameters', 'information_schema', [
      { columnName: 'specific_catalog', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 1, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'specific_schema', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 2, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'specific_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 3, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'ordinal_position', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 4, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'parameter_mode', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 5, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'is_result', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 6, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'as_locator', dataType: 'yes_or_no', isNullable: true, columnDefault: null, ordinalPosition: 7, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'parameter_name', dataType: 'sql_identifier', isNullable: true, columnDefault: null, ordinalPosition: 8, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'data_type', dataType: 'character_data', isNullable: true, columnDefault: null, ordinalPosition: 9, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'character_maximum_length', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 10, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'character_octet_length', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 11, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'numeric_precision', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 12, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'numeric_precision_radix', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 13, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
      { columnName: 'numeric_scale', dataType: 'cardinal_number', isNullable: true, columnDefault: null, ordinalPosition: 14, characterMaximumLength: null, numericPrecision: null, numericScale: null, comment: null },
    ], () => []);
  }

  /**
   * Register a system view.
   */
  private static registerView(
    name: string,
    schema: string,
    columns: SystemViewColumn[],
    rowGenerator: () => SystemViewRow[],
  ): void {
    const key = `${schema}.${name}`;
    this.views.set(key, {
      name,
      schema,
      type: 'SYSTEM VIEW',
      columns,
      rows: rowGenerator(),
    });
  }

  /**
   * Build column rows for all known tables.
   */
  private static buildColumnRows(): SystemViewRow[] {
    const rows: SystemViewRow[] = [];
    const allTableEntries = [...this.userTables, ...META_TABLES, ...PG_CATALOG_TABLES];

    for (const table of allTableEntries) {
      const view = this.views.get(`${table.tableSchema}.${table.tableName}`);
      if (view) {
        for (const col of view.columns) {
          rows.push({
            table_catalog: 'postgres',
            table_schema: col.columnName === 'table_schema' ? 'information_schema' : table.tableSchema,
            table_name: table.tableName,
            column_name: col.columnName,
            ordinal_position: col.ordinalPosition,
            column_default: col.columnDefault,
            is_nullable: col.isNullable ? 'YES' : 'NO',
            data_type: col.dataType,
            character_maximum_length: col.characterMaximumLength,
            character_octet_length: col.characterMaximumLength,
            numeric_precision: col.numericPrecision,
            numeric_precision_radix: 2,
            numeric_scale: col.numericScale,
            datetime_precision: null,
          });
        }
      }
    }

    // Add standard columns for BASE TABLEs (id, etc.)
    for (const table of allTableEntries) {
      if (table.tableType === 'BASE TABLE' && !this.views.has(`${table.tableSchema}.${table.tableName}`)) {
        // Add default columns for user tables
        const defaultCols = ['id', 'name', 'created_at', 'updated_at'];
        for (let i = 0; i < defaultCols.length; i++) {
          rows.push({
            table_catalog: 'postgres',
            table_schema: table.tableSchema,
            table_name: table.tableName,
            column_name: defaultCols[i],
            ordinal_position: i + 1,
            column_default: defaultCols[i] === 'created_at' ? "datetime('now')" : null,
            is_nullable: defaultCols[i] === 'id' ? 'NO' : 'YES',
            data_type: defaultCols[i] === 'id' ? 'integer' : 'text',
            character_maximum_length: null,
            character_octet_length: null,
            numeric_precision: defaultCols[i] === 'id' ? 32 : null,
            numeric_precision_radix: 2,
            numeric_scale: 0,
            datetime_precision: null,
          });
        }
      }
    }

    return rows;
  }

  // ──────────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────────

  /** Check if a qualified name corresponds to an information_schema view */
  static isSystemView(schema: string, name: string): boolean {
    this.init();
    return this.views.has(`${schema}.${name}`);
  }

  /** Check if a table name (without schema) matches a known system view */
  static isSystemViewByName(name: string): boolean {
    this.init();
    const lower = name.toLowerCase();
    for (const key of this.views.keys()) {
      if (key.endsWith(`.${lower}`)) return true;
    }
    return false;
  }

  /** Get a system view by schema + name */
  static getView(schema: string, name: string): SystemViewDefinition | undefined {
    this.init();
    return this.views.get(`${schema}.${name}`);
  }

  /** Get a system view by full name (e.g., "information_schema.tables") */
  static getViewByFullName(fullName: string): SystemViewDefinition | undefined {
    this.init();
    return this.views.get(fullName.toLowerCase());
  }

  /** Get all registered view names */
  static getViewNames(): string[] {
    this.init();
    return Array.from(this.views.keys());
  }

  /** Get rows for a specific system view */
  static getViewRows(schema: string, name: string): SystemViewRow[] {
    this.init();
    const view = this.views.get(`${schema}.${name}`);
    if (!view) return [];
    // Re-generate rows each time to get fresh data
    if (name === 'routines') {
      const functions = SystemFunctionRegistry.getAllFunctions();
      return functions.map((fn, idx) => ({
        specific_catalog: 'postgres',
        specific_schema: 'pg_catalog',
        specific_name: `${fn.name}_${idx}`,
        routine_catalog: 'postgres',
        routine_schema: 'pg_catalog',
        routine_name: fn.name,
        routine_type: 'FUNCTION',
        data_type: fn.returnType,
      }));
    }
    if (name === 'tables') {
      const allTables = [...this.userTables, ...META_TABLES, ...PG_CATALOG_TABLES];
      return allTables.map(t => ({
        table_catalog: 'postgres',
        table_schema: t.tableSchema,
        table_name: t.tableName,
        table_type: t.tableType,
        self_referencing_column_name: null,
        reference_generation: null,
        user_defined_type_catalog: null,
        user_defined_type_schema: null,
        user_defined_type_name: null,
        is_insertable_into: t.tableType === 'BASE TABLE' ? 'YES' : 'NO',
        is_typed: 'NO',
        commit_action: null,
      }));
    }
    if (name === 'views') {
      return PG_CATALOG_TABLES
        .filter(t => t.tableType === 'SYSTEM VIEW')
        .map(t => ({
          table_catalog: 'postgres',
          table_schema: t.tableSchema,
          table_name: t.tableName,
          view_definition: `SELECT ... FROM information_schema.${t.tableName}`,
          check_option: 'NONE',
          is_updatable: 'NO',
          is_insertable_into: 'NO',
          is_trigger_updatable: 'NO',
          is_trigger_deletable: 'NO',
          is_trigger_insertable_into: 'NO',
        }));
    }

    // ── Dynamic views (batch A) ──

    // information_schema.table_constraints
    if (name === 'table_constraints') {
      return this.generateTableConstraints();
    }

    // information_schema.key_column_usage
    if (name === 'key_column_usage') {
      return this.generateKeyColumnUsage();
    }

    // information_schema.check_constraints
    if (name === 'check_constraints') {
      return this.generateCheckConstraints();
    }

    // information_schema.referential_constraints
    if (name === 'referential_constraints') {
      return this.generateReferentialConstraints();
    }

    // information_schema.constraint_column_usage
    if (name === 'constraint_column_usage') {
      return this.generateConstraintColumnUsage();
    }

    // information_schema.table_privileges
    if (name === 'table_privileges') {
      return this.generateTablePrivileges();
    }

    // information_schema.role_table_grants
    if (name === 'role_table_grants') {
      return this.generateTablePrivileges(); // Same as table_privileges
    }

    // information_schema.column_privileges
    if (name === 'column_privileges') {
      return this.generateColumnPrivileges();
    }

    // information_schema.role_column_grants
    if (name === 'role_column_grants') {
      return this.generateColumnPrivileges(); // Same as column_privileges
    }

    // information_schema.domain_constraints — SQLite has no domains
    if (name === 'domain_constraints') {
      return [];
    }

    // information_schema.column_domain_usage — SQLite has no domains
    if (name === 'column_domain_usage') {
      return [];
    }

    // information_schema.parameters
    if (name === 'parameters') {
      return this.generateParameters();
    }

    return view.rows;
  }

  /** Add a user table dynamically */
  static addUserTable(schema: string, name: string, rowEstimate: number = 0): void {
    this.init();
    const existing = this.userTables.findIndex(
      t => t.tableSchema === schema && t.tableName === name,
    );
    if (existing >= 0) {
      this.userTables[existing].rowEstimate = rowEstimate;
    } else {
      this.userTables.push({ tableSchema: schema, tableName: name, tableType: 'BASE TABLE', rowEstimate });
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  Batch A: information_schema view generators
  // ════════════════════════════════════════════════════════════════

  /** Get user tables from the real database via currentDbRef. */
  private static getDbTables(): { name: string; sql: string | null }[] {
    const db = getCurrentDbRef();
    if (!db || !db.prepare) return [];
    try {
      return db.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      ).all() as { name: string; sql: string | null }[];
    } catch {
      return [];
    }
  }

  /** Generate information_schema.table_constraints rows from sqlite_master. */
  private static generateTableConstraints(): SystemViewRow[] {
    const rows: SystemViewRow[] = [];
    const db = getCurrentDbRef();
    if (!db || !db.prepare) return rows;

    const tables = this.getDbTables();
    for (const t of tables) {
      // PRIMARY KEY constraint
      rows.push({
        constraint_catalog: 'postgres', constraint_schema: 'public',
        constraint_name: `${t.name}_pkey`, table_catalog: 'postgres',
        table_schema: 'public', table_name: t.name,
        constraint_type: 'PRIMARY KEY', is_deferrable: 'NO',
        initially_deferred: 'NO', enforced: 'YES',
      });

      if (t.sql) {
        const sql = t.sql.toUpperCase();
        // UNIQUE constraint from DDL
        if (sql.includes('UNIQUE')) {
          rows.push({
            constraint_catalog: 'postgres', constraint_schema: 'public',
            constraint_name: `${t.name}_unique_key`, table_catalog: 'postgres',
            table_schema: 'public', table_name: t.name,
            constraint_type: 'UNIQUE', is_deferrable: 'NO',
            initially_deferred: 'NO', enforced: 'YES',
          });
        }
        // FOREIGN KEY constraint from DDL (inline REFERENCES or explicit FOREIGN KEY)
        if (sql.includes('FOREIGN KEY') || sql.includes('REFERENCES')) {
          rows.push({
            constraint_catalog: 'postgres', constraint_schema: 'public',
            constraint_name: `${t.name}_fk`, table_catalog: 'postgres',
            table_schema: 'public', table_name: t.name,
            constraint_type: 'FOREIGN KEY', is_deferrable: 'NO',
            initially_deferred: 'NO', enforced: 'YES',
          });
        }
        // CHECK constraint from DDL (parse CHECK clause)
        if (sql.includes('CHECK')) {
          const checkMatch = t.sql.match(/CHECK\s*\(([^)]+)\)/i);
          if (checkMatch) {
            rows.push({
              constraint_catalog: 'postgres', constraint_schema: 'public',
              constraint_name: `${t.name}_check`, table_catalog: 'postgres',
              table_schema: 'public', table_name: t.name,
              constraint_type: 'CHECK', is_deferrable: 'NO',
              initially_deferred: 'NO', enforced: 'YES',
            });
          }
        }
      }

      // UNIQUE INDEXes → UNIQUE constraints
      try {
        const indexes = db.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
        ).all(t.name) as { name: string; sql: string | null }[];
        for (const idx of indexes) {
          if (idx.sql && idx.sql.toUpperCase().includes('UNIQUE')) {
            // Avoid duplicate: check if _unique_key already added
            if (!t.sql || !t.sql.toUpperCase().includes('UNIQUE')) {
              rows.push({
                constraint_catalog: 'postgres', constraint_schema: 'public',
                constraint_name: idx.name, table_catalog: 'postgres',
                table_schema: 'public', table_name: t.name,
                constraint_type: 'UNIQUE', is_deferrable: 'NO',
                initially_deferred: 'NO', enforced: 'YES',
              });
            }
          }
        }
      } catch { /* ignore */ }
    }
    return rows;
  }

  /** Generate information_schema.key_column_usage rows. */
  private static generateKeyColumnUsage(): SystemViewRow[] {
    const rows: SystemViewRow[] = [];
    const db = getCurrentDbRef();
    if (!db || !db.prepare) return rows;

    const base = { constraint_catalog: 'postgres', constraint_schema: 'public', table_catalog: 'postgres', table_schema: 'public' };

    for (const t of this.getDbTables()) {
      try {
        const colInfo = db.prepare(`PRAGMA table_info("${t.name}")`).all() as { cid: number; name: string; type: string; notnull: number; dflt_value: any; pk: number }[];
        // PK columns
        const pkCols = colInfo.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk);
        pkCols.forEach((c, i) => {
          rows.push({
            ...base, constraint_name: `${t.name}_pkey`,
            table_name: t.name, column_name: c.name,
            ordinal_position: i + 1, position_in_unique_constraint: null,
          });
        });

        // FK columns
        try {
          const fkList = db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as { id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string; match: string }[];
          for (const fk of fkList) {
            rows.push({
              ...base, constraint_name: `${t.name}_fk`,
              table_name: t.name, column_name: fk.from,
              ordinal_position: fk.seq + 1, position_in_unique_constraint: null,
            });
          }
        } catch { /* ignore */ }

        // UNIQUE columns from unique indexes
        try {
          const indexes = db.prepare(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL AND sql LIKE '%UNIQUE%'`
          ).all(t.name) as { name: string }[];
          for (const idx of indexes) {
            try {
              const idxInfo = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as { seqno: number; cid: number; name: string }[];
              for (const info of idxInfo) {
                rows.push({
                  ...base, constraint_name: idx.name,
                  table_name: t.name, column_name: info.name,
                  ordinal_position: info.seqno + 1, position_in_unique_constraint: null,
                });
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      } catch { /* ignore */ }
    }
    return rows;
  }

  /** Generate information_schema.check_constraints rows. */
  private static generateCheckConstraints(): SystemViewRow[] {
    const rows: SystemViewRow[] = [];
    for (const t of this.getDbTables()) {
      if (!t.sql) continue;
      const checkMatch = t.sql.match(/CHECK\s*\(([^)]+)\)/i);
      if (checkMatch) {
        rows.push({
          constraint_catalog: 'postgres', constraint_schema: 'public',
          constraint_name: `${t.name}_check`, check_clause: checkMatch[1].trim(),
        });
      }
    }
    return rows;
  }

  /** Generate information_schema.referential_constraints rows. */
  private static generateReferentialConstraints(): SystemViewRow[] {
    const rows: SystemViewRow[] = [];
    const db = getCurrentDbRef();
    if (!db || !db.prepare) return rows;

    const ruleMap: Record<string, string> = {
      'NO ACTION': 'NO ACTION', 'CASCADE': 'CASCADE',
      'SET NULL': 'SET NULL', 'SET DEFAULT': 'SET DEFAULT',
      'RESTRICT': 'RESTRICT',
    };

    for (const t of this.getDbTables()) {
      try {
        const fkList = db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as { id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string; match: string }[];
        for (const fk of fkList) {
          rows.push({
            constraint_catalog: 'postgres', constraint_schema: 'public',
            constraint_name: `${t.name}_fk`,
            unique_constraint_catalog: 'postgres', unique_constraint_schema: 'public',
            unique_constraint_name: `${fk.table}_pkey`,
            match_option: 'NONE',
            update_rule: ruleMap[fk.on_update] || 'NO ACTION',
            delete_rule: ruleMap[fk.on_delete] || 'NO ACTION',
            deferrable: 'NO', initially_deferred: 'NO',
          });
        }
      } catch { /* ignore */ }
    }
    return rows;
  }

  /** Generate information_schema.constraint_column_usage rows. */
  private static generateConstraintColumnUsage(): SystemViewRow[] {
    const rows: SystemViewRow[] = [];
    const db = getCurrentDbRef();
    if (!db || !db.prepare) return rows;

    const base = { table_catalog: 'postgres', table_schema: 'public', constraint_catalog: 'postgres', constraint_schema: 'public' };

    for (const t of this.getDbTables()) {
      // PK constraint columns — referenced columns are the PK columns themselves
      try {
        const colInfo = db.prepare(`PRAGMA table_info("${t.name}")`).all() as { cid: number; name: string; pk: number }[];
        const pkCols = colInfo.filter(c => c.pk > 0);
        for (const c of pkCols) {
          rows.push({
            ...base, table_name: t.name, column_name: c.name,
            constraint_name: `${t.name}_pkey`,
          });
        }
      } catch { /* ignore */ }

      // FK constraint columns — referenced table's PK columns
      try {
        const fkList = db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as { id: number; seq: number; table: string; from: string; to: string }[];
        for (const fk of fkList) {
          // FK references PK of the referenced table
          const refCol = fk.to || 'id'; // SQLite may not fill `to` for all PK columns
          rows.push({
            ...base, table_name: fk.table, column_name: refCol,
            constraint_name: `${t.name}_fk`,
          });
        }
      } catch { /* ignore */ }

      // UNIQUE constraint columns
      try {
        const indexes = db.prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL AND sql LIKE '%UNIQUE%'`
        ).all(t.name) as { name: string }[];
        for (const idx of indexes) {
          try {
            const idxInfo = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as { seqno: number; cid: number; name: string }[];
            for (const info of idxInfo) {
              rows.push({
                ...base, table_name: t.name, column_name: info.name,
                constraint_name: idx.name,
              });
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    return rows;
  }

  /** Generate information_schema.table_privileges rows (default public grants). */
  private static generateTablePrivileges(): SystemViewRow[] {
    const rows: SystemViewRow[] = [];
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

    // Collect all tables from user tables and META_TABLES
    const allTables: { schema: string; name: string }[] = [
      ...this.userTables.map(t => ({ schema: t.tableSchema, name: t.tableName })),
      ...META_TABLES.map(t => ({ schema: t.tableSchema, name: t.tableName })),
    ];

    // Also query real tables from DB
    const dbTables = this.getDbTables();
    for (const dt of dbTables) {
      if (!allTables.find(t => t.name === dt.name)) {
        allTables.push({ schema: 'public', name: dt.name });
      }
    }

    for (const table of allTables) {
      for (const priv of privileges) {
        rows.push({
          grantor: 'postgres', grantee: 'public',
          table_catalog: 'postgres', table_schema: table.schema,
          table_name: table.name, privilege_type: priv,
          is_grantable: 'YES', with_hierarchy: 'NO',
        });
      }
    }
    return rows;
  }

  /** Generate information_schema.column_privileges rows (default public grants). */
  private static generateColumnPrivileges(): SystemViewRow[] {
    const rows: SystemViewRow[] = [];
    const privileges = ['SELECT', 'INSERT', 'UPDATE'];
    const db = getCurrentDbRef();

    // Collect all table+column pairs
    const columns: { schema: string; table: string; column: string }[] = [];

    // META_TABLES columns — their column definitions
    for (const meta of META_TABLES) {
      const view = this.views.get(`information_schema.${meta.tableName}`);
      if (view) {
        for (const col of view.columns) {
          columns.push({ schema: meta.tableSchema, table: meta.tableName, column: col.columnName });
        }
      }
    }

    // User tables columns — from PRAGMA
    if (db && db.prepare) {
      const dbTables = this.getDbTables();
      for (const t of dbTables) {
        try {
          const colInfo = db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[];
          for (const c of colInfo) {
            columns.push({ schema: 'public', table: t.name, column: c.name });
          }
        } catch { /* ignore */ }
      }
    }

    for (const col of columns) {
      for (const priv of privileges) {
        rows.push({
          grantor: 'postgres', grantee: 'public',
          table_catalog: 'postgres', table_schema: col.schema,
          table_name: col.table, column_name: col.column,
          privilege_type: priv, is_grantable: 'YES',
        });
      }
    }
    return rows;
  }

  /** Generate information_schema.parameters rows from SystemFunctionRegistry. */
  private static generateParameters(): SystemViewRow[] {
    const rows: SystemViewRow[] = [];
    const functions = SystemFunctionRegistry.getAllFunctions();

    for (let fnIdx = 0; fnIdx < functions.length; fnIdx++) {
      const fn = functions[fnIdx];
      const specificName = `${fn.name}_${fnIdx}`;
      // Generate parameter rows based on maxArgs
      for (let argIdx = 0; argIdx < fn.maxArgs; argIdx++) {
        rows.push({
          specific_catalog: 'postgres', specific_schema: 'pg_catalog',
          specific_name: specificName,
          ordinal_position: argIdx + 1,
          parameter_mode: 'IN',
          is_result: 'NO',
          as_locator: 'NO',
          parameter_name: `a${argIdx + 1}`,
          data_type: 'text',
          character_maximum_length: null,
          character_octet_length: null,
          numeric_precision: null,
          numeric_precision_radix: null,
          numeric_scale: null,
        });
      }
    }
    return rows;
  }
}
