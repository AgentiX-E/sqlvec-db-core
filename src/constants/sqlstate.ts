/**
 * SQLSTATE — Comprehensive PostgreSQL standard error codes (SQLSTATE).
 *
 * SQLSTATE codes are 5-character strings defined by the SQL standard
 * and PostgreSQL.  They follow a class/subclass pattern:
 *   - First two chars = class (e.g., '28' = invalid authorization)
 *   - Last three chars = subclass (e.g., 'P01' = invalid password)
 *
 * See: https://www.postgresql.org/docs/current/errcodes-appendix.html
 *
 * Usage in ErrorResponse:
 *   const err = makeErrorResponse(
 *     'FATAL',
 *     SQLSTATE.INVALID_PASSWORD,
 *     'password authentication failed for user "foo"',
 *   );
 *   // serialized:  'S' 'FATAL'  'C' '28P01'  'M' 'password auth failed...'
 */

// ══════════════════════════════════════════════════════════════════
//  Class 00 — Successful Completion
// ══════════════════════════════════════════════════════════════════
/** 00000: Successful completion */
export const SQLSTATE_SUCCESSFUL_COMPLETION = '00000';

// ══════════════════════════════════════════════════════════════════
//  Class 01 — Warning
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_WARNING = '01000';
export const SQLSTATE_WARNING_DYNAMIC_RESULT_COLUMNS_RETURNED = '0100C';
export const SQLSTATE_WARNING_IMPLICIT_ZERO_BIT_PADDING = '01008';
export const SQLSTATE_WARNING_NULL_VALUE_ELIMINATED_IN_SET_FUNCTION = '01003';
export const SQLSTATE_WARNING_PRIVILEGE_NOT_GRANTED = '01007';
export const SQLSTATE_WARNING_PRIVILEGE_NOT_REVOKED = '01006';
export const SQLSTATE_WARNING_STRING_DATA_RIGHT_TRUNCATION = '01004';
export const SQLSTATE_WARNING_DEPRECATED_FEATURE = '01P01';

// ══════════════════════════════════════════════════════════════════
//  Class 02 — No Data (this is also a warning class per the SQL standard)
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_NO_DATA = '02000';
export const SQLSTATE_NO_ADDITIONAL_DYNAMIC_RESULT_COLUMNS_RETURNED = '02001';

// ══════════════════════════════════════════════════════════════════
//  Class 03 — SQL Statement Not Yet Complete
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_SQL_STATEMENT_NOT_YET_COMPLETE = '03000';

// ══════════════════════════════════════════════════════════════════
//  Class 08 — Connection Exception
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_CONNECTION_DOES_NOT_EXIST = '08003';
export const SQLSTATE_CONNECTION_FAILURE = '08006';
export const SQLSTATE_CONNECTION_EXCEPTION = '08000';
export const SQLSTATE_SQLCLIENT_UNABLE_TO_ESTABLISH_SQLCONNECTION = '08001';
export const SQLSTATE_SQLSERVER_REJECTED_ESTABLISHMENT_OF_SQLCONNECTION = '08004';
export const SQLSTATE_TRANSACTION_RESOLUTION_UNKNOWN = '08007';
export const SQLSTATE_PROTOCOL_VIOLATION = '08P01';

// ══════════════════════════════════════════════════════════════════
//  Class 09 — Triggered Action Exception
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_TRIGGERED_ACTION_EXCEPTION = '09000';

// ══════════════════════════════════════════════════════════════════
//  Class 0A — Feature Not Supported
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_FEATURE_NOT_SUPPORTED = '0A000';

// ══════════════════════════════════════════════════════════════════
//  Class 0B — Invalid Transaction Initiation
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INVALID_TRANSACTION_INITIATION = '0B000';

// ══════════════════════════════════════════════════════════════════
//  Class 0F — Locator Exception
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_LOCATOR_EXCEPTION = '0F000';
export const SQLSTATE_INVALID_LOCATOR_SPECIFICATION = '0F001';

// ══════════════════════════════════════════════════════════════════
//  Class 0L — Invalid Grantor
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INVALID_GRANTOR = '0L000';
export const SQLSTATE_INVALID_GRANT_OPERATION = '0LP01';

// ══════════════════════════════════════════════════════════════════
//  Class 0P — Invalid Role Specification
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INVALID_ROLE_SPECIFICATION = '0P000';

// ══════════════════════════════════════════════════════════════════
//  Class 0Z — Diagnostics Exception
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_DIAGNOSTICS_EXCEPTION = '0Z000';
export const SQLSTATE_STACKED_DIAGNOSTICS_ACCESSED_WITHOUT_ACTIVE_HANDLER = '0Z002';

// ══════════════════════════════════════════════════════════════════
//  Class 20 — Case Not Found
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_CASE_NOT_FOUND = '20000';

// ══════════════════════════════════════════════════════════════════
//  Class 21 — Cardinality Violation
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_CARDINALITY_VIOLATION = '21000';

// ══════════════════════════════════════════════════════════════════
//  Class 22 — Data Exception
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_DATA_EXCEPTION = '22000';
export const SQLSTATE_STRING_DATA_RIGHT_TRUNCATION = '22001';
export const SQLSTATE_NULL_VALUE_NO_INDICATOR_PARAMETER = '22002';
export const SQLSTATE_NUMERIC_VALUE_OUT_OF_RANGE = '22003';
export const SQLSTATE_NULL_VALUE_NOT_ALLOWED = '22004';
export const SQLSTATE_ERROR_IN_ASSIGNMENT = '22005';
export const SQLSTATE_INVALID_DATETIME_FORMAT = '22007';
export const SQLSTATE_DATETIME_FIELD_OVERFLOW = '22008';
export const SQLSTATE_INVALID_TIME_ZONE_DISPLACEMENT_VALUE = '22009';
export const SQLSTATE_DIVISION_BY_ZERO = '22012';
export const SQLSTATE_ARRAY_SUBSCRIPT_ERROR = '2202E';
export const SQLSTATE_FLOATING_POINT_EXCEPTION = '22P01';
export const SQLSTATE_INVALID_TEXT_REPRESENTATION = '22P02';
export const SQLSTATE_INVALID_BINARY_REPRESENTATION = '22P03';
export const SQLSTATE_BAD_COPY_FILE_FORMAT = '22P04';
export const SQLSTATE_UNTRANSLATABLE_CHARACTER = '22P05';
export const SQLSTATE_NONSTANDARD_USE_OF_ESCAPE_CHARACTER = '22P06';
export const SQLSTATE_INVALID_ESCAPE_ARGUMENT = '22P07';

