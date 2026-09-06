/**
 * DatabaseError unit tests.
 *
 * Verifies the structured PG ErrorResponse model: SQLSTATE codes, severity,
 * optional extended fields, and wire-protocol serialization via
 * `toErrorResponse()`. These tests assert real, observable behavior and
 * guard against regressions in the error surface consumed by the PgWire layer.
 */
import { describe, it, expect } from 'vitest';
import {
  DatabaseError,
  type ErrorResponse,
  type DatabaseErrorSeverity,
} from '../errors/DatabaseError';
import {
  SQLSTATE_INTERNAL_ERROR,
  SQLSTATE_SUCCESSFUL_COMPLETION,
  SQLSTATE_INVALID_PASSWORD,
} from '../constants/sqlstate';

describe('DatabaseError', () => {
  it('defaults sqlstate to SQLSTATE_INTERNAL_ERROR and severity to ERROR', () => {
    const err = new DatabaseError('boom');
    expect(err.message).toBe('boom');
    expect(err.sqlstate).toBe(SQLSTATE_INTERNAL_ERROR);
    expect(err.severity).toBe('ERROR');
    expect(err.name).toBe('DatabaseError');
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves an explicit sqlstate and severity', () => {
    const err = new DatabaseError('auth failed', SQLSTATE_INVALID_PASSWORD, 'FATAL');
    expect(err.sqlstate).toBe(SQLSTATE_INVALID_PASSWORD);
    expect(err.severity).toBe('FATAL');
  });

  it('captures detail and hint strings', () => {
    const err = new DatabaseError('dup key', undefined, undefined, 'detail here', 'hint here');
    expect(err.detail).toBe('detail here');
    expect(err.hint).toBe('hint here');
  });

  it('copies all extended PG error fields from options', () => {
    const err = new DatabaseError('constraint violation', undefined, undefined, undefined, undefined, {
      position: 42,
      internalPosition: 7,
      internalQuery: 'SELECT internal',
      where: 'during INSERT',
      schema: 'public',
      table: 'docs',
      column: 'title',
      dataType: 'text',
      constraint: 'docs_title_check',
      file: 'executor.c',
      line: 300,
      routine: 'ExecInsert',
    });

    expect(err.position).toBe(42);
    expect(err.internalPosition).toBe(7);
    expect(err.internalQuery).toBe('SELECT internal');
    expect(err.where).toBe('during INSERT');
    expect(err.schema).toBe('public');
    expect(err.table).toBe('docs');
    expect(err.column).toBe('title');
    expect(err.dataType).toBe('text');
    expect(err.constraint).toBe('docs_title_check');
    expect(err.file).toBe('executor.c');
    expect(err.line).toBe(300);
    expect(err.routine).toBe('ExecInsert');
  });

  it('leaves extended fields undefined when no options object is supplied', () => {
    const err = new DatabaseError('plain');
    expect(err.position).toBeUndefined();
    expect(err.internalPosition).toBeUndefined();
    expect(err.internalQuery).toBeUndefined();
    expect(err.where).toBeUndefined();
    expect(err.schema).toBeUndefined();
    expect(err.table).toBeUndefined();
    expect(err.column).toBeUndefined();
    expect(err.dataType).toBeUndefined();
    expect(err.constraint).toBeUndefined();
    expect(err.file).toBeUndefined();
    expect(err.line).toBeUndefined();
    expect(err.routine).toBeUndefined();
  });

  it('serializes to an ErrorResponse with all fields mapped', () => {
    const err = new DatabaseError('dup key', '23505', 'ERROR', 'detail', 'hint', {
      position: 1,
      constraint: 'uniq',
      table: 'docs',
    });
    const resp: ErrorResponse = err.toErrorResponse();

    expect(resp.severity).toBe('ERROR');
    expect(resp.code).toBe('23505');
    expect(resp.message).toBe('dup key');
    expect(resp.detail).toBe('detail');
    expect(resp.hint).toBe('hint');
    expect(resp.position).toBe(1);
    expect(resp.constraint).toBe('uniq');
    expect(resp.table).toBe('docs');
  });

  it('serializes undefined optional fields explicitly (stable wire shape)', () => {
    const resp = new DatabaseError('minimal').toErrorResponse();
    // All keys must be present even when undefined, so the wire serializer
    // can iterate deterministically without `in` guards.
    const keys = Object.keys(resp).sort();
    expect(keys).toEqual([
      'code', 'column', 'constraint', 'dataType', 'detail', 'file', 'hint',
      'internalPosition', 'internalQuery', 'line', 'message', 'position',
      'routine', 'schema', 'severity', 'table', 'where',
    ]);
  });

  it('supports all three severity levels in the type contract', () => {
    const sev: DatabaseErrorSeverity[] = ['ERROR', 'FATAL', 'PANIC'];
    for (const s of sev) {
      const err = new DatabaseError('x', undefined, s);
      expect(err.severity).toBe(s);
    }
  });

  it('exposes the SQLSTATE_SUCCESSFUL_COMPLETION constant for round-trip', () => {
    expect(SQLSTATE_SUCCESSFUL_COMPLETION).toBe('00000');
  });
});
