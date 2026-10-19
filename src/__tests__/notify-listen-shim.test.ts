/**
 * notify-listen-shim.test.ts — Coverage tests for NotifyListenShim
 * (PostgreSQL NOTIFY/LISTEN/UNLISTEN compatibility shim).
 */

import { describe, it, expect } from 'vitest';
import {
  detectNotifyListen,
  handleNotifyListen,
  extractChannel,
  getNotifyListenInitSql,
  _isNotifyListenStart,
  _unquotePayload,
  NOTIFY_QUEUE_TABLE,
  NOTIFY_LISTENERS_TABLE,
} from '../query/NotifyListenShim';

describe('detectNotifyListen', () => {
  it('returns false for non-string input', () => {
    expect(detectNotifyListen(undefined as unknown as string)).toBe(false);
    expect(detectNotifyListen(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectNotifyListen('')).toBe(false);
    expect(detectNotifyListen('   ')).toBe(false);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectNotifyListen('SELECT 1')).toBe(false);
    expect(detectNotifyListen('CREATE TABLE t (id INT)')).toBe(false);
  });

  it('detects NOTIFY', () => {
    expect(detectNotifyListen('NOTIFY my_channel')).toBe(true);
    expect(detectNotifyListen('NOTIFY my_channel;')).toBe(true);
  });

  it('detects LISTEN', () => {
    expect(detectNotifyListen('LISTEN my_channel')).toBe(true);
    expect(detectNotifyListen('LISTEN my_channel;')).toBe(true);
  });

  it('detects UNLISTEN', () => {
    expect(detectNotifyListen('UNLISTEN *')).toBe(true);
    expect(detectNotifyListen('UNLISTEN my_channel;')).toBe(true);
  });

  it('returns false for bare keyword without channel or whitespace', () => {
    expect(detectNotifyListen('NOTIFY;')).toBe(false);
    expect(detectNotifyListen('LISTEN;')).toBe(false);
    expect(detectNotifyListen('UNLISTEN;')).toBe(false);
  });

  it('returns false for keyword prefix but not a real statement', () => {
    expect(detectNotifyListen('NOTIFYING something')).toBe(false);
  });
});