// ══════════════════════════════════════════════════════════════════
//  Class 23 — Integrity Constraint Violation
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INTEGRITY_CONSTRAINT_VIOLATION = '23000';
export const SQLSTATE_RESTRICT_VIOLATION = '23001';
export const SQLSTATE_NOT_NULL_VIOLATION = '23502';
export const SQLSTATE_FOREIGN_KEY_VIOLATION = '23503';
export const SQLSTATE_UNIQUE_VIOLATION = '23505';
export const SQLSTATE_CHECK_VIOLATION = '23514';
export const SQLSTATE_EXCLUSION_VIOLATION = '23P01';

// ══════════════════════════════════════════════════════════════════
//  Class 24 — Invalid Cursor State
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INVALID_CURSOR_STATE = '24000';

// ══════════════════════════════════════════════════════════════════
//  Class 25 — Invalid Transaction State
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_NO_ACTIVE_SQL_TRANSACTION = '25P01';
export const SQLSTATE_IN_FAILED_SQL_TRANSACTION = '25P02';
export const SQLSTATE_ACTIVE_SQL_TRANSACTION = '25001';
export const SQLSTATE_BRANCH_TRANSACTION_ALREADY_ACTIVE = '25002';
export const SQLSTATE_HELD_CURSOR_REQUIRES_SAME_ISOLATION_LEVEL = '25003';
export const SQLSTATE_IMPROPER_ACCESS_FOR_BRANCH_TRANSACTION = '25004';
export const SQLSTATE_NO_COMMIT_FOR_BRANCH_TRANSACTION = '25005';
export const SQLSTATE_NO_ACTIVE_BRANCH_TRANSACTION = '25006';
export const SQLSTATE_INSUFFICIENT_NUMBER_OF_DIMENSIONS = '25007';
export const SQLSTATE_INVALID_DIMENSION = '25008';
export const SQLSTATE_READ_ONLY_SQL_TRANSACTION = '25006'; // PG: 25P03
export const SQLSTATE_CANNOT_COPY_TO_READ_ONLY_TXN = '25P03';

// ══════════════════════════════════════════════════════════════════
//  Class 26 — Invalid SQL Statement Name
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INVALID_SQL_STATEMENT_NAME = '26000';

// ══════════════════════════════════════════════════════════════════
//  Class 27 — Triggered Data Change Violation
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_TRIGGERED_DATA_CHANGE_VIOLATION = '27000';

// ══════════════════════════════════════════════════════════════════
//  Class 28 — Invalid Authorization Specification
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INVALID_PASSWORD = '28P01';
export const SQLSTATE_INVALID_AUTHORIZATION_SPECIFICATION = '28P02';

// ══════════════════════════════════════════════════════════════════
//  Class 2B — Dependent Privilege Descriptors Still Exist
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_DEPENDENT_PRIVILEGE_DESCRIPTORS_STILL_EXIST = '2B000';
export const SQLSTATE_DEPENDENT_OBJECTS_STILL_EXIST = '2BP01';

// ══════════════════════════════════════════════════════════════════
//  Class 2D — Invalid Transaction Termination
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INVALID_TRANSACTION_TERMINATION = '2D000';

// ══════════════════════════════════════════════════════════════════
//  Class 2F — SQL Routine Exception
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_SQL_ROUTINE_EXCEPTION = '2F000';
export const SQLSTATE_FUNCTION_EXECUTED_NO_RETURN_STATEMENT = '2F005';
export const SQLSTATE_MODIFYING_SQL_DATA_NOT_PERMITTED = '2F002';
export const SQLSTATE_PROHIBITED_SQL_STATEMENT_ATTEMPTED = '2F003';
export const SQLSTATE_READING_SQL_DATA_NOT_PERMITTED = '2F004';

// ══════════════════════════════════════════════════════════════════
//  Class 34 — Invalid Cursor Name
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INVALID_CURSOR_NAME = '34000';

// ══════════════════════════════════════════════════════════════════
//  Class 38 — External Routine Exception
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_EXTERNAL_ROUTINE_EXCEPTION = '38000';
export const SQLSTATE_CONTAINING_SQL_NOT_PERMITTED = '38001';
export const SQLSTATE_MODIFYING_SQL_DATA_NOT_PERMITTED_EXT = '38002';
export const SQLSTATE_PROHIBITED_SQL_STATEMENT_ATTEMPTED_EXT = '38003';
export const SQLSTATE_READING_SQL_DATA_NOT_PERMITTED_EXT = '38004';

// ══════════════════════════════════════════════════════════════════
//  Class 39 — External Routine Invocation Exception
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_EXTERNAL_ROUTINE_INVOCATION_EXCEPTION = '39000';
export const SQLSTATE_INVALID_SQLSTATE_RETURNED = '39001';
export const SQLSTATE_NULL_VALUE_NOT_ALLOWED_EXT = '39004';
export const SQLSTATE_TRIGGER_PROTOCOL_VIOLATED = '39P01';
export const SQLSTATE_SRF_PROTOCOL_VIOLATED = '39P02';
export const SQLSTATE_EVENT_TRIGGER_PROTOCOL_VIOLATED = '39P03';

// ══════════════════════════════════════════════════════════════════
//  Class 3B — Savepoint Exception
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_SAVEPOINT_EXCEPTION = '3B000';
export const SQLSTATE_INVALID_SAVEPOINT_SPECIFICATION = '3B001';

// ══════════════════════════════════════════════════════════════════
//  Class 3D — Invalid Catalog Name
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INVALID_CATALOG_NAME = '3D000';

// ══════════════════════════════════════════════════════════════════
//  Class 3F — Invalid Schema Name
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INVALID_SCHEMA_NAME = '3F000';

// ══════════════════════════════════════════════════════════════════
//  Class 40 — Transaction Rollback
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_SERIALIZATION_FAILURE = '40001';
export const SQLSTATE_TRANSACTION_INTEGRITY_CONSTRAINT_VIOLATION = '40002';
export const SQLSTATE_STATEMENT_COMPLETION_UNKNOWN = '40003';
export const SQLSTATE_DEADLOCK_DETECTED = '40P01';

