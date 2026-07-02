/**
 * CursorManager — PostgreSQL DECLARE/FETCH/MOVE/CLOSE cursor support
 *
 * Manages named cursors in memory for the SQL compatibility layer.
 * Supports:
 * - DECLARE name CURSOR FOR select_sql
 * - FETCH [NEXT|PRIOR|FIRST|LAST|ABSOLUTE n|RELATIVE n] FROM name
 * - MOVE [direction] [count] [FROM] name
 * - CLOSE name
 *
 * @module query/CursorManager
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('CursorManager');

export interface CursorConfig {
  /** Cursor name */
  name: string;
  /** The SELECT SQL that defines the cursor */
  sql: string;
  /** Whether SCROLL was specified (allows backward fetches) */
  scroll: boolean;
  /** WITH HOLD — cursor survives transaction boundaries */
  hold: boolean;
  /** All fetched rows (or rows passed at DECLARE time) */
  rows: any[][];
  /** Current position in the rows array (-1 = before first) */
  position: number;
  /** Column names for the result set */
  columns: string[];
  /** Session ID that owns this cursor */
  sessionId?: string;
}

export class CursorManager {
  private cursors = new Map<string, CursorConfig>();

  /**
   * Declare a new cursor.
   *
   * @param name - Cursor name
   * @param sql - The SELECT SQL
   * @param scroll - Enable SCROLL (backward fetching)
   * @param hold - WITH HOLD (survive transaction boundaries)
   * @param rows - Initial row data
   * @param columns - Column names
   * @param sessionId - Optional owning session ID
   */
  declare(
    name: string,
    sql: string,
    scroll: boolean,
    hold: boolean,
    rows: any[][],
    columns: string[],
    sessionId?: string,
  ): void {
    const key = this.normalizeKey(name);
    if (this.cursors.has(key)) {
      throw new Error(`Cursor "${name}" already exists`);
    }

    const config: CursorConfig = {
      name: key,
      sql,
      scroll,
      hold,
      rows,
      position: -1, // before first row
      columns,
      sessionId,
    };

    this.cursors.set(key, config);
    logger.debug(
      { name: key, rowCount: rows.length, scroll, hold },
      'Cursor declared',
    );
  }

  /**
   * Fetch rows from a cursor in the specified direction.
   *
   * @param name - Cursor name
   * @param direction - FETCH direction
   * @param count - Number of rows to fetch (1 for single row)
   * @returns The fetched rows as an array of arrays
   * @throws If cursor not found
   */
  fetch(
    name: string,
    direction: 'NEXT' | 'PRIOR' | 'FIRST' | 'LAST' | 'ABSOLUTE' | 'RELATIVE',
    count: number,
  ): any[][] {
    const cursor = this.getCursor(name);
    if (!cursor) {
      throw new Error(`Cursor "${name}" not found`);
    }

    return this.doFetch(cursor, direction, count);
  }

  /**
   * Move the cursor position without fetching rows.
   *
   * @param name - Cursor name
   * @param direction - Move direction
   * @param count - Number of positions to move
   * @returns The number of rows moved over (actual moves)
   */
  move(name: string, direction: string, count: number): number {
    const cursor = this.getCursor(name);
    if (!cursor) {
      throw new Error(`Cursor "${name}" not found`);
    }

    const oldPos = cursor.position;
    const dir = direction.toUpperCase() as CursorConfig['scroll'] extends boolean ? string : string;

    switch (dir) {
      case 'NEXT':
        cursor.position = Math.min(cursor.position + count, cursor.rows.length - 1);
        break;
      case 'PRIOR':
        if (cursor.scroll) {
          cursor.position = Math.max(cursor.position - count, -1);
        } else {
          throw new Error('Cannot move backward on a non-scroll cursor');
        }
        break;
      case 'FIRST':
        cursor.position = count > 0 ? Math.min(count - 1, cursor.rows.length - 1) : -1;
        break;
      case 'LAST':
        cursor.position = cursor.rows.length - 1;
        break;
      case 'ABSOLUTE':
        cursor.position = Math.max(-1, Math.min(count - 1, cursor.rows.length - 1));
        break;
      case 'RELATIVE':
        cursor.position = Math.max(-1, Math.min(cursor.position + count, cursor.rows.length - 1));
        break;
      default:
        // Default to NEXT
        cursor.position = Math.min(cursor.position + count, cursor.rows.length - 1);
    }

    return Math.abs(cursor.position - oldPos);
  }