describe('handleNotifyListen', () => {
  it('returns passthrough for non-string input', () => {
    expect(handleNotifyListen(undefined as unknown as string)).toEqual({
      sql: null,
      rewritten: false,
      stmtType: 'none',
    });
  });

  it('returns passthrough for empty string', () => {
    expect(handleNotifyListen('')).toEqual({ sql: '', rewritten: false, stmtType: 'none' });
  });

  it('rewrites NOTIFY without payload', () => {
    const r = handleNotifyListen('NOTIFY my_channel');
    expect(r.rewritten).toBe(true);
    expect(r.stmtType).toBe('notify');
    expect(r.channel).toBe('my_channel');
    expect(r.sql).toBe(`INSERT INTO ${NOTIFY_QUEUE_TABLE} (channel, pid) VALUES ('my_channel', 0)`);
  });

  it('rewrites NOTIFY with standard quoted payload', () => {
    const r = handleNotifyListen("NOTIFY my_channel, 'hello world'");
    expect(r.rewritten).toBe(true);
    expect(r.payload).toBe("'hello world'");
    expect(r.sql).toBe(`INSERT INTO ${NOTIFY_QUEUE_TABLE} (channel, payload, pid) VALUES ('my_channel', 'hello world', 0)`);
  });

  it('rewrites NOTIFY with dollar-quoted payload', () => {
    const r = handleNotifyListen('NOTIFY my_channel, $$dollar quoted$$');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'dollar quoted'");
  });

  it('rewrites NOTIFY with escape-string payload', () => {
    const r = handleNotifyListen("NOTIFY my_channel, E'escaped'");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'escaped'");
  });

  it('rewrites NOTIFY with quoted channel', () => {
    const r = handleNotifyListen('NOTIFY "quoted-channel"');
    expect(r.rewritten).toBe(true);
    expect(r.channel).toBe('quoted-channel');
    expect(r.sql).toContain("'quoted-channel'");
  });

  it('rewrites LISTEN with custom session id', () => {
    const r = handleNotifyListen('LISTEN my_channel', { sessionId: 'conn-123' });
    expect(r.rewritten).toBe(true);
    expect(r.stmtType).toBe('listen');
    expect(r.channel).toBe('my_channel');
    expect(r.sql).toBe(`INSERT OR IGNORE INTO ${NOTIFY_LISTENERS_TABLE} (channel, session_id) VALUES ('my_channel', 'conn-123')`);
  });

  it('rewrites LISTEN with default session id', () => {
    const r = handleNotifyListen('LISTEN my_channel');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("VALUES ('my_channel', 'pg_shim')");
  });

  it('rewrites LISTEN with quoted channel', () => {
    const r = handleNotifyListen('LISTEN "quoted-channel"');
    expect(r.rewritten).toBe(true);
    expect(r.channel).toBe('quoted-channel');
  });

  it('rewrites UNLISTEN specific channel', () => {
    const r = handleNotifyListen('UNLISTEN my_channel', { sessionId: 's1' });
    expect(r.rewritten).toBe(true);
    expect(r.stmtType).toBe('unlisten');
    expect(r.channel).toBe('my_channel');
    expect(r.sql).toBe(`DELETE FROM ${NOTIFY_LISTENERS_TABLE} WHERE channel = 'my_channel' AND session_id = 's1'`);
  });

  it('rewrites UNLISTEN * to delete all listeners for session', () => {
    const r = handleNotifyListen('UNLISTEN *', { sessionId: 's1' });
    expect(r.rewritten).toBe(true);
    expect(r.stmtType).toBe('unlisten');
    expect(r.channel).toBe('*');
    expect(r.sql).toBe(`DELETE FROM ${NOTIFY_LISTENERS_TABLE} WHERE session_id = 's1'`);
  });

  it('passes through unrelated SQL', () => {
    expect(handleNotifyListen('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false, stmtType: 'none' });
  });
});

describe('extractChannel', () => {
  it('returns null for non-string input', () => {
    expect(extractChannel(undefined as unknown as string)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractChannel('')).toBeNull();
  });

  it('extracts channel from NOTIFY', () => {
    expect(extractChannel('NOTIFY my_channel')).toBe('my_channel');
  });

  it('extracts channel from LISTEN', () => {
    expect(extractChannel('LISTEN my_channel')).toBe('my_channel');
  });

  it('extracts channel from UNLISTEN', () => {
    expect(extractChannel('UNLISTEN my_channel')).toBe('my_channel');
  });

  it('extracts * from UNLISTEN *', () => {
    expect(extractChannel('UNLISTEN *')).toBe('*');
  });

  it('extracts unquoted channel from quoted identifier', () => {
    expect(extractChannel('NOTIFY "quoted-channel"')).toBe('quoted-channel');
  });

  it('returns null for unrelated SQL', () => {
    expect(extractChannel('SELECT 1')).toBeNull();
  });
});

describe('helpers and constants', () => {
  it('getNotifyListenInitSql returns two DDL statements', () => {
    const ddl = getNotifyListenInitSql();
    expect(ddl).toHaveLength(2);
    expect(ddl[0]).toContain(`CREATE TABLE IF NOT EXISTS ${NOTIFY_QUEUE_TABLE}`);
    expect(ddl[1]).toContain(`CREATE TABLE IF NOT EXISTS ${NOTIFY_LISTENERS_TABLE}`);
  });

  it('_isNotifyListenStart detects notify/listen/unlisten prefix', () => {
    expect(_isNotifyListenStart('NOTIFY ch')).toBe(true);
    expect(_isNotifyListenStart('LISTEN ch')).toBe(true);
    expect(_isNotifyListenStart('UNLISTEN *')).toBe(true);
    expect(_isNotifyListenStart('SELECT 1')).toBe(false);
  });

  it('_unquotePayload strips standard single quotes', () => {
    expect(_unquotePayload("'hello world'")).toBe('hello world');
  });

  it('_unquotePayload strips dollar quotes', () => {
    expect(_unquotePayload('$$dollar quoted$$')).toBe('dollar quoted');
  });

  it('_unquotePayload strips escape-string quotes', () => {
    expect(_unquotePayload("E'escaped'")).toBe('escaped');
  });

  it('_unquotePayload returns unquoted input unchanged', () => {
    expect(_unquotePayload('bare')).toBe('bare');
  });
});