// ══════════════════════════════════════════════════════════════════
//  Class 42 — Syntax Error or Access Rule Violation
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_SYNTAX_ERROR = '42601';
export const SQLSTATE_INSUFFICIENT_PRIVILEGE = '42501';
export const SQLSTATE_CANNOT_COERCE = '42846';
export const SQLSTATE_GROUPING_ERROR = '42803';
export const SQLSTATE_WINDOWING_ERROR = '42P20';
export const SQLSTATE_INVALID_RECURSION = '42P19';
export const SQLSTATE_INVALID_FOREIGN_KEY = '42830';
export const SQLSTATE_INVALID_NAME = '42602';
export const SQLSTATE_NAME_TOO_LONG = '42622';
export const SQLSTATE_RESERVED_NAME = '42939';
export const SQLSTATE_DATATYPE_MISMATCH = '42804';
export const SQLSTATE_INDETERMINATE_DATATYPE = '42P18';
export const SQLSTATE_COLLATION_MISMATCH = '42P21';
export const SQLSTATE_INDETERMINATE_COLLATION = '42P22';
export const SQLSTATE_WRONG_OBJECT_TYPE = '42809';
export const SQLSTATE_GENERATED_ALWAYS = '428C9';
export const SQLSTATE_UNDEFINED_COLUMN = '42703';
export const SQLSTATE_UNDEFINED_FUNCTION = '42883';
export const SQLSTATE_UNDEFINED_TABLE = '42P01';
export const SQLSTATE_UNDEFINED_PARAMETER = '42P02';
export const SQLSTATE_UNDEFINED_OBJECT = '42704';
export const SQLSTATE_DUPLICATE_COLUMN = '42701';
export const SQLSTATE_DUPLICATE_CURSOR = '42P03';
export const SQLSTATE_DUPLICATE_DATABASE = '42P04';
export const SQLSTATE_DUPLICATE_FUNCTION = '42723';
export const SQLSTATE_DUPLICATE_PSTATEMENT = '42P05';
export const SQLSTATE_DUPLICATE_SCHEMA = '42P06';
export const SQLSTATE_DUPLICATE_TABLE = '42P07';
export const SQLSTATE_DUPLICATE_ALIAS = '42712';
export const SQLSTATE_DUPLICATE_OBJECT = '42710';
export const SQLSTATE_AMBIGUOUS_COLUMN = '42702';
export const SQLSTATE_AMBIGUOUS_FUNCTION = '42725';
export const SQLSTATE_AMBIGUOUS_PARAMETER = '42P08';
export const SQLSTATE_AMBIGUOUS_ALIAS = '42P09';
export const SQLSTATE_INVALID_COLUMN_REFERENCE = '42P10';
export const SQLSTATE_INVALID_CURSOR_DEFINITION = '42P11';
export const SQLSTATE_INVALID_DATABASE_DEFINITION = '42P12';
export const SQLSTATE_INVALID_FUNCTION_DEFINITION = '42P13';
export const SQLSTATE_INVALID_PSTATEMENT_DEFINITION = '42P14';
export const SQLSTATE_INVALID_SCHEMA_DEFINITION = '42P15';
export const SQLSTATE_INVALID_TABLE_DEFINITION = '42P16';
export const SQLSTATE_INVALID_OBJECT_DEFINITION = '42P17';
export const SQLSTATE_PROHIBITED_SQL_STATEMENT_ATTEMPTED_SYNTAX = '42P18';

// ══════════════════════════════════════════════════════════════════
//  Class 44 — WITH CHECK OPTION Violation
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_WITH_CHECK_OPTION_VIOLATION = '44000';

// ══════════════════════════════════════════════════════════════════
//  Class 53 — Insufficient Resources
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INSUFFICIENT_RESOURCES = '53000';
export const SQLSTATE_DISK_FULL = '53100';
export const SQLSTATE_OUT_OF_MEMORY = '53200';
export const SQLSTATE_TOO_MANY_CONNECTIONS = '53300';
export const SQLSTATE_CONFIGURATION_LIMIT_EXCEEDED = '53400';
export const SQLSTATE_OUT_OF_LOCKS = '53500';

// ══════════════════════════════════════════════════════════════════
//  Class 54 — Program Limit Exceeded
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_PROGRAM_LIMIT_EXCEEDED = '54000';
export const SQLSTATE_STATEMENT_TOO_COMPLEX = '54001';
export const SQLSTATE_TOO_MANY_COLUMNS = '54011';
export const SQLSTATE_TOO_MANY_ARGUMENTS = '54023';

// ══════════════════════════════════════════════════════════════════
//  Class 55 — Object Not In Prerequisite State
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_OBJECT_NOT_IN_PREREQUISITE_STATE = '55000';
export const SQLSTATE_OBJECT_IN_USE = '55006';
export const SQLSTATE_CANT_CHANGE_RUNTIME_PARAM = '55P02';
export const SQLSTATE_LOCK_NOT_AVAILABLE = '55P03';
export const SQLSTATE_CANT_REFRESH_MATERIALIZED_VIEW = '55P04';

// ══════════════════════════════════════════════════════════════════
//  Class 57 — Operator Intervention
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_ADMIN_SHUTDOWN = '57P01';
export const SQLSTATE_CRASH_SHUTDOWN = '57P02';
export const SQLSTATE_CANNOT_CONNECT_NOW = '57P03';
export const SQLSTATE_DATABASE_DROPPED = '57P04';
export const SQLSTATE_IDLE_SESSION_TIMEOUT = '57P05';
export const SQLSTATE_IDLE_TRANSACTION_TIMEOUT = '57P06';
export const SQLSTATE_QUERY_CANCELED = '57014';

// ══════════════════════════════════════════════════════════════════
//  Class 58 — System Error (PostgreSQL external)
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_IO_ERROR = '58030';
export const SQLSTATE_UNDEFINED_FILE = '58P01';
export const SQLSTATE_DUPLICATE_FILE = '58P02';

// ══════════════════════════════════════════════════════════════════
//  Class 72 — Snapshot Failure (PG)
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_SNAPSHOT_TOO_OLD = '72000';

