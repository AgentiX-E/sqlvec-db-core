export { SqlVecDatabase } from './SqlVecDatabase';
export { PinoLogger } from './logger/PinoLogger';
export type { ILogger, NoOpLogger } from './interfaces/logger';
export type { FeatureFlags } from './types';
export { ShardManager } from './storage/ShardManager';
export { DuckDBAnalyticsManager, getDuckDBAnalyticsManager } from './analytics/DuckDBAnalyticsManager';
export { VectorEngine } from './vector/VectorEngine';
