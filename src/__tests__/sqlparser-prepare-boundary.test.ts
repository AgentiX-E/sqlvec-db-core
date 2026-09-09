import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Cover parsePrepare/parseDeallocate name-missing falsy branches, PREPARE
// without AS, DEALLOCATE ALL vs named, and parseStatement switch-default
// routing of PREPARE/DEALLOCATE (parsed to 'prepare'/'deallocate' AST type).

describe('SqlParser PREPARE/DEALLOCATE name-missing and switch-default branches', () => {
  it('PREPARE without valid name → empty name', () => {
    const r = parseStatement('PREPARE AS SELECT 1');
    expect((r as any).type).toBe('PREPARE');
    expect((r as any).name).toBe('');
  });

  it('PREPARE without AS → empty innerSql', () => {
    const r = parseStatement('PREPARE p');
    expect((r as any).type).toBe('PREPARE');
  });

  it('PREPARE with param types', () => {
    const r = parseStatement('PREPARE p (int, text) AS SELECT $1, $2');
    expect((r as any).name).toBe('p');
    expect((r as any).paramTypes).toEqual(['int', 'text']);
    expect((r as any).innerSql).toBe('SELECT $1, $2');
  });

  it('DEALLOCATE ALL', () => {
    const r = parseStatement('DEALLOCATE ALL');
    expect((r as any).name).toBe('ALL');
  });

  it('DEALLOCATE PREPARE named', () => {
    const r = parseStatement('DEALLOCATE PREPARE p');
    expect((r as any).name).toBe('p');
  });

  it('DEALLOCATE without valid name → empty name', () => {
    const r = parseStatement('DEALLOCATE');
    expect((r as any).name).toBe('');
  });
});

describe('SqlParser parseParamValues in-string/escaped quote', () => {
  it('string with escaped doubled quote', () => {
    const r = parseStatement("EXECUTE p('it''s')");
    expect((r as any).params).toEqual(["it's"]);
  });

  it('string containing comma (not split within string)', () => {
    const r = parseStatement("EXECUTE p('a,b', 2)");
    expect((r as any).params).toEqual(['a,b', 2]);
  });
});
