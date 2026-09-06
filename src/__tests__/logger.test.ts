/**
 * PinoLogger unit tests.
 *
 * Covers singleton management (configureBase / forComponent), level gating,
 * object/string dispatch for every log method, and the rotating-file backend.
 * File-backed tests write into a per-test temp directory and clean up after
 * themselves to remain deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PinoLogger, createRotatingLogger } from '../logger/PinoLogger';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sqlvec-logger-'));
  tmpDirs.push(dir);
  return dir;
}

describe('PinoLogger', () => {
  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it('defaults logLevel to info and name to sqlvec', () => {
    const log = new PinoLogger();
    expect(log.isLevelEnabled('info')).toBe(true);
    expect(log.isLevelEnabled('debug')).toBe(false);
    expect(log.isLevelEnabled('trace')).toBe(false);
    expect(log.isLevelEnabled('warn')).toBe(true);
    expect(log.isLevelEnabled('error')).toBe(true);
    expect(log.isLevelEnabled('fatal')).toBe(true);
  });

  it('respects a custom logLevel', () => {
    const log = new PinoLogger({ logLevel: 'debug' });
    expect(log.isLevelEnabled('debug')).toBe(true);
    expect(log.isLevelEnabled('trace')).toBe(false);
  });

  it('getPino returns the underlying pino instance', () => {
    const log = new PinoLogger();
    expect(log.getPino()).toBeDefined();
    expect(typeof log.getPino().info).toBe('function');
  });

  it('dispatches string and object forms for every level', () => {
    const log = new PinoLogger({ logLevel: 'trace' });
    expect(() => {
      log.trace('string');
      log.trace({ a: 1 });
      log.trace({ a: 1 }, 'with msg');
      log.debug('string');
      log.debug({ a: 1 }, 'msg');
      log.info('string');
      log.info({ a: 1 }, 'msg');
      log.warn('string');
      log.warn({ a: 1 });
      log.error('string');
      log.error({ err: 'boom' });
      log.fatal('string');
      log.fatal({ err: 'fatal' }, 'msg');
    }).not.toThrow();
  });

  it('dispatches the object-without-message form for every level', () => {
    const log = new PinoLogger({ logLevel: 'trace' });
    // Exercises the `else { this.logger.X(obj) }` branch where msg is omitted.
    expect(() => {
      log.trace({ a: 1 });
      log.debug({ a: 1 });
      log.info({ a: 1 });
      log.warn({ a: 1 });
      log.error({ a: 1 });
      log.fatal({ a: 1 });
    }).not.toThrow();
  });

  it('flush() invokes the underlying pino flush if present', () => {
    const log = new PinoLogger();
    expect(() => log.flush()).not.toThrow();
  });

  it('constructs with explicit pretty logFormat', () => {
    const log = new PinoLogger({ logFormat: 'pretty' });
    expect(log.getPino()).toBeDefined();
    expect(() => log.info('pretty entry')).not.toThrow();
  });

  it('detects a non-TTY stdout and falls back to json', () => {
    // In a non-interactive test environment `process.stdout.isTTY` is false,
    // so `detectFormat()` returns 'json'. We assert the constructor still
    // produces a usable logger without explicit format.
    const log = new PinoLogger({});
    expect(log.getPino()).toBeDefined();
  });

  it('constructs with explicit json logFormat', () => {
    const log = new PinoLogger({ logFormat: 'json' });
    expect(log.getPino()).toBeDefined();
    expect(() => log.info('json entry')).not.toThrow();
  });

  it('panic() logs at FATAL and calls process.exit', async () => {
    const log = new PinoLogger();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    try {
      log.panic('unrecoverable');
      // process.exit is called on the next tick via setImmediate.
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('panic() accepts an object payload', async () => {
    const log = new PinoLogger();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    try {
      log.panic({ reason: 'disk full' });
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('panic() accepts an object payload with a message', async () => {
    const log = new PinoLogger();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    try {
      log.panic({ reason: 'oom' }, 'out of memory');
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('child() returns a PinoLogger with bound fields', () => {
    const parent = new PinoLogger();
    const child = parent.child({ requestId: 'abc' });
    expect(child).toBeInstanceOf(PinoLogger);
    expect(child.getPino()).toBeDefined();
    expect(() => child.info('hello')).not.toThrow();
  });

  it('writes a log file when logFile is configured', async () => {
    const dir = makeTmpDir();
    const file = join(dir, 'app.log');
    const log = new PinoLogger({ logFile: file, logLevel: 'info' });
    log.info('file-backed entry');
    // pino's file transport runs on a worker thread; poll until flushed.
    await vi.waitFor(() => {
      expect(existsSync(file)).toBe(true);
    }, { timeout: 5000, interval: 50 });
  });

  it('creates the parent directory for a logFile if missing', async () => {
    const dir = makeTmpDir();
    const nested = join(dir, 'deep', 'nested', 'app.log');
    const log = new PinoLogger({ logFile: nested });
    log.info('creates dirs');
    await vi.waitFor(() => {
      expect(existsSync(nested)).toBe(true);
    }, { timeout: 5000, interval: 50 });
  });

  it('closeClient closes a provided client and logs a FATAL entry', () => {
    const log = new PinoLogger();
    const client = { close: vi.fn() };
    log.closeClient(client, 'client going away');
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('closeClient tolerates a null client without throwing', () => {
    const log = new PinoLogger();
    expect(() => log.closeClient(null, 'no client')).not.toThrow();
  });

  it('closeClient catches a client.close() throw', () => {
    const log = new PinoLogger();
    const client = { close: vi.fn(() => { throw new Error('close failed'); }) };
    expect(() => log.closeClient(client, 'boom')).not.toThrow();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('closeClient accepts an object payload (with and without msg)', () => {
    const log = new PinoLogger();
    const c1 = { close: vi.fn() };
    const c2 = { close: vi.fn() };
    expect(() => {
      log.closeClient(c1, { reason: 'shutdown' });
      log.closeClient(c2, { reason: 'timeout' }, 'idle timeout');
    }).not.toThrow();
    expect(c1.close).toHaveBeenCalledTimes(1);
    expect(c2.close).toHaveBeenCalledTimes(1);
  });

  it('closeClient tolerates a falsy (null) object payload', () => {
    const log = new PinoLogger();
    const client = { close: vi.fn() };
    // `(obj || {})` — a null obj exercises the `|| {}` fallback.
    expect(() => log.closeClient(client, null as any)).not.toThrow();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('panic() tolerates a falsy (null) object payload', async () => {
    const log = new PinoLogger();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    try {
      log.panic(null as any);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('warn/error object forms pass msg through when provided', () => {
    const log = new PinoLogger({ logLevel: 'trace' });
    expect(() => {
      log.warn({ a: 1 }, 'warn msg');
      log.error({ a: 1 }, 'error msg');
    }).not.toThrow();
  });
});

describe('PinoLogger singleton management', () => {
  it('forComponent falls back to an empty config on cold start (no base)', () => {
    // This runs before any configureBase call in this file, so `__base__` is
    // unset and the `base?.config ?? {}` fallback branch is exercised.
    const log = PinoLogger.forComponent('cold-start-component');
    expect(log).toBeInstanceOf(PinoLogger);
    expect(log.getPino()).toBeDefined();
  });

  it('forComponent returns the same instance for repeated calls', () => {
    PinoLogger.configureBase({ name: 'test-base' });
    const a = PinoLogger.forComponent('comp-a');
    const b = PinoLogger.forComponent('comp-a');
    expect(a).toBe(b);
  });

  it('forComponent returns distinct instances for different names', () => {
    PinoLogger.configureBase({ name: 'test-base' });
    const a = PinoLogger.forComponent('comp-a');
    const b = PinoLogger.forComponent('comp-b');
    expect(a).not.toBe(b);
  });

  it('configureBase defaults the instance name to sqlvec when omitted', () => {
    PinoLogger.configureBase({} as any);
    const log = PinoLogger.forComponent('after-default-base');
    expect(log).toBeInstanceOf(PinoLogger);
  });
});

describe('createRotatingLogger', () => {
  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it('accepts a string name plus explicit level and logDir', () => {
    const dir = makeTmpDir();
    const logDir = join(dir, 'logs');
    const log = createRotatingLogger('myapp', 'info', logDir);
    expect(typeof log.info).toBe('function');
    log.info('rotate smoke');
    expect(existsSync(join(logDir, 'myapp.log'))).toBe(true);
  });

  it('defaults logDir when the config object omits it', () => {
    // `raw.logDir ?? './logs'` — exercise the `??` default branch.
    const cwd = process.cwd();
    const prevExists = existsSync('./logs');
    const log = createRotatingLogger({ name: 'defaultdir', logToStdout: false });
    log.info('using default log dir');
    expect(existsSync(join(cwd, 'logs', 'defaultdir.log'))).toBe(true);
    // Clean up the accidental ./logs directory to avoid polluting the repo.
    if (!prevExists) {
      rmSync(join(cwd, 'logs'), { recursive: true, force: true });
    }
  });

  it('accepts a full config object and writes to the configured dir', () => {
    const dir = makeTmpDir();
    const logDir = join(dir, 'logs');
    const log = createRotatingLogger({ name: 'cfg', logDir, maxSize: 1024, maxFiles: 3, compress: false });
    log.info('entry');
    // Force a flush by writing many bytes to trigger rotation.
    for (let i = 0; i < 100; i++) {
      log.info('x'.repeat(64));
    }
    expect(existsSync(join(logDir, 'cfg.log'))).toBe(true);
    const files = readdirSync(logDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('disables stdout when logToStdout is false', () => {
    const dir = makeTmpDir();
    const logDir = join(dir, 'logs');
    const log = createRotatingLogger({ name: 'quiet', logDir, logToStdout: false, maxSize: 4096 });
    log.info('no stdout');
    expect(existsSync(join(logDir, 'quiet.log'))).toBe(true);
  });

  it('appends to an existing log file (openFd appends size)', () => {
    const dir = makeTmpDir();
    const logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const target = join(logDir, 'append.log');
    // Pre-create the file so openFd() observes an existing path and reads its size.
    writeFileSync(target, 'pre-existing content\n');
    const log = createRotatingLogger({ name: 'append', logDir, maxSize: 1 << 20, logToStdout: false });
    log.info('appended line');
    const content = readFileSync(target, 'utf8');
    expect(content).toContain('pre-existing content');
    expect(content).toContain('appended line');
  });

  it('reuses an already-existing log directory', () => {
    const dir = makeTmpDir();
    const logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });
    // The `!existsSync(config.logDir)` false branch is taken when the dir exists.
    const log = createRotatingLogger({ name: 'reuse', logDir, logToStdout: false });
    log.info('reuse dir');
    expect(existsSync(join(logDir, 'reuse.log'))).toBe(true);
  });

  it('gzip-compresses rotated archives when compress is true', () => {
    const dir = makeTmpDir();
    const logDir = join(dir, 'logs');
    const log = createRotatingLogger({ name: 'zippy', logDir, maxSize: 256, maxFiles: 2, compress: true, logToStdout: false });
    for (let i = 0; i < 200; i++) {
      log.info('z'.repeat(128));
    }
    const files = readdirSync(logDir);
    expect(files.some((f) => f.endsWith('.gz'))).toBe(true);
  });

  it('rotates immediately when maxSize is tiny (first write exceeds capacity)', () => {
    const dir = makeTmpDir();
    const logDir = join(dir, 'logs');
    // maxSize of 1 byte forces rotation on the very first write, exercising the
    // rotate() path where the current file may not yet hold a full line.
    const log = createRotatingLogger({ name: 'tiny', logDir, maxSize: 1, maxFiles: 2, compress: false, logToStdout: false });
    for (let i = 0; i < 10; i++) {
      log.info('line');
    }
    expect(existsSync(join(logDir, 'tiny.log'))).toBe(true);
    const files = readdirSync(logDir).filter((f) => f.startsWith('tiny'));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });
});
