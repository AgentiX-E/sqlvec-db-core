/**
 * System index — re-exports all system modules for convenience
 */

export { SystemTypeRegistry, PgTypeCategory } from './SystemTypes';
export type { PgTypeInfo } from './SystemTypes';

export { SystemFunctionRegistry } from './SystemFunctions';
export type { SysFnInfo, SysFnHandler } from './SystemFunctions';

export { SystemCatalog } from './SystemCatalog';
export type { SystemViewRow, SystemViewColumn, SystemViewDefinition, TableEntry } from './SystemCatalog';

export { PgCatalog } from './PgCatalog';

export { SystemIntegration } from './SystemIntegration';
export type { SystemQueryResult } from './SystemIntegration';
