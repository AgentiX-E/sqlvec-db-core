/**
 * Re-export of the canonical TDE configuration module.
 *
 * The `tde/` directory is the single source of truth for transparent data
 * encryption; this module re-exports it so the `storage/` layer (and its
 * consumers) reference one implementation instead of a duplicated copy.
 *
 * @module storage/TDEConfig
 */
export { TDEConfig } from '../tde/TDEConfig';
export type { TDEAlgorithm, EncryptionPolicy } from '../tde/TDEConfig';
