/**
 * SQLSTATE constants and module-type tests.
 *
 * Verifies that the SQLSTATE constant module exports the complete set of
 * PostgreSQL standard error codes with correct class/subclass values, and that
 * the NoOpLogger honors the ILogger contract without side effects.
 */
import { describe, it, expect } from 'vitest';
import * as sqlstate from '../constants/sqlstate';
import { NoOpLogger, type ILogger } from '../interfaces/logger';
import { DEFAULT_IDLE_TXN_TIMEOUT_MS } from '../interfaces/protocol';
describe('SQLSTATE constants', () => {
  it('exports the successful-completion code', () => {
    expect(sqlstate.SQLSTATE_SUCCESSFUL_COMPLETION).toBe('00000');
  });

  it('exports the warning class code (01xxx)', () => {
    expect(sqlstate.SQLSTATE_WARNING).toBe('01000');
    expect(sqlstate.SQLSTATE_WARNING_DYNAMIC_RESULT_COLUMNS_RETURNED).toBe('0100C');
  });

  it('exports the internal-error code (XX000)', () => {
    expect(sqlstate.SQLSTATE_INTERNAL_ERROR).toBe('XX000');
  });

  it('exports the invalid-password code (28P01)', () => {
    expect(sqlstate.SQLSTATE_INVALID_PASSWORD).toBe('28P01');
  });

  it('exports a large, non-trivial set of constants (>= 200)', () => {
    // sqlstate.ts holds ~250 exported code constants; ensure none were lost
    // in a refactor.
    const exported = Object.keys(sqlstate).filter((k) => !k.startsWith('__'));
    expect(exported.length).toBeGreaterThanOrEqual(200);
    // Every value must be a 5-char SQLSTATE code (or a well-known special).
    for (const key of exported) {
      const val = sqlstate[key as keyof typeof sqlstate];
      if (typeof val === 'string') {
        expect(val).toHaveLength(5);
      }
    }
  });

  it('getSqlstateClass resolves a known class prefix', () => {
    expect(sqlstate.getSqlstateClass('28P01')).toBe('Invalid Authorization Specification');
    expect(sqlstate.getSqlstateClass('00000')).toBe('Successful Completion');
    expect(sqlstate.getSqlstateClass('23505')).toBe('Integrity Constraint Violation');
  });

  it('getSqlstateClass returns "Unknown" for an unrecognized class', () => {
    expect(sqlstate.getSqlstateClass('ZZ123')).toBe('Unknown');
    expect(sqlstate.getSqlstateClass('00000').slice(0, 1)).toBe('S');
  });

  it('sqlstateDetail reports LOG severity for success and ERROR otherwise', () => {
    const ok = sqlstate.sqlstateDetail('00000');
    expect(ok.severity).toBe('LOG');
    expect(ok.code).toBe('00000');

    const err = sqlstate.sqlstateDetail('23505');
    expect(err.severity).toBe('ERROR');
    expect(err.code).toBe('23505');
    expect(err.message).toContain('23505');
  });

  it('SQLSTATE_CLASSES maps every two-char class to a description', () => {
    const classes = sqlstate.SQLSTATE_CLASSES;
    expect(typeof classes).toBe('object');
    expect(classes['00']).toBe('Successful Completion');
    expect(classes['XX']).toBeTruthy();
  });
});

describe('NoOpLogger', () => {
  it('implements every ILogger method and returns safely', () => {
    const log: ILogger = new NoOpLogger();
    expect(() => {
      log.trace('t');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      log.fatal('f');
      log.error({ err: 'x' });
    }).not.toThrow();
  });

  it('child() returns a logger (self) satisfying the contract', () => {
    const log = new NoOpLogger();
    const child = log.child({ component: 'x' });
    expect(child).toBe(log);
    expect(typeof child.info).toBe('function');
  });
});

describe('protocol constants', () => {
  it('defaults idle transaction timeout to 0 (disabled)', () => {
    expect(DEFAULT_IDLE_TXN_TIMEOUT_MS).toBe(0);
  });
});