// ══════════════════════════════════════════════════════════════════
//  Class F0 — Configuration File Error (PG)
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_CONFIG_FILE_ERROR = 'F0000';
export const SQLSTATE_LOCK_FILE_EXISTS = 'F0001';

// ══════════════════════════════════════════════════════════════════
//  Class HV — Foreign Data Wrapper Error (SQL/MED)
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_FDW_ERROR = 'HV000';
export const SQLSTATE_FDW_COLUMN_NAME_NOT_FOUND = 'HV005';
export const SQLSTATE_FDW_DYNAMIC_PARAMETER_VALUE_NEEDED = 'HV002';
export const SQLSTATE_FDW_FUNCTION_SEQUENCE_ERROR = 'HV010';
export const SQLSTATE_FDW_INCONSISTENT_DESCRIPTOR_INFORMATION = 'HV021';
export const SQLSTATE_FDW_INVALID_ATTRIBUTE_VALUE = 'HV024';
export const SQLSTATE_FDW_INVALID_COLUMN_NAME = 'HV007';
export const SQLSTATE_FDW_INVALID_COLUMN_NUMBER = 'HV008';
export const SQLSTATE_FDW_INVALID_DATA_TYPE = 'HV004';
export const SQLSTATE_FDW_INVALID_DATA_TYPE_DESCRIPTORS = 'HV006';
export const SQLSTATE_FDW_INVALID_DESCRIPTOR_FIELD_IDENTIFIER = 'HV091';
export const SQLSTATE_FDW_INVALID_HANDLE = 'HV00B';
export const SQLSTATE_FDW_INVALID_OPTION_INDEX = 'HV00C';
export const SQLSTATE_FDW_INVALID_OPTION_NAME = 'HV00D';
export const SQLSTATE_FDW_INVALID_STRING_LENGTH_OR_BUFFER_LENGTH = 'HV090';
export const SQLSTATE_FDW_INVALID_STRING_FORMAT = 'HV00A';
export const SQLSTATE_FDW_INVALID_USE_OF_NULL_POINTER = 'HV009';
export const SQLSTATE_FDW_NO_SCHEMAS = 'HV00E';
export const SQLSTATE_FDW_OPTION_NAME_NOT_FOUND = 'HV00J';
export const SQLSTATE_FDW_REPLY_HANDLE = 'HV00K';
export const SQLSTATE_FDW_SCHEMA_NOT_FOUND = 'HV00L';
export const SQLSTATE_FDW_TABLE_NOT_FOUND = 'HV00M';
export const SQLSTATE_FDW_UNABLE_TO_CREATE_EXECUTION = 'HV00N';
export const SQLSTATE_FDW_UNABLE_TO_CREATE_REPLY = 'HV00P';
export const SQLSTATE_FDW_UNABLE_TO_ESTABLISH_CONNECTION = 'HV00Q';

// ══════════════════════════════════════════════════════════════════
//  Class P0 — PL/pgSQL Error
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_PLPGSQL_ERROR = 'P0000';
export const SQLSTATE_RAISE_EXCEPTION = 'P0001';
export const SQLSTATE_NO_DATA_FOUND = 'P0002';
export const SQLSTATE_TOO_MANY_ROWS = 'P0003';
export const SQLSTATE_ASSERT_FAILURE = 'P0004';

// ══════════════════════════════════════════════════════════════════
//  Class XX — Internal Error
// ══════════════════════════════════════════════════════════════════
export const SQLSTATE_INTERNAL_ERROR = 'XX000';
export const SQLSTATE_DATA_CORRUPTED = 'XX001';
export const SQLSTATE_INDEX_CORRUPTED = 'XX002';

// ══════════════════════════════════════════════════════════════════
//  SQLSTATE class registry — for looking up the class prefix
// ══════════════════════════════════════════════════════════════════

export const SQLSTATE_CLASSES: Record<string, string> = {
  '00': 'Successful Completion',
  '01': 'Warning',
  '02': 'No Data',
  '03': 'SQL Statement Not Yet Complete',
  '08': 'Connection Exception',
  '09': 'Triggered Action Exception',
  '0A': 'Feature Not Supported',
  '0B': 'Invalid Transaction Initiation',
  '0F': 'Locator Exception',
  '0L': 'Invalid Grantor',
  '0P': 'Invalid Role Specification',
  '0Z': 'Diagnostics Exception',
  '20': 'Case Not Found',
  '21': 'Cardinality Violation',
  '22': 'Data Exception',
  '23': 'Integrity Constraint Violation',
  '24': 'Invalid Cursor State',
  '25': 'Invalid Transaction State',
  '26': 'Invalid SQL Statement Name',
  '27': 'Triggered Data Change Violation',
  '28': 'Invalid Authorization Specification',
  '2B': 'Dependent Privilege Descriptors Still Exist',
  '2D': 'Invalid Transaction Termination',
  '2F': 'SQL Routine Exception',
  '34': 'Invalid Cursor Name',
  '38': 'External Routine Exception',
  '39': 'External Routine Invocation Exception',
  '3B': 'Savepoint Exception',
  '3D': 'Invalid Catalog Name',
  '3F': 'Invalid Schema Name',
  '40': 'Transaction Rollback',
  '42': 'Syntax Error or Access Rule Violation',
  '44': 'WITH CHECK OPTION Violation',
  '53': 'Insufficient Resources',
  '54': 'Program Limit Exceeded',
  '55': 'Object Not In Prerequisite State',
  '57': 'Operator Intervention',
  '58': 'System Error',
  '72': 'Snapshot Failure',
  'F0': 'Configuration File Error',
  'HV': 'Foreign Data Wrapper Error',
  'P0': 'PL/pgSQL Error',
  'XX': 'Internal Error',
};

// ══════════════════════════════════════════════════════════════════
//  Composite convenience object
// ══════════════════════════════════════════════════════════════════

