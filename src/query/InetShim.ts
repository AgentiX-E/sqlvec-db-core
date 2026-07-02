/**
 * InetShim — PostgreSQL inet/cidr type compatibility shim for SQLite.
 *
 * PostgreSQL provides native inet (IP address) and cidr (network) types
 * with operators like:
 *   - `<<=`   contains or equals (addr is contained by or equals network)
 *   - `<<`    is contained by (addr is strictly within network)
 *   - `>>=`   contains or equals (network contains or equals addr)
 *   - `>>`    contains (network strictly contains addr)
 *   - `&&`    overlaps (two networks have any common addresses)
 *
 * Also provides functions:
 *   - `network(addr)`     — extract network address from inet/cidr
 *   - `broadcast(addr)`   — extract broadcast address
 *   - `hostmask(addr)`    — extract host mask
 *   - `netmask(addr)`     — extract subnet mask
 *   - `masklen(addr)`     — extract prefix length
 *
 * Uses the `ip-address` npm package (v10.x) for parsing.
 *
 * @module InetShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { Address4, Address6 } from 'ip-address';

const logger = PinoLogger.forComponent('InetShim');

// ── Types ────────────────────────────────────────────────────────

export interface InetParseResult {
  /** IP address portion (without CIDR suffix) */
  address: string;
  /** CIDR prefix length (32 for IPv4, 128 for IPv6 if not specified) */
  prefixLength: number;
  /** IP version */
  version: 4 | 6;
  /** Whether parsing succeeded */
  isValid: boolean;
  /** Error message if not valid */
  error?: string;
}

// ── Regex Patterns ──────────────────────────────────────────────

/**
 * Detect inet/cidr type references in SQL.
 */
// eslint-disable-next-line require-unicode-regexp
const INET_TYPE_RE = /\b(inet|cidr)\b/i;

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Parse an IP address string into its components.
 *
 * Supports:
 *   - IPv4: '192.168.1.1', '192.168.1.1/24'
 *   - IPv6: '::1', '2001:db8::/32'
 *
 * Uses the ip-address v10 API:
 *   - `.isCorrect()` for validity
 *   - `.addressMinusSuffix` for raw address
 *   - `.subnetMask` for prefix length
 *
 * @param ipStr - The IP address string to parse
 * @returns Parsed result with address, prefix length, version, and validity
 */
export function parseIp(ipStr: string): InetParseResult {
  if (!ipStr || typeof ipStr !== 'string') {
    return { address: '', prefixLength: 32, version: 4, isValid: false, error: 'Empty input' };
  }

  const trimmed = ipStr.trim();
  if (!trimmed) {
    return { address: '', prefixLength: 32, version: 4, isValid: false, error: 'Empty input' };
  }

  // Try IPv4 first
  try {
    const addr4 = new Address4(trimmed);
    if (addr4.isCorrect()) {
      return {
        address: addr4.addressMinusSuffix ?? '',
        prefixLength: typeof addr4.subnetMask === 'number' ? addr4.subnetMask : 32,
        version: 4,
        isValid: true,
      };
    }
  } catch {
    // Not a valid IPv4 address — try IPv6
  }

  // Try IPv6
  try {
    const addr6 = new Address6(trimmed);
    if (addr6.isCorrect()) {
      return {
        address: addr6.addressMinusSuffix,
        prefixLength: addr6.subnetMask,
        version: 6,
        isValid: true,
      };
    }
  } catch {
    // Not valid
  }

  return {
    address: trimmed,
    prefixLength: 32,
    version: 4,
    isValid: false,
    error: `Invalid IP address: ${trimmed}`,
  };
}

/**
 * Convert an IPv4 address string to a 32-bit integer (big-endian).
 *
 * @param ip - The IPv4 address string (e.g., '192.168.1.1')
 * @returns 32-bit integer representation
 */
