/**
 * DoBlockHandler — PL/pgSQL DO anonymous block execution handler.
 *
 * Bridges QueryRouter to PlPgSqlEngine for DO $$...$$ blocks.
 * Handles:
 *  - DO $$ ... $$
 *  - DO $tag$ ... $tag$
 *  - DO LANGUAGE plpgsql $$ ... $$
 *
 * RAISE NOTICE output is collected into a notices array that is returned
 * as part of the execution result. If the wire protocol (NoticeResponse)
 * is not available, notices are at least logged and do not cause crashes.
 *
 * @module query/DoBlockHandler
 */

import { PinoLogger } from '../logger/PinoLogger';
import { createPlPgSqlEngine, PlPgSqlEngine } from '../plpgsql/PlPgSqlEngine';

// ── Logger ───────────────────────────────────────────────────────
const logger = PinoLogger.forComponent('DoBlockHandler');

// ── Types ────────────────────────────────────────────────────────

export interface DoBlockResult {
  success: boolean;
  notices: string[];
  error?: string;
  /** Variable state after execution (for debugging/inspection) */
  variables?: Record<string, any>;
  /** Return value if the block had a RETURN statement */
  returnValue?: any;
}

// ── Dollar-quoting detection ─────────────────────────────────────

/**
 * Regex patterns for detecting DO anonymous blocks with dollar quoting.
 * Supports:
 *  - DO $$ ... $$
 *  - DO $tag$ ... $tag$
 *  - DO LANGUAGE plpgsql $$ ... $$
 *  - DO LANGUAGE plpgsql $tag$ ... $tag$
 */
const DO_BLOCK_DETECT_RE = /^\s*DO\b/i;

/**
 * Extract the body from a DO $$...$$ or DO $tag$...$tag$ block.
 * Returns null if the SQL is not a valid DO block.
 *
 * @param sql - The full SQL string.
 * @returns The extracted PL/pgSQL body, or null if not a DO block.
 */
export function extractDoBody(sql: string): string | null {
  const trimmed = sql.trim();

  // Must start with DO (case-insensitive)
  if (!DO_BLOCK_DETECT_RE.test(trimmed)) {
    return null;
  }

  // Strip the leading DO [LANGUAGE name]
  const afterDo = trimmed.replace(/^\s*DO\s+(?:LANGUAGE\s+\w+\s+)?/i, '');

  // Match dollar-quoted string: $$...$$ or $tag$...$tag$
  // Dollar quoting: starts with $, then optional tag, then $
  if (afterDo.startsWith('$')) {
    // Find the tag: $$ or $tag$
    const closeQuoteIdx = afterDo.indexOf('$', 1);
    if (closeQuoteIdx === -1) return null;

    const tag = afterDo.substring(1, closeQuoteIdx); // '' for $$, or 'tag' for $tag$
    const openQuote = '$' + tag + '$';
    const closeQuote = '$' + tag + '$';

    if (!afterDo.startsWith(openQuote)) return null;

    // Find closing dollar quote
    const bodyStart = openQuote.length;
    const bodyEnd = afterDo.indexOf(closeQuote, bodyStart);
    if (bodyEnd === -1) return null;

    const body = afterDo.substring(bodyStart, bodyEnd).trim();
    if (!body) return null;

    return body;
  }

  // Match single-quoted string: DO 'body'
  if (afterDo.startsWith("'")) {
    // Find closing single quote (allow escaped quotes)
    let endQuote = -1;
    for (let i = 1; i < afterDo.length; i++) {
      if (afterDo[i] === "'" && afterDo[i - 1] !== '\\') {
        endQuote = i;
        break;
      }
    }
    if (endQuote === -1) return null;

    const body = afterDo.substring(1, endQuote).trim();
    if (!body) return null;

    return body;
  }

  return null;
}

/**
 * Detect whether a SQL string is a DO anonymous block.
 * Must start with "DO" followed by a dollar-quoted or single-quoted body.
 *
 * @param sql - The SQL string to check.
 * @returns true if the SQL is a DO block.
 */
