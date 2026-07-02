/**
 * ConfigValidator — Zod-based configuration validation for SqlVec DB
 *
 * Validates DatabaseConfig objects against Zod schemas.
 * Zod is optional at runtime — validation failures produce warnings, not crashes.
 */

import { SqlVecConfigSchema, SqlVecRawConfigSchema } from './ConfigSchema';
import type { SqlVecConfigInferred } from './ConfigSchema';

import { PinoLogger } from '../logger/PinoLogger';
const logger = PinoLogger.forComponent('ConfigValidator');

export interface ValidationResult {
  success: boolean;
  data?: SqlVecConfigInferred;
  errors?: Array<{ path: string; message: string }>;
}

export class ConfigValidator {
  /**
   * Validate a complete DatabaseConfig object against the Zod schema.
   * Returns structured result with success/errors.
   * Zod is optional: on failure, returns errors but does not throw.
   */
  static validate(config: unknown): ValidationResult {
    const result = SqlVecConfigSchema.safeParse(config);

    if (result.success) {
      return { success: true, data: result.data };
    }

    const errors = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    logger.warn(
      '[ConfigValidator] Config validation failed:\n' +
        errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n'),
    );

    return { success: false, errors };
  }

  /**
   * Validate a partial (raw/unparsed) config object.
   * Useful for checking config input before the full parseConfig() pass.
   */
  static validatePartial(config: unknown): ValidationResult {
    const result = SqlVecRawConfigSchema.safeParse(config);

    if (result.success) {
      return { success: true, data: result.data as unknown as SqlVecConfigInferred };
    }

    const errors = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    return { success: false, errors };
  }

  /**
   * Validate a single port number (1-65535).
   */
  static validatePort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }

  /**
   * Validate a host string (non-empty).
   */
  static validateHost(host: string): boolean {
    return typeof host === 'string' && host.trim().length > 0;
  }

  /**
   * Validate a node ID string (non-empty).
   */
  static validateNodeId(id: string): boolean {
    return typeof id === 'string' && id.trim().length > 0;
  }

  /**
   * Validate and return formatted error messages as a single string.
   * Returns null if config is valid.
   */
  static formatErrors(config: unknown): string | null {
    const result = SqlVecConfigSchema.safeParse(config);
    if (result.success) return null;

    return result.error.issues
      .map((issue) => `  [${issue.path.join('.')}] ${issue.message}`)
      .join('\n');
  }
}
