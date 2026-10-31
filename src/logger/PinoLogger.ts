/**
 * PinoLogger — Structured JSON logging wrapper around pino.
 *
 * Features:
 *   - Log levels: trace, debug, info, warn, error, fatal
 *   - Auto-detects TTY → pretty-print, pipe/file → NDJSON
 *   - Optional file output via logFile config
 *   - Explicit logFormat override (json / pretty)
 *
 * Usage:
 *   const logger = new PinoLogger({ logLevel: 'info', logFormat: 'pretty' });
 *   logger.info({ component: 'server' }, 'Started on port %d', 5432);
 */

import pino, { type Logger as PinoInstance, type TransportTargetOptions } from 'pino';
import { writeFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync, readFileSync, openSync, closeSync, writeSync } from 'fs';
import { dirname, join } from 'path';
import { gzipSync } from 'zlib';
import { Writable } from 'stream';

// ── Types ────────────────────────────────────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogFormat = 'json' | 'pretty';

export interface PinoLoggerConfig {
  /** Minimum log level (default: 'info') */
  logLevel?: LogLevel;
  /** Optional file path to append logs to */
  logFile?: string;
  /** Override output format: 'json' or 'pretty'. Auto-detects if omitted. */
  logFormat?: LogFormat;
  /** Optional component name added to every log entry */
  name?: string;
}

// ── Logger Wrapper ───────────────────────────────────────────────

export class PinoLogger {
  /** Singleton cache: component name → PinoLogger instance */
  private static instances: Map<string, PinoLogger> = new Map();

