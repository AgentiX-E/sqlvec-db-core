/**
 * GucPersistence — PostgreSQL postgresql.conf compatibility layer.
 *
 * Reads/writes postgresql.conf-style configuration files, and provides
 * `pg_reload_conf()` simulation for GUC values that support SIGHUP reload.
 *
 * Format rules (following PostgreSQL convention):
 *   - `key = value` with '=' separator
 *   - `#` for comments (inline + full-line)
 *   - String values in single quotes
 *   - Numbers and booleans without quotes
 *   - Unit suffixes: kB, MB, GB, s, ms, min
 *   - Empty lines / whitespace ignored
 *
 * @module config/GucPersistence
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('GucPersistence');

// ── Types ────────────────────────────────────────────────────────────────

export interface GucConfigLine {
  key: string;
  value: string;
  comment?: string;
  indent?: string;
}

// ── GucPersistence ────────────────────────────────────────────────────────

export class GucPersistence {
  private readonly autoConfPath: string;

  /**
   * @param baseDir - Directory where postgresql.auto.conf lives (usually the data dir).
   */
  constructor(baseDir: string) {
    this.autoConfPath = path.resolve(baseDir, 'postgresql.auto.conf');
  }

  // ── Single-line parsing ─────────────────────────────────────────────────

  /**
   * Parse a single line from a postgresql.conf-style file.
   *
   * Handles:
   *   - `key = value`
   *   - `key = 'value'` (single-quoted strings)
   *   - `# comment`
   *   - `key = value # inline comment`
   *   - Empty lines and whitespace-only lines (returns null)
   *
   * @param line - A single line of config text (may contain trailing newline).
   * @returns An object with `key` and `value`, or `null` if the line is empty/a comment.
   */
  parseLine(line: string): { key: string; value: string } | null {
    const trimmed = line.trim();

    // Empty or comment-only
    if (!trimmed || trimmed.startsWith('#')) {
      return null;
    }

    // Strip inline comment (respecting quotes)
    const commentFree = this.stripInlineComment(trimmed);
    if (!commentFree) return null;

    // Find the '=' separator
    const eqIdx = commentFree.indexOf('=');
    if (eqIdx === -1) return null;

    const key = commentFree.substring(0, eqIdx).trim();
    let rawValue = commentFree.substring(eqIdx + 1).trim();

    if (!key) return null;

    // Remove surrounding single quotes
    if (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2) {
      rawValue = rawValue.slice(1, -1);
    }

    // Unescape PostgreSQL doubled single quotes: '' → ' in quoted strings.
    rawValue = rawValue.replace(/''/g, "'");

    return { key: key.toLowerCase(), value: rawValue };
  }

  /**
   * Parse an entire postgresql.conf-style file into key-value pairs.
   *
   * @param filePath - Path to the config file.
   * @returns A record of all parsed settings (key → value).
   */
  parseConfigFile(filePath: string): Record<string, string> {
    const result: Record<string, string> = {};
    const absPath = path.resolve(filePath);

    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const parsed = this.parseLine(line);
        if (parsed) {
          result[parsed.key] = parsed.value;
        }
      }
    } catch (err: any) {
      logger.error({ filePath: absPath, err: err.message }, 'Failed to parse config file');
      return result;
    }

    return result;
  }

  // ── postgresql.auto.conf I/O ────────────────────────────────────────────

  /**
   * Read the current postgresql.auto.conf file.
   *
   * @returns A record of parsed settings, or an empty object if the file does not exist.
   */
  readAutoConf(): Record<string, string> {
    try {
      return this.parseConfigFile(this.autoConfPath);
    } catch {
      return {};
    }
  }

  /**
   * Write settings to postgresql.auto.conf, overwriting existing content.
   *
   * @param settings - Key-value pairs to write.
   */
  writeAutoConf(settings: Record<string, string>): void {
    const configText = this.formatAsConfig(settings);
    const dir = path.dirname(this.autoConfPath);

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.autoConfPath, configText, 'utf-8');
      logger.info({ path: this.autoConfPath, count: Object.keys(settings).length }, 'postgresql.auto.conf written');
    } catch (err: any) {
      logger.error({ path: this.autoConfPath, err: err.message }, 'Failed to write postgresql.auto.conf');
      throw new Error(`Cannot write to ${this.autoConfPath}: ${err.message}`);
    }
  }

  /**
   * Update specific settings in postgresql.auto.conf, preserving existing entries.
   * Merges new settings with existing ones. If `overwrite` is true, existing values
   * are replaced; otherwise only new keys are added.
   *
   * @param settings - Key-value pairs to upsert.
   * @param overwrite - If true, overwrite existing values (default: true).
   */
  updateAutoConf(settings: Record<string, string>, overwrite: boolean = true): void {
    const existing = this.readAutoConf();

    for (const [key, value] of Object.entries(settings)) {
      if (overwrite || !(key in existing)) {
        existing[key] = value;
      }
    }

    this.writeAutoConf(existing);
  }

  // ── Formatting ──────────────────────────────────────────────────────────

  /**
   * Format settings as postgresql.conf-style text.
   *
   * Format rules:
   *   - `key = value` per line
   *   - String values in single quotes
   *   - Numbers/booleans without quotes
   *   - Values with trailing unit suffixes recognized and written bare
   *
   * @param settings - Key-value pairs to format.
   * @returns The config text (with trailing newline).
   */
  formatAsConfig(settings: Record<string, string>): string {
    const lines: string[] = [];
    lines.push('# Generated by SqlVec DB GucPersistence');
    lines.push(`# ${new Date().toISOString()}`);
    lines.push('');

    for (const [key, value] of Object.entries(settings)) {
      const formatted = this.formatSetting(key, value);
      lines.push(formatted);
    }

    lines.push('');
    return lines.join('\n');
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Format a single setting as `key = value`.
   */
  private formatSetting(key: string, value: string): string {
    const needsQuoting = this.valueNeedsQuoting(value);
    const formattedValue = needsQuoting ? `'${this.escapeQuotes(value)}'` : value;
    return `${key} = ${formattedValue}`;
  }

  /**
   * Determine if a value needs single-quoting.
   *
   * Values that need quoting:
   *   - Contain spaces or special characters
   *   - Are empty strings
   *   - Are not recognized as numbers, booleans, or unit-suffixed values
   */
  private valueNeedsQuoting(value: string): boolean {
    if (!value) return true;

    // Booleans
    if (['on', 'off', 'true', 'false', 'yes', 'no'].includes(value.toLowerCase())) {
      return false;
    }

    // Numbers (optionally with unit suffix)
    if (/^-?\d+(\.\d+)?\s*(kB|MB|GB|TB|s|ms|min|h)?$/i.test(value)) {
      return false;
    }

    // Already quoted
    if (value.startsWith("'") && value.endsWith("'")) {
      return false;
    }

    // Check if it contains only safe characters
    if (/^[a-zA-Z0-9_./\\:-]+$/.test(value)) {
      return false;
    }

    return true;
  }

  /**
   * Escape single quotes in a value for config file output.
   */
  private escapeQuotes(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Strip inline comments (#) from a line, respecting single quotes.
   *
   * @param line - The input line.
   * @returns The line without inline comment, or null if empty.
   */
  private stripInlineComment(line: string): string | null {
    let result = '';
    let inQuote = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === "'") {
        inQuote = !inQuote;
        result += ch;
        continue;
      }

      if (ch === '#' && !inQuote) {
        // Stop at comment (but don't include the #)
        break;
      }

      result += ch;
    }

    return result.trim() || null;
  }
}