export function ipToInt(ip: string, base: number = 10): number {
  const parts = ip.split('.').map(p => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return 0;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Convert a 32-bit integer to an IPv4 address string.
 *
 * @param int - 32-bit integer (unsigned)
 * @param base - Base for output (unused, kept for signature compatibility)
 * @returns IPv4 address string
 */
export function intToIp(int: number, base: number = 10): string {
  const octet3 = int & 0xFF;
  const octet2 = (int >>> 8) & 0xFF;
  const octet1 = (int >>> 16) & 0xFF;
  const octet0 = (int >>> 24) & 0xFF;
  return `${octet0}.${octet1}.${octet2}.${octet3}`;
}

/**
 * Convert a CIDR prefix length to a 32-bit subnet mask integer.
 *
 * @param bits - Prefix length (0-32 for IPv4)
 * @returns Subnet mask as a 32-bit integer
 *
 * @example
 * ```ts
 * cidrToMask(24)  // → 0xFFFFFF00
 * cidrToMask(32)  // → 0xFFFFFFFF
 * cidrToMask(0)   // → 0x00000000
 * ```
 */
export function cidrToMask(bits: number): number {
  if (bits <= 0) return 0;
  if (bits >= 32) return 0xFFFFFFFF;
  return (0xFFFFFFFF << (32 - bits)) >>> 0;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether SQL contains inet or cidr type references.
 *
 * @param sql - The SQL string to inspect
 * @returns `true` if the SQL contains `inet` or `cidr` keyword references
 */
export function detectInetType(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  INET_TYPE_RE.lastIndex = 0;
  return INET_TYPE_RE.test(sql);
}

/**
 * Convert inet notation to cidr notation.
 *
 * In PG, `inet` preserves the host bits, while `cidr` zeroes them out.
 * This function converts an inet string to its canonical cidr form.
 *
 * @param ip - The IP address string (e.g., '192.168.1.5/24')
 * @returns The network address in cidr notation (e.g., '192.168.1.0/24')
 */
export function inetToCidr(ip: string): string {
  if (!ip || typeof ip !== 'string') {
    logger.warn({ ip }, 'inetToCidr: invalid input');
    return ip;
  }

  const parsed = parseIp(ip);
  if (!parsed.isValid) {
    logger.warn({ ip }, 'inetToCidr: invalid IP address');
    return ip;
  }

  if (parsed.version === 6) {
    try {
      const addr6 = new Address6(ip);
      if (addr6.isCorrect()) {
        const startAddr = addr6.startAddress();
        return `${startAddr.addressMinusSuffix}/${parsed.prefixLength}`;
      }
    } catch {
      // Fall through
    }
    return ip;
  }

  // IPv4: apply mask to zero out host bits
  const intIp = ipToInt(parsed.address);
  const mask = cidrToMask(parsed.prefixLength);
  const networkInt = intIp & mask;
  const networkAddr = intToIp(networkInt);
  return `${networkAddr}/${parsed.prefixLength}`;
}

/**
 * Check if an IP address is contained by a network (PG `<<=` operator).
 *
 * Returns `true` if the address is within or equal to the network.
 *
 * @param addr - The IP address to check (e.g., '192.168.1.5')
 * @param network - The network to check against (e.g., '192.168.1.0/24')
 * @returns `true` if addr is contained by or equals the network
 */
export function inetContains(addr: string, network: string): boolean {
  if (!addr || !network) return false;

  const addrParsed = parseIp(addr);
  const netParsed = parseIp(network);

  if (!addrParsed.isValid || !netParsed.isValid) return false;

  if (addrParsed.version !== netParsed.version) return false;

  // For IPv6, use the ip-address library's isInSubnet
  if (addrParsed.version === 6) {
    try {
      const addr6 = new Address6(addr);
      const net6 = new Address6(network);
      return addr6.isInSubnet(net6);
    } catch {
      return false;
    }
  }

  // IPv4: bitwise comparison
  const addrInt = ipToInt(addrParsed.address);
  const netInt = ipToInt(netParsed.address);
  const mask = cidrToMask(netParsed.prefixLength);
  return (addrInt & mask) === (netInt & mask);
}

/**
 * Check if an IP address is strictly contained by a network (PG `<<` operator).
 *
 * Returns `true` if the address is strictly within the network
 * (the network address itself does not qualify).
 *
 * @param addr - The IP address to check
 * @param network - The network to check against
 * @returns `true` if addr is strictly contained by the network
 */
export function inetContainedBy(addr: string, network: string): boolean {
  if (!addr || !network) return false;

  const addrParsed = parseIp(addr);
  const netParsed = parseIp(network);

  if (!addrParsed.isValid || !netParsed.isValid) return false;
  if (addrParsed.version !== netParsed.version) return false;

  if (addrParsed.version === 6) {
    try {
      const addr6 = new Address6(addr);
      const net6 = new Address6(network);
      // Strict containment: must be within but not equal to network address
      return addr6.isInSubnet(net6) && addrParsed.address !== inetToCidr(network).split('/')[0];
    } catch {
      return false;
    }
  }

  // IPv4: strict containment check
  const addrInt = ipToInt(addrParsed.address);
  const netInt = ipToInt(netParsed.address);
  const mask = cidrToMask(netParsed.prefixLength);

  const addrMasked = (addrInt & mask) >>> 0;
  const netMasked = (netInt & mask) >>> 0;

  return addrMasked === netMasked && addrInt !== netInt;
}

/**
 * Return the network address of an inet/cidr value.
 *
 * PG: `network('192.168.1.5/24')` → '192.168.1.0/24'
 *
 * @param address - The IP address string
 * @returns The network address in cidr notation
 */
export function inetNetwork(address: string): string {
  return inetToCidr(address);
}

/**
 * Return the broadcast address of an inet/cidr value.
 *
 * PG: `broadcast('192.168.1.5/24')` → '192.168.1.255'
 *
 * @param address - The IP address string
 * @returns The broadcast address
 */
export function inetBroadcast(address: string): string {
  const parsed = parseIp(address);
  if (!parsed.isValid) {
    logger.warn({ address }, 'inetBroadcast: invalid IP address');
    return address;
  }

  if (parsed.version === 6) {
    try {
      const addr6 = new Address6(address);
      if (addr6.isCorrect()) {
        const endAddr = addr6.endAddress();
        return endAddr.addressMinusSuffix;
      }
    } catch {
      // Fall through
    }
    return address;
  }

  const addrInt = ipToInt(parsed.address);
  const mask = cidrToMask(parsed.prefixLength);
  // Broadcast = network address with host bits set to 1
  const hostMask = (~mask) >>> 0;
  const broadcastInt = (addrInt | hostMask) >>> 0;
  return intToIp(broadcastInt);
}

/**
 * Return the hostmask of an inet/cidr value.
 *
 * PG: `hostmask('192.168.1.5/24')` → '0.0.0.255'
 *
 * The hostmask is the bitwise NOT of the netmask.
 *
 * @param address - The IP address string
 * @returns The hostmask string
 */
export function inetHostmask(address: string): string {
  const parsed = parseIp(address);
  if (!parsed.isValid) {
    logger.warn({ address }, 'inetHostmask: invalid IP address');
    return address;
  }

  if (parsed.version === 6) {
    try {
      const addr6 = new Address6(address);
      if (addr6.isCorrect()) {
        const hostBits = 128 - parsed.prefixLength;
        if (hostBits <= 0) return '::';
        // Build hostmask hex string
        const hostMaskStr = '1'.repeat(hostBits).padStart(128, '0');
        const hostMaskBigInt = BigInt('0b' + hostMaskStr);
        const result = Address6.fromBigInt(hostMaskBigInt);
        return result.correctForm();
      }
    } catch {
      // Fall through
    }
    return address;
  }

  const mask = cidrToMask(parsed.prefixLength);
  const hostMask = (~mask) >>> 0;
  return intToIp(hostMask);
}

/**
 * Return the netmask of an inet/cidr value.
 *
 * PG: `netmask('192.168.1.5/24')` → '255.255.255.0'
 *
 * @param address - The IP address string
 * @returns The netmask string
 */
export function inetNetmask(address: string): string {
  const parsed = parseIp(address);
  if (!parsed.isValid) {
    logger.warn({ address }, 'inetNetmask: invalid IP address');
    return address;
  }

  if (parsed.version === 6) {
    try {
      const addr6 = new Address6(address);
      if (addr6.isCorrect()) {
        // Build netmask from prefix length
        const netBits = parsed.prefixLength;
        if (netBits <= 0) return '::';
        const maskStr = '1'.repeat(netBits).padEnd(128, '0');
        const maskBigInt = BigInt('0b' + maskStr);
        const result = Address6.fromBigInt(maskBigInt);
        return result.correctForm();
      }
    } catch {
      // Fall through
    }
    return address;
  }

  const mask = cidrToMask(parsed.prefixLength);
  return intToIp(mask);
}

// ── Batch 8A: Network / inet functions ───────────────────────────

/**
 * Change the netmask length of an inet value.
 * PG: set_masklen('192.168.1.5/24', 16) → '192.168.1.5/16'
 */
export function setMasklen(ip: string, prefixlen: number): string {
  const parsed = parseIp(ip);
  if (!parsed.isValid) {
    logger.warn({ ip, prefixlen }, 'setMasklen: invalid IP address');
    return ip;
  }
  const bits = Math.max(0, Math.min(parsed.version === 6 ? 128 : 32, Math.round(prefixlen)));
  return `${parsed.address}/${bits}`;
}

/**
 * Find the smallest CIDR that contains both given addresses.
 * PG: inet_merge('192.168.1.5', '192.168.2.5') → '192.168.0.0/22'
 */
export function inetMerge(ip1: string, ip2: string): string {
  const p1 = parseIp(ip1);
  const p2 = parseIp(ip2);
  if (!p1.isValid || !p2.isValid) {
    logger.warn({ ip1, ip2 }, 'inetMerge: invalid input');
    return '0.0.0.0/0';
  }
  if (p1.version !== p2.version) {
    logger.warn({ ip1, ip2 }, 'inetMerge: version mismatch, returning /0');
    return p1.version === 6 ? '::/0' : '0.0.0.0/0';
  }

  if (p1.version === 6) {
    try {
      const a1 = new Address6(ip1);
      const a2 = new Address6(ip2);
      const a1Int = a1.bigInt();
      const a2Int = a2.bigInt();
      const xorResult = a1Int ^ a2Int;
      // Find the leftmost set bit position
      let commonBits = 128;
      if (xorResult > BigInt(0)) {
        commonBits = xorResult.toString(2).length;
        commonBits = 128 - commonBits;
      }
      // Build the merged network address
      const mask = BigInt(2) ** BigInt(128) - BigInt(2) ** BigInt(128 - commonBits);
      const networkInt = a1Int & mask;
      const merged = Address6.fromBigInt(networkInt);
      return `${merged.addressMinusSuffix}/${commonBits}`;
    } catch {
      return '::/0';
    }
  }

  // IPv4: find common prefix bits
  const int1 = ipToInt(p1.address);
  const int2 = ipToInt(p2.address);
  const xorBits = (int1 ^ int2) >>> 0;
  if (xorBits === 0) return `${p1.address}/${p1.prefixLength}`;

  // Count leading zero bits in xor result
  let commonBits = 32;
  for (let i = 31; i >= 0; i--) {
    if ((xorBits >> i) & 1) {
      commonBits = 31 - i;
      break;
    }
  }
  commonBits = 32 - commonBits - 1;
  if (commonBits < 0) commonBits = 0;

  const mask = cidrToMask(commonBits);
  const networkInt = (int1 & mask) >>> 0;
  return `${intToIp(networkInt)}/${commonBits}`;
}

/**
 * Check if two inet values have the same address family.
 * PG: inet_same_family('192.168.1.1', '10.0.0.1') → true
 *     inet_same_family('192.168.1.1', '::1') → false
 */
export function inetSameFamily(ip1: string, ip2: string): boolean {
  const p1 = parseIp(ip1);
  const p2 = parseIp(ip2);
  if (!p1.isValid || !p2.isValid) return false;
  return p1.version === p2.version;
}

/**
 * Return the client address (connection address).
 * PG: inet_client_addr() → sint4 / inet
 * For our synthetic environment, return localhost.
 */
export function inetClientAddr(): string {
  return '127.0.0.1';
}

/**
 * Return the client port.
 * PG: inet_client_port() → int4
 */
export function inetClientPort(): number {
  return 0;
}

/**
 * Return the server address.
 * PG: inet_server_addr() → inet
 */
export function inetServerAddr(): string {
  return '127.0.0.1';
}

/**
 * Return the server port.
 * PG: inet_server_port() → int4
 */
export function inetServerPort(): number {
  return 5432;
}

// ── End Batch 8A ─────────────────────────────────────────────

/**
 * Rewrite inet operators in SQL to SQLite-compatible function call patterns.
 *
 * Supports these PG operators:
 *   - `<<=`  → inet_contains (is contained by or equals)
 *   - `<<`   → inet_contained_by (is strictly contained by)
 *   - `>>=`  → inet_contains (inverted)
 *   - `>>`   → inet_contained_by (inverted)
 *
 * @param sql - The raw SQL string to rewrite
 * @returns Rewritten SQL string with inet operators replaced
 */
export function rewriteInetOperator(sql: string): string {
  if (!sql || typeof sql !== 'string') return sql ?? '';

  // eslint-disable-next-line require-unicode-regexp
  const inetOpRe = /([a-zA-Z_][a-zA-Z0-9_.]*)\s*(<<=|<<|>>=|>>)\s*'([^']+)'/gi;
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  inetOpRe.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inetOpRe.exec(sql)) !== null) {
    const lhs = match[1];
    const operator = match[2];
    const rhs = match[3];

    let replacement: string;
    switch (operator) {
      case '<<=':
        replacement = `inet_contains(${lhs}, '${rhs}')`;
        break;
      case '<<':
        replacement = `inet_contained_by(${lhs}, '${rhs}')`;
        break;
      case '>>=':
        replacement = `inet_contains('${rhs}', ${lhs})`;
        break;
      case '>>':
        replacement = `inet_contained_by('${rhs}', ${lhs})`;
        break;
      default:
        continue;
    }

    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement,
    });
  }

  // Apply right-to-left
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + r.replacement + sql.slice(r.end);
  }

  if (replacements.length > 0) {
    logger.debug({ count: replacements.length }, 'Inet operators rewritten');
  }

  return sql;
}
