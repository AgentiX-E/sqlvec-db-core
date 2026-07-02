/**
 * Logger tests — ILogger contract, PinoLogger, NoOpLogger.
 */
import { describe, it, expect } from 'vitest';
import { PinoLogger } from '../logger/PinoLogger';
import { NoOpLogger } from '../interfaces/logger';

describe('PinoLogger', () => {
  const logger = new PinoLogger({ name: 'test' });

  it('implements ILogger methods', () => {
    // All methods must be callable without throwing
    expect(() => logger.trace('msg')).not.toThrow();
    expect(() => logger.debug('msg')).not.toThrow();
    expect(() => logger.info('msg')).not.toThrow();
    expect(() => logger.warn('msg')).not.toThrow();
    expect(() => logger.error('msg')).not.toThrow();
    expect(() => logger.fatal('msg')).not.toThrow();
  });

  it('child creates scoped logger', () => {
    const child = logger.child({ component: 'test-component' });
    expect(child).toBeDefined();
    expect(() => child.info('scoped')).not.toThrow();
  });
});

describe('NoOpLogger', () => {
  const logger = new NoOpLogger();

  it('all methods are no-op (no throw)', () => {
    expect(() => logger.trace('x')).not.toThrow();
    expect(() => logger.debug('x')).not.toThrow();
    expect(() => logger.info('x')).not.toThrow();
    expect(() => logger.warn('x')).not.toThrow();
    expect(() => logger.error('x')).not.toThrow();
    expect(() => logger.fatal('x')).not.toThrow();
  });

  it('child returns self', () => {
    expect(logger.child({})).toBe(logger);
  });
});