export const SQLSTATE = {
  // Class 00
  SUCCESSFUL_COMPLETION: SQLSTATE_SUCCESSFUL_COMPLETION,

  // Class 01
  WARNING: SQLSTATE_WARNING,
  WARNING_DYNAMIC_RESULT_COLUMNS_RETURNED: SQLSTATE_WARNING_DYNAMIC_RESULT_COLUMNS_RETURNED,
  WARNING_IMPLICIT_ZERO_BIT_PADDING: SQLSTATE_WARNING_IMPLICIT_ZERO_BIT_PADDING,
  WARNING_NULL_VALUE_ELIMINATED_IN_SET_FUNCTION: SQLSTATE_WARNING_NULL_VALUE_ELIMINATED_IN_SET_FUNCTION,
  WARNING_PRIVILEGE_NOT_GRANTED: SQLSTATE_WARNING_PRIVILEGE_NOT_GRANTED,
  WARNING_PRIVILEGE_NOT_REVOKED: SQLSTATE_WARNING_PRIVILEGE_NOT_REVOKED,
  WARNING_STRING_DATA_RIGHT_TRUNCATION: SQLSTATE_WARNING_STRING_DATA_RIGHT_TRUNCATION,
  WARNING_DEPRECATED_FEATURE: SQLSTATE_WARNING_DEPRECATED_FEATURE,

  // Class 02
  NO_DATA: SQLSTATE_NO_DATA,
  NO_ADDITIONAL_DYNAMIC_RESULT_COLUMNS_RETURNED: SQLSTATE_NO_ADDITIONAL_DYNAMIC_RESULT_COLUMNS_RETURNED,

  // Class 03
  SQL_STATEMENT_NOT_YET_COMPLETE: SQLSTATE_SQL_STATEMENT_NOT_YET_COMPLETE,

  // Class 08
  CONNECTION_DOES_NOT_EXIST: SQLSTATE_CONNECTION_DOES_NOT_EXIST,
  CONNECTION_FAILURE: SQLSTATE_CONNECTION_FAILURE,
  CONNECTION_EXCEPTION: SQLSTATE_CONNECTION_EXCEPTION,
  SQLCLIENT_UNABLE_TO_ESTABLISH_SQLCONNECTION: SQLSTATE_SQLCLIENT_UNABLE_TO_ESTABLISH_SQLCONNECTION,
  SQLSERVER_REJECTED_ESTABLISHMENT_OF_SQLCONNECTION: SQLSTATE_SQLSERVER_REJECTED_ESTABLISHMENT_OF_SQLCONNECTION,
  TRANSACTION_RESOLUTION_UNKNOWN: SQLSTATE_TRANSACTION_RESOLUTION_UNKNOWN,
  PROTOCOL_VIOLATION: SQLSTATE_PROTOCOL_VIOLATION,

  // Class 09
  TRIGGERED_ACTION_EXCEPTION: SQLSTATE_TRIGGERED_ACTION_EXCEPTION,

  // Class 0A
  FEATURE_NOT_SUPPORTED: SQLSTATE_FEATURE_NOT_SUPPORTED,

  // Class 0B
  INVALID_TRANSACTION_INITIATION: SQLSTATE_INVALID_TRANSACTION_INITIATION,

  // Class 0F
  LOCATOR_EXCEPTION: SQLSTATE_LOCATOR_EXCEPTION,
  INVALID_LOCATOR_SPECIFICATION: SQLSTATE_INVALID_LOCATOR_SPECIFICATION,

  // Class 0L
  INVALID_GRANTOR: SQLSTATE_INVALID_GRANTOR,
  INVALID_GRANT_OPERATION: SQLSTATE_INVALID_GRANT_OPERATION,

  // Class 0P
  INVALID_ROLE_SPECIFICATION: SQLSTATE_INVALID_ROLE_SPECIFICATION,

  // Class 0Z
  DIAGNOSTICS_EXCEPTION: SQLSTATE_DIAGNOSTICS_EXCEPTION,
  STACKED_DIAGNOSTICS_ACCESSED_WITHOUT_ACTIVE_HANDLER: SQLSTATE_STACKED_DIAGNOSTICS_ACCESSED_WITHOUT_ACTIVE_HANDLER,

  // Class 20
  CASE_NOT_FOUND: SQLSTATE_CASE_NOT_FOUND,

  // Class 21
  CARDINALITY_VIOLATION: SQLSTATE_CARDINALITY_VIOLATION,

  // Class 22
  DATA_EXCEPTION: SQLSTATE_DATA_EXCEPTION,
  STRING_DATA_RIGHT_TRUNCATION: SQLSTATE_STRING_DATA_RIGHT_TRUNCATION,
  NULL_VALUE_NO_INDICATOR_PARAMETER: SQLSTATE_NULL_VALUE_NO_INDICATOR_PARAMETER,
  NUMERIC_VALUE_OUT_OF_RANGE: SQLSTATE_NUMERIC_VALUE_OUT_OF_RANGE,
  NULL_VALUE_NOT_ALLOWED: SQLSTATE_NULL_VALUE_NOT_ALLOWED,
  ERROR_IN_ASSIGNMENT: SQLSTATE_ERROR_IN_ASSIGNMENT,
  INVALID_DATETIME_FORMAT: SQLSTATE_INVALID_DATETIME_FORMAT,
  DATETIME_FIELD_OVERFLOW: SQLSTATE_DATETIME_FIELD_OVERFLOW,
  INVALID_TIME_ZONE_DISPLACEMENT_VALUE: SQLSTATE_INVALID_TIME_ZONE_DISPLACEMENT_VALUE,
  DIVISION_BY_ZERO: SQLSTATE_DIVISION_BY_ZERO,
  ARRAY_SUBSCRIPT_ERROR: SQLSTATE_ARRAY_SUBSCRIPT_ERROR,
  FLOATING_POINT_EXCEPTION: SQLSTATE_FLOATING_POINT_EXCEPTION,
  INVALID_TEXT_REPRESENTATION: SQLSTATE_INVALID_TEXT_REPRESENTATION,
  INVALID_BINARY_REPRESENTATION: SQLSTATE_INVALID_BINARY_REPRESENTATION,
  BAD_COPY_FILE_FORMAT: SQLSTATE_BAD_COPY_FILE_FORMAT,
  UNTRANSLATABLE_CHARACTER: SQLSTATE_UNTRANSLATABLE_CHARACTER,
  NONSTANDARD_USE_OF_ESCAPE_CHARACTER: SQLSTATE_NONSTANDARD_USE_OF_ESCAPE_CHARACTER,
  INVALID_ESCAPE_ARGUMENT: SQLSTATE_INVALID_ESCAPE_ARGUMENT,

  // Class 23
  INTEGRITY_CONSTRAINT_VIOLATION: SQLSTATE_INTEGRITY_CONSTRAINT_VIOLATION,
  RESTRICT_VIOLATION: SQLSTATE_RESTRICT_VIOLATION,
  NOT_NULL_VIOLATION: SQLSTATE_NOT_NULL_VIOLATION,
  FOREIGN_KEY_VIOLATION: SQLSTATE_FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION: SQLSTATE_UNIQUE_VIOLATION,
  CHECK_VIOLATION: SQLSTATE_CHECK_VIOLATION,
  EXCLUSION_VIOLATION: SQLSTATE_EXCLUSION_VIOLATION,

  // Class 24
  INVALID_CURSOR_STATE: SQLSTATE_INVALID_CURSOR_STATE,

  // Class 25
  NO_ACTIVE_SQL_TRANSACTION: SQLSTATE_NO_ACTIVE_SQL_TRANSACTION,
  IN_FAILED_SQL_TRANSACTION: SQLSTATE_IN_FAILED_SQL_TRANSACTION,
  ACTIVE_SQL_TRANSACTION: SQLSTATE_ACTIVE_SQL_TRANSACTION,
  BRANCH_TRANSACTION_ALREADY_ACTIVE: SQLSTATE_BRANCH_TRANSACTION_ALREADY_ACTIVE,
  HELD_CURSOR_REQUIRES_SAME_ISOLATION_LEVEL: SQLSTATE_HELD_CURSOR_REQUIRES_SAME_ISOLATION_LEVEL,
  INSUFFICIENT_NUMBER_OF_DIMENSIONS: SQLSTATE_INSUFFICIENT_NUMBER_OF_DIMENSIONS,
  INVALID_DIMENSION: SQLSTATE_INVALID_DIMENSION,

  // Class 26
  INVALID_SQL_STATEMENT_NAME: SQLSTATE_INVALID_SQL_STATEMENT_NAME,

  // Class 27
  TRIGGERED_DATA_CHANGE_VIOLATION: SQLSTATE_TRIGGERED_DATA_CHANGE_VIOLATION,

  // Class 28
  INVALID_PASSWORD: SQLSTATE_INVALID_PASSWORD,
  INVALID_AUTHORIZATION_SPECIFICATION: SQLSTATE_INVALID_AUTHORIZATION_SPECIFICATION,

  // Class 2B
  DEPENDENT_PRIVILEGE_DESCRIPTORS_STILL_EXIST: SQLSTATE_DEPENDENT_PRIVILEGE_DESCRIPTORS_STILL_EXIST,
  DEPENDENT_OBJECTS_STILL_EXIST: SQLSTATE_DEPENDENT_OBJECTS_STILL_EXIST,

  // Class 2D
  INVALID_TRANSACTION_TERMINATION: SQLSTATE_INVALID_TRANSACTION_TERMINATION,

  // Class 2F
  SQL_ROUTINE_EXCEPTION: SQLSTATE_SQL_ROUTINE_EXCEPTION,
  FUNCTION_EXECUTED_NO_RETURN_STATEMENT: SQLSTATE_FUNCTION_EXECUTED_NO_RETURN_STATEMENT,
  MODIFYING_SQL_DATA_NOT_PERMITTED: SQLSTATE_MODIFYING_SQL_DATA_NOT_PERMITTED,
  PROHIBITED_SQL_STATEMENT_ATTEMPTED: SQLSTATE_PROHIBITED_SQL_STATEMENT_ATTEMPTED,
  READING_SQL_DATA_NOT_PERMITTED: SQLSTATE_READING_SQL_DATA_NOT_PERMITTED,

  // Class 34
  INVALID_CURSOR_NAME: SQLSTATE_INVALID_CURSOR_NAME,

  // Class 38
  EXTERNAL_ROUTINE_EXCEPTION: SQLSTATE_EXTERNAL_ROUTINE_EXCEPTION,
  CONTAINING_SQL_NOT_PERMITTED: SQLSTATE_CONTAINING_SQL_NOT_PERMITTED,
  MODIFYING_SQL_DATA_NOT_PERMITTED_EXT: SQLSTATE_MODIFYING_SQL_DATA_NOT_PERMITTED_EXT,
  PROHIBITED_SQL_STATEMENT_ATTEMPTED_EXT: SQLSTATE_PROHIBITED_SQL_STATEMENT_ATTEMPTED_EXT,
  READING_SQL_DATA_NOT_PERMITTED_EXT: SQLSTATE_READING_SQL_DATA_NOT_PERMITTED_EXT,

  // Class 39
  EXTERNAL_ROUTINE_INVOCATION_EXCEPTION: SQLSTATE_EXTERNAL_ROUTINE_INVOCATION_EXCEPTION,
  INVALID_SQLSTATE_RETURNED: SQLSTATE_INVALID_SQLSTATE_RETURNED,
  NULL_VALUE_NOT_ALLOWED_EXT: SQLSTATE_NULL_VALUE_NOT_ALLOWED_EXT,
  TRIGGER_PROTOCOL_VIOLATED: SQLSTATE_TRIGGER_PROTOCOL_VIOLATED,
  SRF_PROTOCOL_VIOLATED: SQLSTATE_SRF_PROTOCOL_VIOLATED,
  EVENT_TRIGGER_PROTOCOL_VIOLATED: SQLSTATE_EVENT_TRIGGER_PROTOCOL_VIOLATED,

  // Class 3B
  SAVEPOINT_EXCEPTION: SQLSTATE_SAVEPOINT_EXCEPTION,
  INVALID_SAVEPOINT_SPECIFICATION: SQLSTATE_INVALID_SAVEPOINT_SPECIFICATION,

  // Class 3D
  INVALID_CATALOG_NAME: SQLSTATE_INVALID_CATALOG_NAME,

  // Class 3F
  INVALID_SCHEMA_NAME: SQLSTATE_INVALID_SCHEMA_NAME,

  // Class 40
  SERIALIZATION_FAILURE: SQLSTATE_SERIALIZATION_FAILURE,
  TRANSACTION_INTEGRITY_CONSTRAINT_VIOLATION: SQLSTATE_TRANSACTION_INTEGRITY_CONSTRAINT_VIOLATION,
  STATEMENT_COMPLETION_UNKNOWN: SQLSTATE_STATEMENT_COMPLETION_UNKNOWN,
  DEADLOCK_DETECTED: SQLSTATE_DEADLOCK_DETECTED,

  // Class 42
  SYNTAX_ERROR: SQLSTATE_SYNTAX_ERROR,
  INSUFFICIENT_PRIVILEGE: SQLSTATE_INSUFFICIENT_PRIVILEGE,
  CANNOT_COERCE: SQLSTATE_CANNOT_COERCE,
  GROUPING_ERROR: SQLSTATE_GROUPING_ERROR,
  WINDOWING_ERROR: SQLSTATE_WINDOWING_ERROR,
  INVALID_RECURSION: SQLSTATE_INVALID_RECURSION,
  INVALID_FOREIGN_KEY: SQLSTATE_INVALID_FOREIGN_KEY,
  INVALID_NAME: SQLSTATE_INVALID_NAME,
  NAME_TOO_LONG: SQLSTATE_NAME_TOO_LONG,
  RESERVED_NAME: SQLSTATE_RESERVED_NAME,
  DATATYPE_MISMATCH: SQLSTATE_DATATYPE_MISMATCH,
  INDETERMINATE_DATATYPE: SQLSTATE_INDETERMINATE_DATATYPE,
  COLLATION_MISMATCH: SQLSTATE_COLLATION_MISMATCH,
  INDETERMINATE_COLLATION: SQLSTATE_INDETERMINATE_COLLATION,
  WRONG_OBJECT_TYPE: SQLSTATE_WRONG_OBJECT_TYPE,
  GENERATED_ALWAYS: SQLSTATE_GENERATED_ALWAYS,
  UNDEFINED_COLUMN: SQLSTATE_UNDEFINED_COLUMN,
  UNDEFINED_FUNCTION: SQLSTATE_UNDEFINED_FUNCTION,
  UNDEFINED_TABLE: SQLSTATE_UNDEFINED_TABLE,
  UNDEFINED_PARAMETER: SQLSTATE_UNDEFINED_PARAMETER,
  UNDEFINED_OBJECT: SQLSTATE_UNDEFINED_OBJECT,
  DUPLICATE_COLUMN: SQLSTATE_DUPLICATE_COLUMN,
  DUPLICATE_CURSOR: SQLSTATE_DUPLICATE_CURSOR,
  DUPLICATE_DATABASE: SQLSTATE_DUPLICATE_DATABASE,
  DUPLICATE_FUNCTION: SQLSTATE_DUPLICATE_FUNCTION,
  DUPLICATE_PSTATEMENT: SQLSTATE_DUPLICATE_PSTATEMENT,
  DUPLICATE_SCHEMA: SQLSTATE_DUPLICATE_SCHEMA,
  DUPLICATE_TABLE: SQLSTATE_DUPLICATE_TABLE,
  DUPLICATE_ALIAS: SQLSTATE_DUPLICATE_ALIAS,
  DUPLICATE_OBJECT: SQLSTATE_DUPLICATE_OBJECT,
  AMBIGUOUS_COLUMN: SQLSTATE_AMBIGUOUS_COLUMN,
  AMBIGUOUS_FUNCTION: SQLSTATE_AMBIGUOUS_FUNCTION,
  AMBIGUOUS_PARAMETER: SQLSTATE_AMBIGUOUS_PARAMETER,
  AMBIGUOUS_ALIAS: SQLSTATE_AMBIGUOUS_ALIAS,
  INVALID_COLUMN_REFERENCE: SQLSTATE_INVALID_COLUMN_REFERENCE,
  INVALID_CURSOR_DEFINITION: SQLSTATE_INVALID_CURSOR_DEFINITION,
  INVALID_DATABASE_DEFINITION: SQLSTATE_INVALID_DATABASE_DEFINITION,
  INVALID_FUNCTION_DEFINITION: SQLSTATE_INVALID_FUNCTION_DEFINITION,
  INVALID_PSTATEMENT_DEFINITION: SQLSTATE_INVALID_PSTATEMENT_DEFINITION,
  INVALID_SCHEMA_DEFINITION: SQLSTATE_INVALID_SCHEMA_DEFINITION,
  INVALID_TABLE_DEFINITION: SQLSTATE_INVALID_TABLE_DEFINITION,
  INVALID_OBJECT_DEFINITION: SQLSTATE_INVALID_OBJECT_DEFINITION,

  // Class 44
  WITH_CHECK_OPTION_VIOLATION: SQLSTATE_WITH_CHECK_OPTION_VIOLATION,

  // Class 53
  INSUFFICIENT_RESOURCES: SQLSTATE_INSUFFICIENT_RESOURCES,
  DISK_FULL: SQLSTATE_DISK_FULL,
  OUT_OF_MEMORY: SQLSTATE_OUT_OF_MEMORY,
  TOO_MANY_CONNECTIONS: SQLSTATE_TOO_MANY_CONNECTIONS,
  CONFIGURATION_LIMIT_EXCEEDED: SQLSTATE_CONFIGURATION_LIMIT_EXCEEDED,
  OUT_OF_LOCKS: SQLSTATE_OUT_OF_LOCKS,

  // Class 54
  PROGRAM_LIMIT_EXCEEDED: SQLSTATE_PROGRAM_LIMIT_EXCEEDED,
  STATEMENT_TOO_COMPLEX: SQLSTATE_STATEMENT_TOO_COMPLEX,
  TOO_MANY_COLUMNS: SQLSTATE_TOO_MANY_COLUMNS,
  TOO_MANY_ARGUMENTS: SQLSTATE_TOO_MANY_ARGUMENTS,

  // Class 55
  OBJECT_NOT_IN_PREREQUISITE_STATE: SQLSTATE_OBJECT_NOT_IN_PREREQUISITE_STATE,
  OBJECT_IN_USE: SQLSTATE_OBJECT_IN_USE,
  CANT_CHANGE_RUNTIME_PARAM: SQLSTATE_CANT_CHANGE_RUNTIME_PARAM,
  LOCK_NOT_AVAILABLE: SQLSTATE_LOCK_NOT_AVAILABLE,
  CANT_REFRESH_MATERIALIZED_VIEW: SQLSTATE_CANT_REFRESH_MATERIALIZED_VIEW,

  // Class 57
  ADMIN_SHUTDOWN: SQLSTATE_ADMIN_SHUTDOWN,
  CRASH_SHUTDOWN: SQLSTATE_CRASH_SHUTDOWN,
  CANNOT_CONNECT_NOW: SQLSTATE_CANNOT_CONNECT_NOW,
  DATABASE_DROPPED: SQLSTATE_DATABASE_DROPPED,
  IDLE_SESSION_TIMEOUT: SQLSTATE_IDLE_SESSION_TIMEOUT,
  IDLE_TRANSACTION_TIMEOUT: SQLSTATE_IDLE_TRANSACTION_TIMEOUT,
  QUERY_CANCELED: SQLSTATE_QUERY_CANCELED,

  // Class 58
  IO_ERROR: SQLSTATE_IO_ERROR,
  UNDEFINED_FILE: SQLSTATE_UNDEFINED_FILE,
  DUPLICATE_FILE: SQLSTATE_DUPLICATE_FILE,

  // Class 72
  SNAPSHOT_TOO_OLD: SQLSTATE_SNAPSHOT_TOO_OLD,

  // Class F0
  CONFIG_FILE_ERROR: SQLSTATE_CONFIG_FILE_ERROR,
  LOCK_FILE_EXISTS: SQLSTATE_LOCK_FILE_EXISTS,

  // Class HV
  FDW_ERROR: SQLSTATE_FDW_ERROR,
  FDW_COLUMN_NAME_NOT_FOUND: SQLSTATE_FDW_COLUMN_NAME_NOT_FOUND,
  FDW_DYNAMIC_PARAMETER_VALUE_NEEDED: SQLSTATE_FDW_DYNAMIC_PARAMETER_VALUE_NEEDED,
  FDW_FUNCTION_SEQUENCE_ERROR: SQLSTATE_FDW_FUNCTION_SEQUENCE_ERROR,
  FDW_INCONSISTENT_DESCRIPTOR_INFORMATION: SQLSTATE_FDW_INCONSISTENT_DESCRIPTOR_INFORMATION,
  FDW_INVALID_ATTRIBUTE_VALUE: SQLSTATE_FDW_INVALID_ATTRIBUTE_VALUE,
  FDW_INVALID_COLUMN_NAME: SQLSTATE_FDW_INVALID_COLUMN_NAME,
  FDW_INVALID_COLUMN_NUMBER: SQLSTATE_FDW_INVALID_COLUMN_NUMBER,
  FDW_INVALID_DATA_TYPE: SQLSTATE_FDW_INVALID_DATA_TYPE,
  FDW_INVALID_DATA_TYPE_DESCRIPTORS: SQLSTATE_FDW_INVALID_DATA_TYPE_DESCRIPTORS,
  FDW_INVALID_DESCRIPTOR_FIELD_IDENTIFIER: SQLSTATE_FDW_INVALID_DESCRIPTOR_FIELD_IDENTIFIER,
  FDW_INVALID_HANDLE: SQLSTATE_FDW_INVALID_HANDLE,
  FDW_INVALID_OPTION_INDEX: SQLSTATE_FDW_INVALID_OPTION_INDEX,
  FDW_INVALID_OPTION_NAME: SQLSTATE_FDW_INVALID_OPTION_NAME,
  FDW_INVALID_STRING_LENGTH_OR_BUFFER_LENGTH: SQLSTATE_FDW_INVALID_STRING_LENGTH_OR_BUFFER_LENGTH,
  FDW_INVALID_STRING_FORMAT: SQLSTATE_FDW_INVALID_STRING_FORMAT,
  FDW_INVALID_USE_OF_NULL_POINTER: SQLSTATE_FDW_INVALID_USE_OF_NULL_POINTER,
  FDW_NO_SCHEMAS: SQLSTATE_FDW_NO_SCHEMAS,
  FDW_OPTION_NAME_NOT_FOUND: SQLSTATE_FDW_OPTION_NAME_NOT_FOUND,
  FDW_REPLY_HANDLE: SQLSTATE_FDW_REPLY_HANDLE,
  FDW_SCHEMA_NOT_FOUND: SQLSTATE_FDW_SCHEMA_NOT_FOUND,
  FDW_TABLE_NOT_FOUND: SQLSTATE_FDW_TABLE_NOT_FOUND,
  FDW_UNABLE_TO_CREATE_EXECUTION: SQLSTATE_FDW_UNABLE_TO_CREATE_EXECUTION,
  FDW_UNABLE_TO_CREATE_REPLY: SQLSTATE_FDW_UNABLE_TO_CREATE_REPLY,
  FDW_UNABLE_TO_ESTABLISH_CONNECTION: SQLSTATE_FDW_UNABLE_TO_ESTABLISH_CONNECTION,

  // Class P0
  PLPGSQL_ERROR: SQLSTATE_PLPGSQL_ERROR,
  RAISE_EXCEPTION: SQLSTATE_RAISE_EXCEPTION,
  NO_DATA_FOUND: SQLSTATE_NO_DATA_FOUND,
  TOO_MANY_ROWS: SQLSTATE_TOO_MANY_ROWS,
  ASSERT_FAILURE: SQLSTATE_ASSERT_FAILURE,

  // Class XX
  INTERNAL_ERROR: SQLSTATE_INTERNAL_ERROR,
  DATA_CORRUPTED: SQLSTATE_DATA_CORRUPTED,
  INDEX_CORRUPTED: SQLSTATE_INDEX_CORRUPTED,
} as const;

export type SqlstateCode = (typeof SQLSTATE)[keyof typeof SQLSTATE];

/**
 * Get the class description for a SQLSTATE code.
 * @param code 5-char SQLSTATE code
 * @returns Class description or "Unknown"
 */
export function getSqlstateClass(code: string): string {
  const cls = code.slice(0, 2);
  return SQLSTATE_CLASSES[cls] || 'Unknown';
}

/**
 * Build an ErrorResponse-compatible error detail for a SQLSTATE code.
 * @param code 5-char SQLSTATE code
 * @returns Object with severity, code, and message
 */
export function sqlstateDetail(code: string): { severity: string; code: string; message: string } {
  const cls = getSqlstateClass(code);
  return {
    severity: code === '00000' ? 'LOG' : 'ERROR',
    code,
    message: `${cls} (${code})`,
  };
}
