import { describe, it, expect } from 'vitest';
import {
  parseIp,
  ipToInt,
  intToIp,
  cidrToMask,
  detectInetType,
  inetToCidr,
  inetContains,
  inetContainedBy,
  inetNetwork,
  inetBroadcast,
  inetHostmask,
  inetNetmask,
  setMasklen,
  inetMerge,
  inetSameFamily,
  inetClientAddr,
  inetClientPort,
  inetServerAddr,
  inetServerPort,
  rewriteInetOperator,
} from '../query/InetShim';

describe('parseIp', () => {
  it('parses a plain IPv4 address', () => {
    expect(parseIp('192.168.1.1')).toMatchObject({
      address: '192.168.1.1',
      prefixLength: 32,
      version: 4,
      isValid: true,
    });
  });

  it('parses an IPv4 CIDR', () => {
    expect(parseIp('192.168.1.1/24')).toMatchObject({
      prefixLength: 24,
      version: 4,
      isValid: true,
    });
  });

  it('parses an IPv6 address', () => {
    expect(parseIp('::1')).toMatchObject({ version: 6, isValid: true, prefixLength: 128 });
    expect(parseIp('2001:db8::/32')).toMatchObject({ version: 6, isValid: true, prefixLength: 32 });
  });

  it('returns invalid for empty / null / non-string', () => {
    expect(parseIp('')).toMatchObject({ isValid: false, error: 'Empty input' });
    expect(parseIp('   ')).toMatchObject({ isValid: false });
    expect(parseIp(null as any)).toMatchObject({ isValid: false });
    expect(parseIp(123 as any)).toMatchObject({ isValid: false });
  });

  it('returns invalid for a malformed address', () => {
    const r = parseIp('not an ip');
    expect(r.isValid).toBe(false);
    expect(r.error).toContain('Invalid IP address');
  });

  it('rejects addresses rejected by ip-address isCorrect() (leading zeros)', () => {
    // ip-address constructs these without throwing but reports isCorrect()
    // false because the canonical form differs from the input. The parser
    // falls through both version branches and reports invalid.
    expect(parseIp('192.168.001.001').isValid).toBe(false);
    expect(parseIp('010.000.000.001').isValid).toBe(false);
  });

  it('rejects IPv6 rejected by isCorrect() (non-canonical expansion)', () => {
    expect(parseIp('2001:0db8:0000:0000:0000:0000:0000:0001').isValid).toBe(false);
    expect(parseIp('::ffff:192.0.2.1').isValid).toBe(false);
  });
});

describe('ipToInt / intToIp', () => {
  it('converts both ways', () => {
    expect(ipToInt('192.168.1.1')).toBe(0xc0a80101);
    expect(intToIp(0xc0a80101)).toBe('192.168.1.1');
  });

  it('returns 0 for malformed input', () => {
    expect(ipToInt('256.1.1.1')).toBe(0);
    expect(ipToInt('a.b.c.d')).toBe(0);
    expect(ipToInt('1.2.3')).toBe(0);
    expect(ipToInt('1.2.3.4.5')).toBe(0);
  });

  it('handles leading/trailing octets', () => {
    expect(ipToInt('0.0.0.0')).toBe(0);
    expect(intToIp(0)).toBe('0.0.0.0');
    expect(intToIp(0xffffffff)).toBe('255.255.255.255');
  });
});

describe('cidrToMask', () => {
  it('computes masks', () => {
    expect(cidrToMask(24)).toBe(0xffffff00);
    expect(cidrToMask(32)).toBe(0xffffffff);
    expect(cidrToMask(0)).toBe(0);
  });

  it('clamps out-of-range', () => {
    expect(cidrToMask(-5)).toBe(0);
    expect(cidrToMask(99)).toBe(0xffffffff);
  });
});

