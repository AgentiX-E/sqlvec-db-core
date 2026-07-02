/**
 * DatabaseError — Structured error class with PostgreSQL SQLSTATE codes.
 *
 * All database-level errors in this system should be thrown as DatabaseError
 * instances, providing a consistent SQLSTATE code, severity, detail, and hint.
 * This allows the PgWire protocol layer to produce proper PG ErrorResponse
 * messages for client consumption.
 *
 * Extended with full PG ErrorResponse fields (GAP 2):
 * - position, schema, table, column, constraint
 * - internalPosition, internalQuery, where
 * - file, line, routine
 *
 * @module error/DatabaseError
 */

import {
  SQLSTATE_INTERNAL_ERROR,
} from '../constants/sqlstate';

export type DatabaseErrorSeverity = 'ERROR' | 'FATAL' | 'PANIC';

/**
 * PG ErrorResponse interface with all supported wire protocol fields.
 * Maps directly to PG ErrorResponse message field codes:
 *
 *   S  Severity (localized)
 *   V  Severity (non-localized)
 *   C  SQLSTATE code
 *   M  Message
 *   D  Detail
 *   H  Hint
 *   P  Position (character offset in original query)
 *   p  Internal position (character offset in internally-generated query)
 *   q  Internal query text
 *   W  Where (context description)
 *   s  Schema name
 *   t  Table name
 *   c  Column name
 *   d  Data type name
 *   n  Constraint name
 *   F  File name (source code)
 *   L  Line number (source code)
 *   R  Routine name (source code)
 */
export interface ErrorResponse {
  severity: string;
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  position?: number;
  internalPosition?: number;
  internalQuery?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  file?: string;
  line?: number;
  routine?: string;
}

export class DatabaseError extends Error {
  /**
   * Full PG ErrorResponse fields.
   */
  public position?: number;
  public internalPosition?: number;
  public internalQuery?: string;
  public where?: string;
  public schema?: string;
  public table?: string;
  public column?: string;
  public dataType?: string;
  public constraint?: string;
  public file?: string;
  public line?: number;
  public routine?: string;

  constructor(
    message: string,
    public sqlstate: string = SQLSTATE_INTERNAL_ERROR,
    public severity: DatabaseErrorSeverity = 'ERROR',
    public detail?: string,
    public hint?: string,
    options?: {
      position?: number;
      internalPosition?: number;
      internalQuery?: string;
      where?: string;
      schema?: string;
      table?: string;
      column?: string;
      dataType?: string;
      constraint?: string;
      file?: string;
      line?: number;
      routine?: string;
    },
  ) {
    super(message);
    this.name = 'DatabaseError';

    // Copy optional PG error fields from options
    if (options) {
      this.position = options.position;
      this.internalPosition = options.internalPosition;
      this.internalQuery = options.internalQuery;
      this.where = options.where;
      this.schema = options.schema;
      this.table = options.table;
      this.column = options.column;
      this.dataType = options.dataType;
      this.constraint = options.constraint;
      this.file = options.file;
      this.line = options.line;
      this.routine = options.routine;
    }
  }

  /**
   * Convert this DatabaseError to an ErrorResponse-compatible object.
   * Suitable for serialization into PG wire protocol ErrorResponse ('E') message.
   */
  toErrorResponse(): ErrorResponse {
    return {
      severity: this.severity,
      code: this.sqlstate,
      message: this.message,
      detail: this.detail,
      hint: this.hint,
      position: this.position,
      internalPosition: this.internalPosition,
      internalQuery: this.internalQuery,
      where: this.where,
      schema: this.schema,
      table: this.table,
      column: this.column,
      dataType: this.dataType,
      constraint: this.constraint,
      file: this.file,
      line: this.line,
      routine: this.routine,
    };
  }
}