  /**
   * Close a cursor.
   *
   * @param name - Cursor name to close
   */
  close(name: string): void {
    const key = this.normalizeKey(name);
    const existed = this.cursors.delete(key);
    if (existed) {
      logger.debug({ name: key }, 'Cursor closed');
    }
  }

  /**
   * Close all cursors owned by a session.
   *
   * @param sessionId - Session ID
   */
  closeAll(sessionId: string): void {
    let count = 0;
    for (const [key, cursor] of this.cursors.entries()) {
      if (cursor.sessionId === sessionId) {
        this.cursors.delete(key);
        count++;
      }
    }
    if (count > 0) {
      logger.debug({ sessionId, count }, 'Session cursors closed');
    }
  }

  /**
   * Get cursor configuration.
   */
  getCursor(name: string): CursorConfig | undefined {
    const key = this.normalizeKey(name);
    return this.cursors.get(key);
  }

  /**
   * List all cursor names.
   */
  listCursors(): string[] {
    return Array.from(this.cursors.keys());
  }

  /**
   * Check if a cursor exists.
   */
  hasCursor(name: string): boolean {
    return this.cursors.has(this.normalizeKey(name));
  }

  /**
   * Clear all cursors.
   */
  clear(): void {
    this.cursors.clear();
    logger.debug('All cursors cleared');
  }

  /**
   * Get cursor stats.
   */
  getStats(): { count: number; cursorNames: string[] } {
    return {
      count: this.cursors.size,
      cursorNames: this.listCursors(),
    };
  }

  // ── Private helpers ──────────────────────────────

  private normalizeKey(name: string): string {
    return name.toLowerCase();
  }

  /**
   * Perform the actual fetch operation.
   */
  private doFetch(
    cursor: CursorConfig,
    direction: string,
    count: number,
  ): any[][] {
    const dir = direction.toUpperCase();
    const results: any[][] = [];
    const rows = cursor.rows;
    const len = rows.length;

    if (len === 0) {
      return results; // empty cursor
    }

    switch (dir) {
      case 'NEXT': {
        const start = Math.max(cursor.position + 1, 0);
        const end = Math.min(start + count, len);
        for (let i = start; i < end; i++) {
          results.push(rows[i]);
        }
        cursor.position = end > 0 ? end - 1 : -1;
        break;
      }

      case 'PRIOR': {
        if (!cursor.scroll) {
          throw new Error('Cannot fetch backward on a non-scroll cursor');
        }
        const start = Math.max(cursor.position - count, -1);
        const end = cursor.position;
        for (let i = end - 1; i > start; i--) {
          results.push(rows[i]);
        }
        cursor.position = start + 1;
        break;
      }

      case 'FIRST': {
        cursor.position = -1;
        const end = Math.min(count, len);
        for (let i = 0; i < end; i++) {
          results.push(rows[i]);
        }
        cursor.position = end - 1;
        break;
      }

      case 'LAST': {
        const start = Math.max(len - count, 0);
        cursor.position = start - 1;
        for (let i = start; i < len; i++) {
          results.push(rows[i]);
        }
        cursor.position = len - 1;
        break;
      }

      case 'ABSOLUTE': {
        const idx = Math.max(0, Math.min(count - 1, len - 1));
        if (idx >= 0 && idx < len) {
          results.push(rows[idx]);
          cursor.position = idx;
        }
        break;
      }

      case 'RELATIVE': {
        const idx = Math.max(0, Math.min(cursor.position + count, len - 1));
        if (idx >= 0 && idx < len) {
          results.push(rows[idx]);
          cursor.position = idx;
        }
        break;
      }

      default: {
        // Default: NEXT behavior
        const start = Math.max(cursor.position + 1, 0);
        const end = Math.min(start + count, len);
        for (let i = start; i < end; i++) {
          results.push(rows[i]);
        }
        cursor.position = end > 0 ? end - 1 : -1;
      }
    }

    return results;
  }
}