describe('detectInetType (literal-aware)', () => {
  it('detects type references', () => {
    expect(detectInetType('SELECT x::inet FROM t')).toBe(true);
    expect(detectInetType('CREATE TABLE t (ip cidr)')).toBe(true);
    expect(detectInetType('SELECT inet FROM t')).toBe(true);
  });

  it('ignores string literals, comments, and quoted identifiers (regression)', () => {
    expect(detectInetType("SELECT 'inet' AS x")).toBe(false);
    expect(detectInetType('SELECT 1 -- cidr')).toBe(false);
    expect(detectInetType('SELECT 1 /* inet */')).toBe(false);
    expect(detectInetType('SELECT "inet" FROM t')).toBe(false);
  });

  it('does not match substrings of longer identifiers', () => {
    expect(detectInetType('SELECT inet6 FROM t')).toBe(false);
    expect(detectInetType('SELECT mycidr FROM t')).toBe(false);
  });

  it('detects keyword at string boundaries', () => {
    expect(detectInetType('inet')).toBe(true);
    expect(detectInetType('cidr')).toBe(true);
    expect(detectInetType('SELECT cidr')).toBe(true);
    expect(detectInetType('inet_column')).toBe(false);
  });

  it('tolerates unterminated string literals without false positives', () => {
    expect(detectInetType("SELECT 'unterminated inet")).toBe(false);
    expect(detectInetType('SELECT 1 /* unterminated cidr')).toBe(false);
  });

  it('tolerates a bare dollar sign (not a dollar-quote)', () => {
    expect(detectInetType('SELECT $1')).toBe(false);
    expect(detectInetType('SELECT $1 inet')).toBe(true);
  });

  it('returns false for empty / non-string', () => {
    expect(detectInetType('')).toBe(false);
    expect(detectInetType(null as any)).toBe(false);
    expect(detectInetType(undefined as any)).toBe(false);
  });
});

describe('inetToCidr / inetNetwork', () => {
  it('zeroes out host bits (IPv4)', () => {
    expect(inetToCidr('192.168.1.5/24')).toBe('192.168.1.0/24');
  });

  it('handles IPv6', () => {
    expect(inetToCidr('2001:db8::1/32')).toBe('2001:db8::/32');
  });

  it('normalizes IPv6 with surrounding whitespace (regression)', () => {
    // The raw input with whitespace must still be normalized; previously the
    // whitespace made Address6 throw and the function returned the input
    // verbatim instead of the network address.
    expect(inetToCidr(' 2001:db8::1/32 ')).toBe('2001:db8::/32');
  });

  it('returns original for invalid / empty input', () => {
    expect(inetToCidr('not-an-ip')).toBe('not-an-ip');
    expect(inetToCidr('')).toBe('');
    expect(inetToCidr(null as any)).toBe(null);
  });

  it('inetNetwork delegates to inetToCidr', () => {
    expect(inetNetwork('192.168.1.5/24')).toBe('192.168.1.0/24');
  });
});

describe('inetContains (<<=)', () => {
  it('matches contained addresses', () => {
    expect(inetContains('192.168.1.5', '192.168.1.0/24')).toBe(true);
    expect(inetContains('192.168.1.0', '192.168.1.0/24')).toBe(true);
  });

  it('rejects non-contained / cross-version / invalid', () => {
    expect(inetContains('192.168.2.5', '192.168.1.0/24')).toBe(false);
    expect(inetContains('192.168.1.5', '::1')).toBe(false);
    expect(inetContains('', '192.168.1.0/24')).toBe(false);
    expect(inetContains('192.168.1.5', '')).toBe(false);
    expect(inetContains('bad', '192.168.1.0/24')).toBe(false);
  });

  it('handles IPv6', () => {
    expect(inetContains('::1', '::/0')).toBe(true);
  });
});

describe('inetContainedBy (<< strict)', () => {
  it('returns true for strictly-contained address', () => {
    expect(inetContainedBy('192.168.1.5', '192.168.1.0/24')).toBe(true);
  });

  it('returns false for the network address itself', () => {
    expect(inetContainedBy('192.168.1.0', '192.168.1.0/24')).toBe(false);
  });

  it('handles IPv6 strict containment', () => {
    expect(inetContainedBy('::1', '::/0')).toBe(true);
    expect(inetContainedBy('2001:db8::1', '2001:db8::/32')).toBe(true);
  });

  it('returns false for IPv6 strict containment on network address itself', () => {
    expect(inetContainedBy('2001:db8::', '2001:db8::/32')).toBe(false);
  });

  it('returns false for invalid / cross-version', () => {
    expect(inetContainedBy('', '192.168.1.0/24')).toBe(false);
    expect(inetContainedBy('192.168.1.5', '')).toBe(false);
    expect(inetContainedBy('192.168.1.5', '::/0')).toBe(false);
    expect(inetContainedBy('bad', '192.168.1.0/24')).toBe(false);
  });
});

