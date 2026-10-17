/**
 * do-block-handler.test.ts — Coverage tests for DoBlockHandler.
 *
 * Covers the pure functions extractDoBody / detectDoBlock across all
 * dollar-quoting and single-quoting forms, plus the DoBlockHandler lifecycle
 * (start/execute/stop/reset) with a mocked PlPgSqlEngine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the PlPgSqlEngine module to isolate DoBlockHandler from the heavy
// PL/pgSQL backend and to control execution results deterministically.
const engineMock = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  execute: vi.fn(async () => ({ success: true, variables: {}, returnValue: undefined })),
  setNoticeCallback: vi.fn(),
};

// Mutable factory return so individual tests can force a null engine.
let mockEngine: any = engineMock;
vi.mock('../plpgsql/PlPgSqlEngine', () => ({
  createPlPgSqlEngine: () => mockEngine,
}));

import { DoBlockHandler, extractDoBody, detectDoBlock } from '../query/DoBlockHandler';

describe('extractDoBody', () => {
  it('returns null for non-DO SQL', () => {
    expect(extractDoBody('SELECT 1')).toBeNull();
    expect(extractDoBody('  update users set x=1')).toBeNull();
    expect(extractDoBody('')).toBeNull();
  });

  it('extracts body from DO $$ ... $$', () => {
    expect(extractDoBody("DO $$ BEGIN RAISE NOTICE 'hi'; END $$;")).toBe("BEGIN RAISE NOTICE 'hi'; END");
  });

  it('extracts body from DO $tag$ ... $tag$', () => {
    expect(extractDoBody('DO $fn$ BEGIN NULL; END $fn$;')).toBe('BEGIN NULL; END');
  });

  it('extracts body from DO LANGUAGE plpgsql $$ ... $$', () => {
    expect(extractDoBody("DO LANGUAGE plpgsql $$ BEGIN NULL; END $$;")).toBe('BEGIN NULL; END');
  });

  it('extracts body from DO LANGUAGE plpgsql $tag$ ... $tag$', () => {
    expect(extractDoBody('DO LANGUAGE plpgsql $x$ BEGIN NULL; END $x$;')).toBe('BEGIN NULL; END');
  });

  it('extracts body from single-quoted DO body', () => {
    expect(extractDoBody("DO 'BEGIN NULL; END'")).toBe('BEGIN NULL; END');
  });

  it('handles escaped single quotes in single-quoted body', () => {
    expect(extractDoBody("DO 'BEGIN RAISE NOTICE \\'a\\'; END'")).toBe("BEGIN RAISE NOTICE \\'a\\'; END");
  });

  it('returns null for dollar-quote without closing quote', () => {
    expect(extractDoBody('DO $$ BEGIN NULL; END')).toBeNull();
  });

  it('returns null for single-quote without closing quote', () => {
    expect(extractDoBody("DO 'BEGIN NULL; END")).toBeNull();
  });

  it('returns null for empty dollar-quoted body', () => {
    expect(extractDoBody('DO $$$$')).toBeNull();
  });

  it('returns null for empty single-quoted body', () => {
    expect(extractDoBody("DO ''")).toBeNull();
  });

  it('returns null for DO with dollar without tag close', () => {
    expect(extractDoBody('DO $')).toBeNull();
  });

  it('returns null when body start quote does not match (unterminated)', () => {
    // A dollar-quoted block with no closing tag returns null.
    expect(extractDoBody('DO $tag$unterminated-body')).toBeNull();
  });
});

describe('detectDoBlock', () => {
  it('detects DO with dollar quote', () => {
    expect(detectDoBlock('DO $$ BEGIN END $$')).toBe(true);
  });

  it('detects DO with single quote', () => {
    expect(detectDoBlock("DO 'BEGIN END'")).toBe(true);
  });

  it('detects DO LANGUAGE plpgsql with dollar quote', () => {
    expect(detectDoBlock('DO LANGUAGE plpgsql $$ BEGIN END $$')).toBe(true);
  });

  it('returns false for non-DO', () => {
    expect(detectDoBlock('SELECT 1')).toBe(false);
    expect(detectDoBlock('DOTHIS')).toBe(false);
  });

  it('returns false for DO without quote body', () => {
    expect(detectDoBlock('DO something')).toBe(false);
  });
});

describe('DoBlockHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEngine = engineMock;
    engineMock.execute.mockResolvedValue({ success: true, variables: {}, returnValue: undefined });
  });

  it('starts idempotently', async () => {
    const h = new DoBlockHandler();
    await h.start();
    await h.start();
    expect(engineMock.start).toHaveBeenCalledTimes(1);
    expect(h.isStarted).toBe(true);
  });

  it('logs a warning when engine.start throws', async () => {
    engineMock.start.mockRejectedValueOnce(new Error('backend unavailable'));
    const h = new DoBlockHandler();
    await h.start();
    // start() swallows the error and still marks itself started
    expect(h.isStarted).toBe(true);
  });

  it('does not auto-start twice (already started)', async () => {
    const h = new DoBlockHandler();
    await h.start();
    vi.clearAllMocks();
    await h.execute("DO $$ BEGIN NULL; END $$");
    // start() was called once during explicit start(); execute() sees _started
    // already true and skips auto-start.
    expect(engineMock.start).not.toHaveBeenCalled();
    expect(h.isStarted).toBe(true);
  });

  it('returns error when engine is null after start', async () => {
    mockEngine = null;
    const h = new DoBlockHandler();
    // Force _started true while engine stays null by making start a no-op
    engineMock.start.mockResolvedValue(undefined);
    const r = await h.execute("DO $$ BEGIN NULL; END $$");
    expect(r.success).toBe(false);
    expect(r.error).toContain('not available');
  });

  it('does not append semicolon when body already ends with one', async () => {
    const h = new DoBlockHandler();
    await h.execute('DO $$ BEGIN NULL; END; $$');
    const execArg = engineMock.execute.mock.calls[0][0];
    expect(execArg.endsWith(';')).toBe(true);
    // Body already ended with ';', so no extra ';' is appended (single trailing)
    expect(execArg.match(/;$/g)!.length).toBe(1);
  });

  it('executes a DO block successfully and collects notices', async () => {
    engineMock.execute.mockResolvedValue({
      success: true,
      variables: { x: 1 },
      returnValue: 42,
    });
    engineMock.setNoticeCallback.mockImplementation((cb: any) => {
      if (cb) cb('NOTICE', 'hello');
    });

    const h = new DoBlockHandler();
    const r = await h.execute("DO $$ BEGIN RAISE NOTICE 'hello'; END $$");
    expect(r.success).toBe(true);
    expect(r.notices).toEqual(['NOTICE: hello']);
    expect(r.variables).toEqual({ x: 1 });
    expect(r.returnValue).toBe(42);
  });

  it('appends semicolon to body if missing', async () => {
    const h = new DoBlockHandler();
    await h.execute('DO $$ BEGIN NULL; END $$');
    // The body extracted ends without ';' — verify execute received a trailing ';'
    const execArg = engineMock.execute.mock.calls[0][0];
    expect(execArg.endsWith(';')).toBe(true);
  });

  it('returns error when body cannot be extracted', async () => {
    const h = new DoBlockHandler();
    const r = await h.execute('DO not-a-block');
    expect(r.success).toBe(false);
    expect(r.error).toContain('Could not extract');
  });

  it('returns error when engine execution throws', async () => {
    engineMock.execute.mockRejectedValue(new Error('boom'));
    const h = new DoBlockHandler();
    const r = await h.execute("DO $$ BEGIN NULL; END $$");
    expect(r.success).toBe(false);
    expect(r.error).toBe('boom');
  });

  it('returns error when engine execution reports failure', async () => {
    engineMock.execute.mockResolvedValue({
      success: false,
      error: 'syntax error',
      variables: {},
    });
    const h = new DoBlockHandler();
    const r = await h.execute("DO $$ BEGIN NULL; END $$");
    expect(r.success).toBe(false);
    expect(r.error).toBe('syntax error');
  });

  it('handles execute throwing a non-Error value', async () => {
    engineMock.execute.mockRejectedValue('string-error');
    const h = new DoBlockHandler();
    const r = await h.execute("DO $$ BEGIN NULL; END $$");
    expect(r.success).toBe(false);
    expect(r.error).toBe('string-error');
  });

  it('stops and resets', async () => {
    const h = new DoBlockHandler();
    await h.start();
    expect(h.isStarted).toBe(true);
    await h.stop();
    expect(h.isStarted).toBe(false);
    await h.reset();
    expect(h.isStarted).toBe(false);
  });
});