export function detectDoBlock(sql: string): boolean {
  const trimmed = sql.trim();
  if (!DO_BLOCK_DETECT_RE.test(trimmed)) return false;

  const afterDo = trimmed.replace(/^\s*DO\s+(?:LANGUAGE\s+\w+\s+)?/i, '');
  // Must have dollar-quoting or single-quoting immediately after
  return afterDo.startsWith('$') || afterDo.startsWith("'");
}

// ── DoBlockHandler ───────────────────────────────────────────────

/**
 * DoBlockHandler — Executes PL/pgSQL DO anonymous blocks.
 *
 * Maintains a singleton PlPgSqlEngine instance and provides
 * an execute() method that QueryRouter can call.
 *
 * Usage:
 * ```typescript
 * const handler = new DoBlockHandler();
 * await handler.start();
 * const result = await handler.execute('DO $$ BEGIN RAISE NOTICE ''hello''; END $$;');
 * console.log(result.notices); // ['NOTICE: hello']
 * ```
 */
export class DoBlockHandler {
  private engine: PlPgSqlEngine | null = null;
  private _started: boolean = false;
  private readonly logger = PinoLogger.forComponent('DoBlockHandler');

  /**
   * Start the handler (initializes PlPgSqlEngine backend).
   * Idempotent — safe to call multiple times.
   */
  async start(): Promise<void> {
    if (this._started) return;
    this.engine = createPlPgSqlEngine();
    try {
      await this.engine.start();
    } catch (err) {
      logger.warn({ err }, 'Failed to start PGlite backend for DO blocks — using local evaluator only');
    }
    this._started = true;
  }

  /**
   * Execute a DO anonymous block.
   *
   * @param sql - The full DO $$...$$ SQL statement.
   * @returns DoBlockResult with success/error status and collected notices.
   */
  async execute(sql: string): Promise<DoBlockResult> {
    const notices: string[] = [];

    // Ensure started
    if (!this._started) {
      await this.start();
    }

    if (!this.engine) {
      return {
        success: false,
        notices,
        error: 'PlPgSqlEngine not available',
      };
    }

    // Extract the PL/pgSQL body
    const rawBody = extractDoBody(sql);
    if (!rawBody) {
      return {
        success: false,
        notices,
        error: 'Could not extract PL/pgSQL body from DO block',
      };
    }

    // Ensure body ends with a semicolon — the PL/pgSQL parser expects END;
    let body = rawBody.trim();
    if (body.length > 0 && !body.endsWith(';')) {
      body = body + ';';
    }

    logger.debug({ body: body.slice(0, 200) }, 'Executing DO block');

    // Set notice callback to collect RAISE NOTICE output
    this.engine.setNoticeCallback((level: string, message: string) => {
      const notice = `${level}: ${message}`;
      notices.push(notice);
      logger.info(notice, 'DO notice');
    });

    // Execute via PlPgSqlEngine
    let result;
    try {
      result = await this.engine.execute(body);
    } catch (err: any) {
      // Clear callback on error
      if (this.engine) {
        this.engine.setNoticeCallback(null);
      }
      return {
        success: false,
        notices,
        error: err.message || String(err),
      };
    } finally {
      // Clear callback after execution
      if (this.engine) {
        this.engine.setNoticeCallback(null);
      }
    }

    if (result.success) {
      logger.debug({ variables: result.variables }, 'DO block executed successfully');
      return {
        success: true,
        notices,
        variables: result.variables,
        returnValue: result.returnValue,
      };
    }

    logger.error({ err: result.error }, 'DO block execution failed');
    return {
      success: false,
      notices,
      error: result.error,
      variables: result.variables,
    };
  }

  /**
   * Check whether the handler is started and ready.
   */
  get isStarted(): boolean {
    return this._started && this.engine !== null;
  }

  /**
   * Stop the handler and clean up.
   */
  async stop(): Promise<void> {
    if (this.engine) {
      await this.engine.stop();
    }
    this.engine = null;
    this._started = false;
  }

  /**
   * Reset state (for testing).
   */
  async reset(): Promise<void> {
    await this.stop();
  }
}
