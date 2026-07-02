/**
 * query/index.ts — Re-exports all query-level modules
 */

export { EarthdistanceShim } from './EarthdistanceShim';
export { LtreeShim } from './LtreeShim';
export { LtreePath, LtreeLabel } from './LtreeShim';
export { EarthPoint, GeoPoint } from './EarthdistanceShim';

// LATERAL correlation support
export {
  detectCorrelation,
} from './CorrelationDetector';
export type {
  CorrelationRef,
  CorrelationResult,
} from './CorrelationDetector';

export {
  rewriteLateralEnhanced,
} from './EnhancedLateralRewriter';
export type {
  EnhancedLateralOptions,
  EnhancedLateralResult,
} from './EnhancedLateralRewriter';

// Legacy functional exports (deprecated, prefer class APIs above)
export {
  ltree,
  ltree2text,
  nlevel,
  subltree,
  ancestorOf,
  descendantOf,
  concat,
  ltreeMatch,
  anyLabelMatch,
  textSearch,
  isLtreeModuleEnabled,
  detectLtreeFunctions,
  evaluateLtreeFunction,
} from './LtreeShim';
