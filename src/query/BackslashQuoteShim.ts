import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('backslash-quote');

/**
 * BackslashQuoteShim — PostgreSQL standard_conforming_strings and
 * escape_string_warning compatibility for SQLVec.
 *
 * PostgreSQL uses its own GUC parameters that control how backslashes
 * inside string literals are treated:
 *
 *   standard_conforming_strings = on
 *     → Backslashes in string literals are NOT treated as escape characters.
 *       This is the SQL-standard behaviour. 'O\'Brien' is NOT an escape
 *       sequence; the string literal contains O\, then 'Brien'.
 *
 *   standard_conforming_strings = off
 *     → Backslashes ARE escape characters. 'O\'Brien' is O'Brien (escape).
 *
 *   escape_string_warning = on
 *     → When standard_conforming_strings = on and a string literal contains
 *       a backslash, PostgreSQL emits a WARNING noting the deprecated syntax.
 *
 * This shim applies these settings to the SQLVec query context by:
 *   1. Tracking the current values per session
 *   2. Handling SET statements for these GUCs
 *   3. Reporting the current values via SHOW
 *   4. When standard_conforming_strings = on (the default), logging a
 *      warning if a backslash is found in a string literal
 *
 * Usage:
 *   const shim = new BackslashQuoteShim();
 *   shim.handleSet("SET standard_conforming_strings = on");
 *   shim.handleSet("SET escape_string_warning = on");
 *   console.log(shim.show('standard_conforming_strings')); // "on"
 */

export class BackslashQuoteShim {
  /** Per-session GUC values */
  private sessionSettings: Map<string, { standardConformingStrings: boolean; escapeStringWarning: boolean }> = new Map();

  /**
   * Get or create session settings.
   */
  private getSession(sessionId: string = 'default') {
    if (!this.sessionSettings.has(sessionId)) {
      this.sessionSettings.set(sessionId, {
        standardConformingStrings: true,  // SQL standard default
        escapeStringWarning: true,        // Warn by default
      });
    }
    return this.sessionSettings.get(sessionId)!;
  }

  /**
   * Handle a SET statement for the relevant GUCs.
   *
   * @param sql The SQL statement to process
   * @param sessionId Optional session identifier
   * @returns True if the statement was handled (consumed)
   */
  handleSet(sql: string, sessionId?: string): boolean {
    const trimmed = sql.trim().replace(/;+$/, '');
    const settings = this.getSession(sessionId);

    // SET standard_conforming_strings = on|off
    const scsMatch = trimmed.match(
      /^SET\s+standard_conforming_strings\s*=\s*(on|off|true|false|1|0)\s*;?$/i,
    );
    if (scsMatch) {
      const value = scsMatch[1].toLowerCase();
      settings.standardConformingStrings = ['on', 'true', '1'].includes(value);
      logger.debug({
        sessionId: sessionId || 'default',
        value: settings.standardConformingStrings,
      }, 'standard_conforming_strings set');
      return true;
    }

    // SET escape_string_warning = on|off
    const eswMatch = trimmed.match(
      /^SET\s+escape_string_warning\s*=\s*(on|off|true|false|1|0)\s*;?$/i,
    );
    if (eswMatch) {
      const value = eswMatch[1].toLowerCase();
      settings.escapeStringWarning = ['on', 'true', '1'].includes(value);
      logger.debug({
        sessionId: sessionId || 'default',
        value: settings.escapeStringWarning,
      }, 'escape_string_warning set');
      return true;
    }

    return false;
  }

  /**
   * Handle a SHOW statement for the relevant GUCs.
   *
   * @param param Parameter name (e.g. 'standard_conforming_strings')
   * @param sessionId Optional session identifier
   * @returns The parameter value as a string, or undefined if unknown
   */
  show(param: string, sessionId?: string): string | undefined {
    const settings = this.getSession(sessionId);
    const paramLower = param.toLowerCase().replace(/;+$/, '');

    switch (paramLower) {
      case 'standard_conforming_strings':
        return settings.standardConformingStrings ? 'on' : 'off';
      case 'escape_string_warning':
        return settings.escapeStringWarning ? 'on' : 'off';
      default:
        return undefined;
    }
  }

  /**
   * Check a SQL query for backslash usage in string literals and emit
   * a warning if escape_string_warning is enabled.
   *
   * @param sql       SQL to inspect
   * @param sessionId Optional session identifier
   * @returns Warnings (if any) to include in the response
   */
  checkEscapes(sql: string, sessionId?: string): string[] {
    const warnings: string[] = [];
    const settings = this.getSession(sessionId);

    if (!settings.escapeStringWarning) {
      return warnings;
    }

    // Find backslashes in single-quoted strings
    const stringLitRe = /'(?:[^'\\]|\\.)*'/g;
    let match;
    while ((match = stringLitRe.exec(sql)) !== null) {
      const lit = match[0];
      if (lit.includes('\\')) {
        // A backslash inside a string literal is only notable when
        // standard_conforming_strings is ON: in that mode the backslash is a
        // literal character, so an embedded `\'`-style sequence is likely a
        // mistake the user intended as an escape. With OFF, backslashes are
        // legitimate escapes and PostgreSQL emits no such warning.
        if (settings.standardConformingStrings) {
          warnings.push(
            `WARNING: non-standard escape sequence in string literal (standard_conforming_strings = on). ` +
            `Use E'...' for escape syntax if backslash escaping is intended.`,
          );
        } else {
          warnings.push(
            `HINT: Consider setting standard_conforming_strings = on for SQL-standard behaviour.`,
          );
        }
      }
    }

    return warnings;
  }

  /**
   * Get all current settings for all sessions.
   */
  getAllSettings(): Record<string, { standardConformingStrings: boolean; escapeStringWarning: boolean }> {
    const result: Record<string, any> = {};
    for (const [sessionId, settings] of this.sessionSettings) {
      result[sessionId] = { ...settings };
    }
    return result;
  }

  /**
   * Reset all settings to defaults.
   */
  reset(): void {
    this.sessionSettings.clear();
  }
}