describe('inetBroadcast', () => {
  it('computes IPv4 broadcast', () => {
    expect(inetBroadcast('192.168.1.5/24')).toBe('192.168.1.255');
  });

  it('handles IPv6', () => {
    expect(inetBroadcast('2001:db8::1/126')).toBe('2001:0db8:0000:0000:0000:0000:0000:0003');
  });

  it('handles IPv6 boundary prefix lengths', () => {
    expect(inetBroadcast('2001:db8::1/128')).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
  });

  it('normalizes IPv6 broadcast with surrounding whitespace (regression)', () => {
    expect(inetBroadcast(' 2001:db8::1/126 ')).toBe('2001:0db8:0000:0000:0000:0000:0000:0003');
  });

  it('returns original for invalid input', () => {
    expect(inetBroadcast('bad')).toBe('bad');
  });
});

describe('inetHostmask', () => {
  it('computes IPv4 hostmask', () => {
    expect(inetHostmask('192.168.1.5/24')).toBe('0.0.0.255');
  });

  it('handles IPv6', () => {
    expect(inetHostmask('2001:db8::1/64')).toBe('::ffff:ffff:ffff:ffff');
  });

  it('handles IPv6 full prefix (hostbits 0)', () => {
    expect(inetHostmask('2001:db8::1/128')).toBe('::');
  });

  it('normalizes IPv6 hostmask with surrounding whitespace (regression)', () => {
    expect(inetHostmask(' 2001:db8::1/64 ')).toBe('::ffff:ffff:ffff:ffff');
  });

  it('returns original for invalid input', () => {
    expect(inetHostmask('bad')).toBe('bad');
  });
});

describe('inetNetmask', () => {
  it('computes IPv4 netmask', () => {
    expect(inetNetmask('192.168.1.5/24')).toBe('255.255.255.0');
  });

  it('handles IPv6', () => {
    expect(inetNetmask('2001:db8::1/64')).toBe('ffff:ffff:ffff:ffff::');
  });

  it('handles IPv6 zero prefix (netbits 0)', () => {
    expect(inetNetmask('2001:db8::1/0')).toBe('::');
  });

  it('normalizes IPv6 netmask with surrounding whitespace (regression)', () => {
    expect(inetNetmask(' 2001:db8::1/64 ')).toBe('ffff:ffff:ffff:ffff::');
  });

  it('returns original for invalid input', () => {
    expect(inetNetmask('bad')).toBe('bad');
  });
});

describe('setMasklen', () => {
  it('changes the prefix length', () => {
    expect(setMasklen('192.168.1.5/24', 16)).toBe('192.168.1.5/16');
  });

  it('handles IPv6 prefix', () => {
    expect(setMasklen('2001:db8::1/64', 32)).toBe('2001:db8::1/32');
    expect(setMasklen('2001:db8::1', 999)).toBe('2001:db8::1/128');
  });

  it('clamps to the version range', () => {
    expect(setMasklen('192.168.1.5', -5)).toBe('192.168.1.5/0');
    expect(setMasklen('192.168.1.5', 999)).toBe('192.168.1.5/32');
  });

  it('returns original for invalid input', () => {
    expect(setMasklen('bad', 16)).toBe('bad');
  });
});

describe('inetMerge', () => {
  it('merges distinct IPv4 networks', () => {
    expect(inetMerge('192.168.1.5', '192.168.2.5')).toBe('192.168.0.0/22');
  });

  it('returns the input when addresses are identical', () => {
    expect(inetMerge('1.2.3.4', '1.2.3.4')).toBe('1.2.3.4/32');
  });

  it('merges near IPv4 addresses', () => {
    expect(inetMerge('10.0.0.1', '10.0.0.255')).toBe('10.0.0.0/24');
    expect(inetMerge('10.0.0.1', '10.0.0.2')).toBe('10.0.0.0/30');
  });

  it('handles IPv6', () => {
    expect(inetMerge('2001:db8::1', '2001:db8::2')).toBe('2001:db8::/126');
  });

  it('handles IPv6 identical addresses', () => {
    expect(inetMerge('2001:db8::1', '2001:db8::1')).toBe('2001:db8::1/128');
  });

  it('returns /0 for invalid input', () => {
    expect(inetMerge('bad', '1.2.3.4')).toBe('0.0.0.0/0');
    expect(inetMerge('1.2.3.4', 'bad')).toBe('0.0.0.0/0');
    expect(inetMerge('bad', 'bad')).toBe('0.0.0.0/0');
  });

  it('returns /0 for version mismatch', () => {
    expect(inetMerge('1.2.3.4', '::1')).toBe('0.0.0.0/0');
    expect(inetMerge('::1', '1.2.3.4')).toBe('::/0');
  });
});

