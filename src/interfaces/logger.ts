/**
 * SqlVec DB — Logger Interface
 *
 * Abstract logging contract. All packages depend on this interface,
 * never on concrete logger implementations.
 */

export interface ILogger {
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string | { err?: string; [key: string]: unknown }, ...args: unknown[]): void;
  fatal(msg: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): ILogger;
}

/** No-op logger for tests and optional modules */
export class NoOpLogger implements ILogger {
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
  child(): ILogger { return this; }
}