// ── pg_reload_conf simulation ────────────────────────────────────────────

/**
 * Simulate `pg_reload_conf()` by applying SIGHUP-level settings from a
 * postgresql.auto.conf-style settings record to a database's GUC registry.
 *
 * This is equivalent to PostgreSQL's SIGHUP reload signal — only GUCs with
 * context `sighup` or `user` are applied. `postmaster` and `internal` GUCs
 * are skipped (they require restart).
 *
 * @param db - A database-like object (must expose a GUC system or exec method).
 * @param settings - Key-value pairs of settings to apply.
 * @returns `true` if the reload was applied (even if some settings were skipped).
 */
export async function pgReloadConf(
  db: { exec?: (sql: string) => Promise<any>; gucSystem?: { handleSet: (name: string, value: string) => string | null } },
  settings: Record<string, string>,
): Promise<boolean> {
  let appliedCount = 0;
  let skippedCount = 0;

  // Method 1: Apply via GucSystem if available
  if (db.gucSystem) {
    for (const [key, value] of Object.entries(settings)) {
      const result = db.gucSystem.handleSet(key, value);
      if (result === null) {
        appliedCount++;
      } else {
        // GUC might not exist or be non-reloadable — just count as skipped
        skippedCount++;
      }
    }
    logger.info({ applied: appliedCount, skipped: skippedCount }, 'pg_reload_conf applied via GucSystem');
    return true;
  }

  // Method 2: Apply via SET command if possible
  if (db.exec) {
    for (const [key, value] of Object.entries(settings)) {
      try {
        await db.exec(`SET ${key} = '${value.replace(/'/g, "''")}'`);
        appliedCount++;
      } catch {
        skippedCount++;
      }
    }
    logger.info({ applied: appliedCount, skipped: skippedCount }, 'pg_reload_conf applied via SET');
    return true;
  }

  logger.warn('pg_reload_conf: no GucSystem or exec method available');
  return false;
}
