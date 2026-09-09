import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Cover fallbackParse DROP object-type table extraction. DROP VIEW/SCHEMA/
// EXTENSION fail pgsql-ast-parser (route to fallback), whose previous regex
// hardcoded `DROP TABLE` and left the name undefined for other object types.
describe('SqlParser fallback DROP object types', () => {
  it('DROP VIEW extracts view name', () => {
    const r = parseStatement('DROP VIEW v') as any;
    expect(r.ddlType).toBe('DROP');
    expect(r.table).toBe('v');
  });

  it('DROP SCHEMA extracts schema name', () => {
    const r = parseStatement('DROP SCHEMA s') as any;
    expect(r.table).toBe('s');
  });

  it('DROP EXTENSION extracts extension name', () => {
    const r = parseStatement('DROP EXTENSION e') as any;
    expect(r.table).toBe('e');
  });

  it('DROP TABLE IF EXISTS still extracts table', () => {
    const r = parseStatement('DROP TABLE IF EXISTS x') as any;
    expect(r.table).toBe('x');
  });
});