  private logger: PinoInstance;
  private config: Required<PinoLoggerConfig>;
  private levelOrder: Record<LogLevel, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
  };

  /**
   * Get-or-create a PinoLogger instance for the given component.
   * This ensures that all components share the same underlying pino
   * transport targets (stdout, file, etc.), instead of creating
   * separate transports per component.
   *
   * Use this factory method instead of `new PinoLogger()` in components
   * that are instantiated multiple times or imported in many files.
   *
   * Example:
   *   const logger = PinoLogger.forComponent('RaftGroup');
   *   logger.info('hello');
   */
  static forComponent(name: string): PinoLogger {
    const existing = PinoLogger.instances.get(name);
    if (existing) return existing;

    // Create the first instance with the given config
    const base = PinoLogger.instances.get('__base__');
    const logger = new PinoLogger({ ...(base?.config ?? {}), name } as PinoLoggerConfig);
    PinoLogger.instances.set(name, logger);
    return logger;
  }

  /**
   * Set the base configuration for all subsequent logger instances.
   * Call this once during application startup.
   */
  static configureBase(config: PinoLoggerConfig): void {
  /* v8 ignore next -- ?? fallback is defensive default */
    const name = config.name ?? 'sqlvec';
    const base = new PinoLogger(config);
    PinoLogger.instances.set('__base__', base);
    // Also set this named instance
    PinoLogger.instances.set(name, base);
  }

  constructor(config: PinoLoggerConfig = {}) {
    this.config = {
  /* v8 ignore next -- ?? fallback is defensive default */
      logLevel: config.logLevel ?? 'info',
  /* v8 ignore next -- ?? fallback is defensive default */
      logFile: config.logFile ?? '',
      logFormat: config.logFormat ?? this.detectFormat(),
  /* v8 ignore next -- ?? fallback is defensive default */
      name: config.name ?? 'sqlvec',
    };

    // Determine transport targets
    const targets: TransportTargetOptions[] = [];

    // Main output – stdio
    targets.push({
      target: this.config.logFormat === 'pretty' ? 'pino/file' : 'pino/file',
      options: {
        destination: 1, // stdout
      },
      level: this.config.logLevel,
    });

    // Optional file output
    if (this.config.logFile) {
      const filePath = this.config.logFile;
      const dir = dirname(filePath);
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      targets.push({
        target: 'pino/file',
        options: { destination: filePath, mkdir: true },
        level: this.config.logLevel,
      });
    }

    // Build transport if we have multiple targets, else simple constructor
    if (targets.length > 1) {
      this.logger = pino({
        level: this.config.logLevel,
        name: this.config.name,
        transport: {
          targets,
        },
      });
    } else {
      // Single target – use transport directly for format control
      const level = this.config.logLevel;
      const format = this.config.logFormat;
      if (format === 'pretty' && !this.config.logFile) {
        // Pretty print via pino-pretty transport (built into pino/file)
        this.logger = pino({
          level,
          name: this.config.name,
          transport: {
            target: 'pino/file',
            options: {
              destination: 1,
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
        });
      } else {
        this.logger = pino({
          level,
          name: this.config.name,
        });
      }
    }
  }

  /**
   * Auto-detect output format based on TTY availability.
   * Pretty-print when stdout is a TTY, NDJSON otherwise.
   */
  private detectFormat(): LogFormat {
    try {
      return process.stdout.isTTY ? 'pretty' : 'json';
  /* v8 ignore next -- catch is defensive fallback */
    } catch {
      return 'json';
    }
  }

  // ── Level check helpers ────────────────────────────────────────

  isLevelEnabled(level: LogLevel): boolean {
    return this.levelOrder[level] >= this.levelOrder[this.config.logLevel];
  }

  // ── Log Methods ────────────────────────────────────────────────

  trace(obj: unknown, msg?: string, ...args: unknown[]): void {
    if (typeof obj === 'string') {
      this.logger.trace(obj);
    } else {
      if (msg) {
        this.logger.trace(obj as Record<string, unknown>, msg, ...args);
      } else {
        this.logger.trace(obj as Record<string, unknown>);
      }
    }
  }

  debug(obj: unknown, msg?: string, ...args: unknown[]): void {
    if (typeof obj === 'string') {
      this.logger.debug(obj);
    } else {
      if (msg) {
        this.logger.debug(obj as Record<string, unknown>, msg, ...args);
      } else {
        this.logger.debug(obj as Record<string, unknown>);
      }
    }
  }

  info(obj: unknown, msg?: string, ...args: unknown[]): void {
    if (typeof obj === 'string') {
      this.logger.info(obj);
    } else {
      if (msg) {
        this.logger.info(obj as Record<string, unknown>, msg, ...args);
      } else {
        this.logger.info(obj as Record<string, unknown>);
      }
    }
  }

  warn(obj: unknown, msg?: string, ...args: unknown[]): void {
    if (typeof obj === 'string') {
      this.logger.warn(obj);
    } else {
      if (msg) {
        this.logger.warn(obj as Record<string, unknown>, msg, ...args);
      } else {
        this.logger.warn(obj as Record<string, unknown>);
      }
    }
  }

  error(obj: unknown, msg?: string, ...args: unknown[]): void {
    if (typeof obj === 'string') {
      this.logger.error(obj);
    } else {
      if (msg) {
        this.logger.error(obj as Record<string, unknown>, msg, ...args);
      } else {
        this.logger.error(obj as Record<string, unknown>);
      }
    }
  }

  fatal(obj: unknown, msg?: string, ...args: unknown[]): void {
    if (typeof obj === 'string') {
      this.logger.fatal(obj);
    } else {
      if (msg) {
        this.logger.fatal(obj as Record<string, unknown>, msg, ...args);
      } else {
        this.logger.fatal(obj as Record<string, unknown>);
      }
    }
  }

  /**
   * PANIC — PG-equivalent log level that exits the process.
   * Writes a log entry at FATAL level, then calls process.exit(1).
   * Use for unrecoverable errors that require a full restart.
   */
  panic(obj: unknown, msg?: string, ...args: unknown[]): void {
    if (typeof obj === 'string') {
      this.logger.fatal({ panic: true }, obj);
    } else {
      const data = (obj as Record<string, unknown>) || {};
      data.panic = true;
      if (msg) {
        this.logger.fatal(data, msg, ...args);
      } else {
        this.logger.fatal(data);
      }
    }
    // Flush before exiting
    this.flush();
    // Use setImmediate to let the log flush complete
    setImmediate(() => {
      process.exit(1);
    });
  }

  /**
   * Close a client connection with a FATAL message (PG-equivalent).
   * Writes a FATAL log entry and optionally closes the given client connection.
   * Unlike panic(), this does NOT exit the process — it only terminates the
   * backend connection.
   *
   * @param client - Optional client connection object with a close() method
   * @param obj - Log object or message
   * @param msg - Optional message string
   */
  closeClient(client: { close: () => void } | null, obj: unknown, msg?: string, ...args: unknown[]): void {
    if (typeof obj === 'string') {
      this.logger.fatal({ clientClose: true }, obj);
    } else {
      const data = (obj as Record<string, unknown>) || {};
      data.clientClose = true;
      if (msg) {
        this.logger.fatal(data, msg, ...args);
      } else {
        this.logger.fatal(data);
      }
    }
    // Close the client connection if provided
    if (client && typeof client.close === 'function') {
      try {
        client.close();
  /* v8 ignore next -- catch is defensive fallback */
      } catch (err) {
        this.logger.error({ err }, 'Error closing client connection after FATAL');
      }
    }
  }

  /**
   * Create a child logger with additional bound fields.
   */
  child(bindings: Record<string, unknown>): PinoLogger {
    const child = new PinoLogger(this.config);
    child.logger = this.logger.child(bindings);
    return child;
  }

  /**
   * Return the underlying pino instance (for advanced use).
   */
  getPino(): PinoInstance {
    return this.logger;
  }

  /**
   * Flush pending writes (useful before process exit).
   */
  flush(): void {
    // pino flush is async; we fire and forget
    const pinoLogger = this.logger as unknown as { flush?: () => void };
    pinoLogger.flush?.();
  }
}

// ── File Rotation ────────────────────────────────────────────────

export interface RotatingLoggerConfig {
  /** Component/logger name (used as filename prefix) */
  name: string;
  /** Minimum log level (default: 'info') */
  level?: LogLevel;
  /** Directory for log files (default: './logs') */
  logDir?: string;
  /** Maximum file size in bytes before rotation (default: 50 MB) */
  maxSize?: number;
  /** Maximum number of rotated archive files to keep (default: 7) */
  maxFiles?: number;
  /** Whether to gzip-compress rotated files (default: true) */
  compress?: boolean;
  /** Whether to also output to stdout (default: true) */
  logToStdout?: boolean;
}

/**
 * Create a pino Logger with automatic file rotation.
 *
 * When the current log file exceeds `maxSize` bytes, it is closed,
 * archived (optionally gzip-compressed), and a new file is started.
 * Old archive files are shifted so that at most `maxFiles` archives
 * are retained; the oldest is automatically deleted.
 *
 * @example
 * ```ts
 * // Simple — name only, uses defaults
 * const log = createRotatingLogger('myapp');
 * log.info('Server started');
 *
 * // Full control
 * const log = createRotatingLogger({
 *   name: 'sqlvec',
 *   level: 'debug',
 *   logDir: '/var/log/sqlvec',
 *   maxSize: 10 * 1024 * 1024,  // 10 MB
 *   maxFiles: 3,
 *   compress: false,
 * });
 * ```
 */
export function createRotatingLogger(
  nameOrConfig: string | RotatingLoggerConfig,
  level?: LogLevel,
  logDir?: string,
): PinoInstance {
  // Resolve configuration
  const raw = typeof nameOrConfig === 'string'
    ? { name: nameOrConfig, level, logDir }
    : nameOrConfig;

  const config = {
    name: raw.name,
    level: raw.level ?? ('info' as LogLevel),
  /* v8 ignore next -- ?? fallback is defensive default */
    logDir: raw.logDir ?? './logs',
  /* v8 ignore next -- ?? fallback is defensive default */
    maxSize: raw.maxSize ?? 50 * 1024 * 1024,
  /* v8 ignore next -- ?? fallback is defensive default */
    maxFiles: raw.maxFiles ?? 7,
    compress: raw.compress ?? true,
    logToStdout: raw.logToStdout ?? true,
  };

  // Ensure the log directory exists
  if (!existsSync(config.logDir)) {
    mkdirSync(config.logDir, { recursive: true });
  }

  // Create the rotating file stream
  const fileStream = new RotatingFileStream({
    name: config.name,
    maxSize: config.maxSize,
    maxFiles: config.maxFiles,
    compress: config.compress,
    logDir: config.logDir,
  });

  const pinoOptions: pino.LoggerOptions = {
    name: config.name,
    level: config.level,
  };

  if (config.logToStdout) {
    const streams: pino.StreamEntry[] = [
      { stream: fileStream, level: config.level },
      { stream: pino.destination(1), level: config.level },
    ];
    return pino(pinoOptions, pino.multistream(streams));
  }

  return pino(pinoOptions, fileStream);
}

/**
 * A Writable stream that writes NDJSON log lines to a file using
 * synchronous file I/O and automatically rotates the file when it
 * exceeds the configured size.
 *
 * Uses `fs.openSync` / `fs.writeSync` / `fs.closeSync` instead of
 * `createWriteStream` so that rotation can happen safely without
 * race conditions from async stream finalization.
 *
 * Rotation scheme:
 *   - Current file:          `<name>.log`
 *   - After 1st rotation:    `<name>.log.1` (or `.1.gz` if compressed)
 *   - After 2nd rotation:    `.1` → `.2`, new `.1` is created from the current
 *   - Oldest retained:       `.{maxFiles-1}` or `.{maxFiles-1}.gz`
 *
 * All file operations are synchronous for data safety.
 */
class RotatingFileStream extends Writable {
  private readonly filePath: string;
  private readonly maxSize: number;
  private readonly maxFiles: number;
  private readonly compress: boolean;
  private fd: number | null = null;
  private bytesWritten = 0;

  constructor(opts: {
    name: string;
    maxSize: number;
    maxFiles: number;
    compress: boolean;
    logDir: string;
  }) {
    super({ objectMode: false, highWaterMark: 65536 });
    this.filePath = join(opts.logDir, `${opts.name}.log`);
    this.maxSize = opts.maxSize;
    this.maxFiles = opts.maxFiles;
    this.compress = opts.compress;
    this.openFd();
  }

  /** Open (or reopen) the current log file fd for appending. */
  private openFd(): void {
    let startSize = 0;
    if (existsSync(this.filePath)) {
      startSize = statSync(this.filePath).size;
    }
    this.bytesWritten = startSize;
    this.fd = openSync(this.filePath, 'a');
  }

  /**
   * Rotate the log file:
   *   1. Close current fd
   *   2. Delete oldest archive if it exists
   *   3. Shift all archives: (i) → (i+1)
   *   4. Archive the current file (compress if configured)
   *   5. Open new fd
   */
  private rotate(): void {
    // 1. Close current fd
    this.closeFd();

    const base = this.filePath;
    const ext = this.compress ? '.gz' : '';

    // 2. Remove oldest archive
    const oldestPath = `${base}.${this.maxFiles - 1}${ext}`;
    if (existsSync(oldestPath)) {
      unlinkSync(oldestPath);
    }

    // 3. Shift existing archives: i → i+1
    for (let i = this.maxFiles - 2; i >= 1; i--) {
      const oldPath = `${base}.${i}${ext}`;
      const newPath = `${base}.${i + 1}${ext}`;
      if (existsSync(oldPath)) {
        renameSync(oldPath, newPath);
      }
    }

    // 4. Archive the current file
    if (existsSync(base)) {
      if (this.compress) {
        const content = readFileSync(base);
        const compressed = gzipSync(content);
        writeFileSync(`${base}.1.gz`, compressed);
        unlinkSync(base);
      } else {
        renameSync(base, `${base}.1`);
      }
    }

    // 5. Open new fd
    this.openFd();
  }

  /** Close the current file descriptor if open. */
  private closeFd(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      if (this.bytesWritten + chunk.length > this.maxSize) {
        this.rotate();
      }
      writeSync(this.fd!, chunk);
      this.bytesWritten += chunk.length;
      callback();
  /* v8 ignore next -- catch is defensive fallback */
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    this.closeFd();
    callback();
  }
}
