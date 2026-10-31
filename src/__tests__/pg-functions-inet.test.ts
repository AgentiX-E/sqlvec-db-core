import { describe, it, expect, beforeAll } from 'vitest';
import { buildPgFunctions, type PgFunctionMap } from '../system/PgFunctions';

let map: PgFunctionMap;
const fn = (name: string, ...args: unknown[]) => map.get(name)!.fn(...args);

beforeAll(() => { map = buildPgFunctions(); });

describe('PgFunctions — inet boundary branches', () => {
  it('host/text/abbrev return raw string for invalid inet', () => {
    expect(fn('host', 'not-an-ip')).toBe('not-an-ip');
    expect(fn('text', 'not-an-ip')).toBe('not-an-ip');
    expect(fn('abbrev', 'not-an-ip')).toBe('not-an-ip');
  });
  it('set_masklen returns null when either arg is null', () => {
    expect(fn('set_masklen', null, 24)).toBeNull();
    expect(fn('set_masklen', '192.168.1.1', null)).toBeNull();
  });
  it('family/masklen return null for null input', () => {
    expect(fn('family', null)).toBeNull();
    expect(fn('masklen', null)).toBeNull();
  });
  it('inet_merge returns cidr for two addresses', () => {
    expect(fn('inet_merge', '192.168.1.1', '192.168.1.2')).toBe('192.168.1.0/30');
  });
  it('inet_same_family returns true/false', () => {
    expect(fn('inet_same_family', '192.168.1.1', '10.0.0.1')).toBe(true);
    expect(fn('inet_same_family', '192.168.1.1', '2001:db8::1')).toBe(false);
  });
});