describe('inetSameFamily', () => {
  it('compares address families', () => {
    expect(inetSameFamily('1.2.3.4', '5.6.7.8')).toBe(true);
    expect(inetSameFamily('1.2.3.4', '::1')).toBe(false);
  });

  it('returns false for invalid input', () => {
    expect(inetSameFamily('bad', '::1')).toBe(false);
    expect(inetSameFamily('1.2.3.4', 'bad')).toBe(false);
  });
});

describe('client/server address helpers', () => {
  it('returns synthetic localhost values', () => {
    expect(inetClientAddr()).toBe('127.0.0.1');
    expect(inetClientPort()).toBe(0);
    expect(inetServerAddr()).toBe('127.0.0.1');
    expect(inetServerPort()).toBe(5432);
  });
});

describe('rewriteInetOperator (literal-aware)', () => {
  it('rewrites <<= to inet_contains', () => {
    expect(rewriteInetOperator("SELECT a <<= '10.0.0.0/8'")).toBe(
      "SELECT inet_contains(a, '10.0.0.0/8')",
    );
  });

  it('rewrites << to inet_contained_by', () => {
    expect(rewriteInetOperator("SELECT a << '10.0.0.0/8'")).toBe(
      "SELECT inet_contained_by(a, '10.0.0.0/8')",
    );
  });

  it('rewrites >>= with swapped arguments', () => {
    expect(rewriteInetOperator("SELECT a >>= '10.0.0.0/8'")).toBe(
      "SELECT inet_contains('10.0.0.0/8', a)",
    );
  });

  it('rewrites >> with swapped arguments', () => {
    expect(rewriteInetOperator("SELECT a >> '10.0.0.0/8'")).toBe(
      "SELECT inet_contained_by('10.0.0.0/8', a)",
    );
  });

  it('handles column-reference RHS (regression)', () => {
    expect(rewriteInetOperator('SELECT a <<= b')).toBe('SELECT inet_contains(a, b)');
    expect(rewriteInetOperator('SELECT a >> b')).toBe('SELECT inet_contained_by(b, a)');
  });

  it('does NOT rewrite inside string literals or comments (regression)', () => {
    expect(rewriteInetOperator("SELECT 'a <<= b'")).toBe("SELECT 'a <<= b'");
    expect(rewriteInetOperator("SELECT 1 -- a <<= 'x'")).toBe("SELECT 1 -- a <<= 'x'");
    expect(rewriteInetOperator("SELECT 1 /* a <<= 'x' */")).toBe("SELECT 1 /* a <<= 'x' */");
  });

  it('does NOT rewrite when the RHS is missing', () => {
    expect(rewriteInetOperator('SELECT a <<=')).toBe('SELECT a <<=');
    expect(rewriteInetOperator('SELECT a <<= )')).toBe('SELECT a <<= )');
  });

  it('tolerates a bare dollar sign without breaking rewriting', () => {
    expect(rewriteInetOperator("SELECT $1 <<= '10.0.0.0/8'")).toBe(
      "SELECT inet_contains($1, '10.0.0.0/8')",
    );
  });

  it('rewrites multiple occurrences', () => {
    expect(rewriteInetOperator("SELECT a <<= 'x', b >> 'y'")).toBe(
      "SELECT inet_contains(a, 'x'), inet_contained_by('y', b)",
    );
  });

  it('handles operator at the very start (no LHS)', () => {
    // No leading operand — must not produce a broken rewrite.
    expect(rewriteInetOperator("<<= 'x'")).toBe("<<= 'x'");
    expect(rewriteInetOperator('WHERE >> b')).toBe('WHERE >> b');
  });

  it('does not crash on an unterminated string literal after operator', () => {
    expect(rewriteInetOperator("a <<= 'unterminated")).toBe("inet_contains(a, 'unterminated)");
  });

  it('returns input for empty / non-string', () => {
    expect(rewriteInetOperator('')).toBe('');
    expect(rewriteInetOperator(null as any)).toBe('');
    expect(rewriteInetOperator('SELECT 1')).toBe('SELECT 1');
  });
});
