import { describe, it, expect } from 'vitest';
import { buildPgFunctions } from '../system/PgFunctions';

// inet/cidr member functions (host/masklen/family/text/abbrev) are registered
// in the PgFunctions registry (via buildPgFunctions) so they are bound to the
// SQLite connection as scalar UDFs. These tests exercise the pure JS handlers
// directly, covering IPv4/IPv6 and the null/empty defensive branches.
function make() {
  return buildPgFunctions();
}

describe('PgFunctions inet/cidr member functions', () => {
  describe('host', () => {
    it('returns the address portion without a /suffix', () => {
      expect(make().get('host')!.fn('192.168.1.10/24')).toBe('192.168.1.10');
    });
    it('returns the bare address when no suffix is present', () => {
      expect(make().get('host')!.fn('10.0.0.1')).toBe('10.0.0.1');
    });
    it('returns null for null input', () => {
      expect(make().get('host')!.fn(null)).toBe(null);
    });
  });

  describe('masklen', () => {
    it('returns the prefix length', () => {
      expect(make().get('masklen')!.fn('192.168.1.10/24')).toBe(24);
    });
    it('returns the full width when no suffix is specified (IPv4)', () => {
      expect(make().get('masklen')!.fn('10.0.0.1')).toBe(32);
    });
    it('returns null for null input', () => {
      expect(make().get('masklen')!.fn(null)).toBe(null);
    });
  });

  describe('family', () => {
    it('returns 4 for IPv4', () => {
      expect(make().get('family')!.fn('192.168.1.10')).toBe(4);
    });
    it('returns 6 for IPv6', () => {
      expect(make().get('family')!.fn('::1')).toBe(6);
    });
    it('returns null for null input', () => {
      expect(make().get('family')!.fn(null)).toBe(null);
    });
  });

  describe('text', () => {
    it('returns the canonical address with suffix', () => {
      expect(make().get('text')!.fn('192.168.1.10/24')).toBe('192.168.1.10/24');
    });
    it('omits the suffix when the address is host-full', () => {
      expect(make().get('text')!.fn('10.0.0.1')).toBe('10.0.0.1');
    });
    it('returns null for null input', () => {
      expect(make().get('text')!.fn(null)).toBe(null);
    });
  });

  describe('abbrev', () => {
    it('returns the abbreviated display form', () => {
      expect(make().get('abbrev')!.fn('192.168.1.10/24')).toBe('192.168.1.10/24');
    });
    it('returns null for null input', () => {
      expect(make().get('abbrev')!.fn(null)).toBe(null);
    });
  });

  describe('registry wiring', () => {
    it('registers all five members under their lowercase names', () => {
      const m = make();
      for (const name of ['host', 'masklen', 'family', 'text', 'abbrev']) {
        expect(m.has(name)).toBe(true);
      }
    });
  });
});
