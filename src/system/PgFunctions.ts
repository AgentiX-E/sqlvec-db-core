// @ts-nocheck
/**
 * PgFunctions — PostgreSQL core SQL function simulation layer
 *
 * Pure JavaScript implementations of PostgreSQL's built-in SQL functions.
 * No SQLite dependency. All functions follow the interface:
 *   { name, minArgs, maxArgs, returns, fn(params, session) }
 *
 * For functions returning text, the return type is 'text'.
 * For numeric functions: 'integer' or 'numeric'.
 * For date functions: 'timestamp' or 'text'.
 * For set-returning functions: 'setof integer' etc.
 */

import * as crypto from 'node:crypto';
import { GucSystem } from '../core/GucSystem';
import type { RowLockManager } from '../consensus/RowLockManager';
import { getCurrentDbRef } from './SystemFunctions';
import {
  parseIp,
  setMasklen,
  inetMerge,
  inetSameFamily,
  inetClientAddr,
  inetClientPort,
  inetServerAddr,
  inetServerPort,
} from '../query/InetShim';

/** Global lock manager for pg_blocking_pids */
let blockingPidsLockMgr: RowLockManager | null = null;
export function setBlockingPidsLockMgr(mgr: RowLockManager | null): void {
  blockingPidsLockMgr = mgr;
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export type PgReturnType =
  | 'integer'
  | 'numeric'
  | 'text'
  | 'boolean'
  | 'timestamp'
  | 'timestamptz'
  | 'interval'
  | 'setof integer'
  | 'setof text';

export interface PgFunctionDef {
  name: string;
  minArgs: number;
  maxArgs: number;
  returns: PgReturnType;
  fn: (...args: any[]) => any;
}

export type PgFunctionMap = Map<string, PgFunctionDef>;

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/** Coerce a value to a number, returns NaN if not possible */
function toNumber(v: any): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return isNaN(n) ? NaN : n;
  }
  if (typeof v === 'bigint') return Number(v);
  return NaN;
}

/** Coerce a value to an integer */
function toInt(v: any): number {
  const n = toNumber(v);
  if (isNaN(n)) return NaN;
  return Math.trunc(n);
}

/** Coerce to string, handling null */
function toString(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** Is value null/undefined? */
function isNull(v: any): boolean {
  return v === null || v === undefined;
}

/** PostgreSQL-compatible modulo (result carries the sign of the divisor) */
function pgMod(a: number, b: number): number | null {
  if (b === 0) return null;
  // PostgreSQL defines mod(y, x) = y - floor(y/x) * x, whose remainder is zero
  // or has the same sign as the divisor. JavaScript's `%` is a truncated
  // remainder (sign of the dividend), so it diverges for mixed-sign operands.
  return a - Math.floor(a / b) * b;
}

/** PostgreSQL floor division */
function pgDiv(a: number, b: number): number | null {
  if (b === 0) return null;
  return Math.trunc(a / b);
}

/** Format a duration as PostgreSQL interval string */
function formatInterval(ms: number): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? '-' : '';

  const seconds = Math.floor(abs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(months / 12);

  const parts: string[] = [];
  if (years > 0) parts.push(`${years} year${years > 1 ? 's' : ''}`);
  if (months % 12 > 0) parts.push(`${months % 12} mon${months % 12 > 1 ? 's' : ''}`);
  if (days % 30 > 0) parts.push(`${days % 30} day${days % 30 > 1 ? 's' : ''}`);
  if (hours % 24 > 0) parts.push(`${hours % 24} hour${hours % 24 > 1 ? 's' : ''}`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60} min${minutes % 60 > 1 ? 's' : ''}`);
  if (seconds % 60 > 0 || parts.length === 0) {
    const sec = seconds % 60;
    if (sec > 0 || parts.length === 0) {
      parts.push(`${sec} sec${sec !== 1 ? 's' : ''}`);
    }
  }

  return `${sign}${parts.join(' ')}`;
}

/** Parse an ISO-like date string to Date */
function parseDate(v: any): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const d = new Date(toString(v));
  return isNaN(d.getTime()) ? null : d;
}

/** Format a Date to ISO date string (YYYY-MM-DD) */
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format a Date to ISO timestamp string */
function fmtTimestamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

/** Check if a string is a valid date part unit */
type DatePart = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'millisecond'
  | 'quarter' | 'doy' | 'dow' | 'week' | 'isoyear' | 'isodow' | 'epoch'
  | 'decade' | 'century' | 'millennium'
  | 'timezone' | 'timezone_hour' | 'timezone_minute';

const VALID_DATE_PARTS: Set<string> = new Set([
  'year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond',
  'quarter', 'doy', 'dow', 'week', 'isoyear', 'isodow', 'epoch',
  'decade', 'century', 'millennium',
  'timezone', 'timezone_hour', 'timezone_minute',
]);

// ──────────────────────────────────────────────
//  All Function Definitions
// ──────────────────────────────────────────────

/**
 * Build and return the complete map of all PG SQL functions.
 */
export function buildPgFunctions(): PgFunctionMap {
  const map: PgFunctionMap = new Map();

  // Helper to register a function
  function reg(
    name: string,
    minArgs: number,
    maxArgs: number,
    returns: PgReturnType,
    fn: (...args: any[]) => any,
  ): void {
    map.set(name.toLowerCase(), { name: name.toLowerCase(), minArgs, maxArgs, returns, fn });
  }

  // ════════════════════════════════════════
  //  1. Math Functions (~30)
  // ════════════════════════════════════════

  // greatest(VARIADIC any) → largest non-null argument (PG ignores NULLs,
  // returns NULL only when every argument is NULL). Mixed types are compared
  // numerically when all args are numeric, otherwise lexicographically.
  reg('greatest', 1, Infinity, 'any', (...args: any[]) => {
    const vals = args.filter((a) => !isNull(a));
    if (vals.length === 0) return null;
    if (vals.every((a) => toNumber(a) !== null && !isNaN(toNumber(a)))) {
      return Math.max(...vals.map((a) => toNumber(a)));
    }
    return vals.map((a) => toString(a)).reduce((m, c) => (c > m ? c : m));
  });

  // least(VARIADIC any) → smallest non-null argument (mirror of greatest).
  reg('least', 1, Infinity, 'any', (...args: any[]) => {
    const vals = args.filter((a) => !isNull(a));
    if (vals.length === 0) return null;
    if (vals.every((a) => toNumber(a) !== null && !isNaN(toNumber(a)))) {
      return Math.min(...vals.map((a) => toNumber(a)));
    }
    return vals.map((a) => toString(a)).reduce((m, c) => (c < m ? c : m));
  });

  reg('abs', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : Math.abs(n);
  });

  reg('cbrt', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : Math.cbrt(n);
  });

  reg('ceil', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : Math.ceil(n);
  });

  // ceiling = alias for ceil
  reg('ceiling', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : Math.ceil(n);
  });

  reg('degrees', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : (n * 180) / Math.PI;
  });

  reg('div', 2, 2, 'numeric', (y: any, x: any) => {
    if (isNull(y) || isNull(x)) return null;
    const a = toNumber(y);
    const b = toNumber(x);
    if (isNaN(a) || isNaN(b)) return null;
    return pgDiv(a, b);
  });

  reg('exp', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : Math.exp(n);
  });

  reg('floor', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : Math.floor(n);
  });

  reg('ln', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n) || n <= 0) return null;
    return Math.log(n);
  });

  reg('log', 2, 2, 'numeric', (base: any, v: any) => {
    if (isNull(base) || isNull(v)) return null;
    const b = toNumber(base);
    const n = toNumber(v);
    if (isNaN(b) || isNaN(n) || b <= 0 || b === 1 || n <= 0) return null;
    return Math.log(n) / Math.log(b);
  });

  reg('log10', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n) || n <= 0) return null;
    return Math.log10(n);
  });

  reg('mod', 2, 2, 'numeric', (y: any, x: any) => {
    if (isNull(y) || isNull(x)) return null;
    const a = toNumber(y);
    const b = toNumber(x);
    if (isNaN(a) || isNaN(b)) return null;
    return pgMod(a, b);
  });

  reg('pi', 0, 0, 'numeric', () => Math.PI);

  reg('power', 2, 2, 'numeric', (base: any, exp: any) => {
    if (isNull(base) || isNull(exp)) return null;
    const b = toNumber(base);
    const e = toNumber(exp);
    if (isNaN(b) || isNaN(e)) return null;
    return Math.pow(b, e);
  });

  reg('radians', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : (n * Math.PI) / 180;
  });

  reg('round', 1, 2, 'numeric', (v: any, decimals?: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n)) return null;
    if (decimals === undefined) {
      return Math.round(n);
    }
    const d = toInt(decimals);
    if (isNaN(d)) return null;
    const factor = Math.pow(10, d);
    return Math.round(n * factor) / factor;
  });

  reg('scale', 1, 1, 'integer', (v: any) => {
    if (isNull(v)) return null;
    const s = toString(v);
    const dot = s.indexOf('.');
    if (dot === -1) return 0;
    return s.length - dot - 1;
  });

  reg('sign', 1, 1, 'integer', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n)) return null;
    if (n > 0) return 1;
    if (n < 0) return -1;
    return 0;
  });

  reg('sqrt', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n) || n < 0) return null;
    return Math.sqrt(n);
  });

  reg('trunc', 1, 2, 'numeric', (v: any, decimals?: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n)) return null;
    if (decimals === undefined) {
      return n < 0 ? Math.ceil(n) : Math.floor(n);
    }
    const d = toInt(decimals);
    if (isNaN(d)) return null;
    const factor = Math.pow(10, d);
    return Math.trunc(n * factor) / factor;
  });

  reg('width_bucket', 3, 4, 'integer', (operand: any, b1: any, b2: any, count: any) => {
    if (isNull(operand) || isNull(b1) || isNull(b2) || isNull(count)) return null;
    const op = toNumber(operand);
    const low = toNumber(b1);
    const high = toNumber(b2);
    const cnt = toInt(count);
    if (isNaN(op) || isNaN(low) || isNaN(high) || isNaN(cnt) || cnt <= 0 || low >= high) return null;
    if (op < low) return 0;
    if (op >= high) return cnt + 1;
    const bucket = Math.floor(((op - low) / (high - low)) * cnt) + 1;
    return Math.min(bucket, cnt);
  });

  reg('random', 0, 0, 'numeric', () => Math.random());

  reg('setseed', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    // In actual PG this sets a seed for random(). We just note it.
    const n = toNumber(v);
    if (isNaN(n)) return null;
    return 'setseed';
  });

  // Trigonometric
  reg('sin', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : Math.sin(n);
  });

  reg('cos', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : Math.cos(n);
  });

  reg('tan', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : Math.tan(n);
  });

  reg('asin', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n) || n < -1 || n > 1) return null;
    return Math.asin(n);
  });

  reg('acos', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n) || n < -1 || n > 1) return null;
    return Math.acos(n);
  });

  reg('atan', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    return isNaN(n) ? null : Math.atan(n);
  });

  reg('atan2', 2, 2, 'numeric', (y: any, x: any) => {
    if (isNull(y) || isNull(x)) return null;
    const a = toNumber(y);
    const b = toNumber(x);
    if (isNaN(a) || isNaN(b)) return null;
    return Math.atan2(a, b);
  });

  reg('cot', 1, 1, 'numeric', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n)) return null;
    const t = Math.tan(n);
    if (t === 0) return null; // cot(0) = infinity
    return 1 / t;
  });

  // ════════════════════════════════════════
  //  2. String Functions (~45)
  // ════════════════════════════════════════

  reg('ascii', 1, 1, 'integer', (v: any) => {
    if (isNull(v)) return null;
    const s = toString(v);
    if (s.length === 0) return null;
    return s.charCodeAt(0);
  });

  reg('chr', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    const n = toInt(v);
    if (isNaN(n) || n < 0) return null;
    return String.fromCodePoint(n);
  });

  reg('concat', 0, Infinity, 'text', (...args: any[]) => {
    return args
      .filter(a => a !== null && a !== undefined)
      .map(a => String(a))
      .join('');
  });

  reg('concat_ws', 1, Infinity, 'text', (sep: any, ...args: any[]) => {
    if (isNull(sep)) return null;
    const separator = toString(sep);
    return args
      .filter(a => a !== null && a !== undefined)
      .map(a => String(a))
      .join(separator);
  });

  reg('format', 1, Infinity, 'text', (fmt: any, ...args: any[]) => {
    if (isNull(fmt)) return null;
    const formatStr = toString(fmt);
    // Simple format: %s → string, %L → quote literal, %I → quote ident
    let argIdx = 0;
    return formatStr.replace(/%[sLI]/g, (match) => {
      const arg = args[argIdx++];
      if (match === '%s') return arg === null || arg === undefined ? '' : String(arg);
      if (match === '%L') return quoteLiteral(arg);
      if (match === '%I') return quoteIdent(arg);
      return match;
    });
  });

  reg('initcap', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    const s = toString(v);
    return s.replace(/\w+/g, (word) => {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
  });

  reg('left', 2, 2, 'text', (str: any, n: any) => {
    if (isNull(str) || isNull(n)) return null;
    const s = toString(str);
    const count = toInt(n);
    if (isNaN(count)) return null;
    if (count >= 0) return s.slice(0, count);
    return s.slice(0, Math.max(0, s.length + count));
  });

  reg('length', 1, 1, 'integer', (v: any) => {
    if (isNull(v)) return null;
    return toString(v).length;
  });

  reg('lpad', 2, 3, 'text', (str: any, len: any, fill?: any) => {
    if (isNull(str) || isNull(len)) return null;
    const s = toString(str);
    const l = toInt(len);
    if (isNaN(l)) return null;
    const f = fill !== undefined && fill !== null ? toString(fill) : ' ';
    if (f.length === 0) return s;
    if (l <= s.length) return s.slice(0, l);
    const padLen = l - s.length;
    const pad = f.repeat(Math.ceil(padLen / f.length)).slice(0, padLen);
    return pad + s;
  });

  reg('ltrim', 1, 2, 'text', (str: any, chars?: any) => {
    if (isNull(str)) return null;
    const s = toString(str);
    if (chars === undefined) return s.trimStart();
    const c = toString(chars);
    if (c.length === 0) return s;
    const set = new Set(c);
    let i = 0;
    while (i < s.length && set.has(s[i])) i++;
    return s.slice(i);
  });

  reg('md5', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    return crypto.createHash('md5').update(toString(v)).digest('hex');
  });

  reg('octet_length', 1, 1, 'integer', (v: any) => {
    if (isNull(v)) return null;
    return Buffer.byteLength(toString(v), 'utf8');
  });

  reg('overlay', 4, 4, 'text', (str: any, newStr: any, from: any, forLen?: any) => {
    if (isNull(str) || isNull(newStr) || isNull(from)) return null;
    const s = toString(str);
    const replace = toString(newStr);
    const start = toInt(from);
    const count = forLen !== undefined && forLen !== null ? toInt(forLen) : replace.length;
    if (isNaN(start) || isNaN(count)) return null;
    const idx = Math.max(0, start - 1); // PG is 1-indexed
    return s.slice(0, idx) + replace + s.slice(idx + count);
  });

  reg('pg_client_encoding', 0, 0, 'text', () => 'UTF8');

  // gen_random_uuid() → uuid (PG 13+)
  reg('gen_random_uuid', 0, 0, 'text', () => {
    return crypto.randomUUID();
  });

  reg('position', 2, 2, 'integer', (needle: any, haystack: any) => {
    if (isNull(needle) || isNull(haystack)) return null;
    const n = toString(needle);
    const h = toString(haystack);
    if (n.length === 0) return 1;
    const idx = h.indexOf(n);
    return idx === -1 ? 0 : idx + 1; // PG is 1-indexed
  });

  reg('quote_ident', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    return quoteIdent(v);
  });

  reg('quote_literal', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    return quoteLiteral(v);
  });

  reg('quote_nullable', 1, 1, 'text', (v: any) => {
    if (v === null || v === undefined) return 'NULL';
    return quoteLiteral(v);
  });

  reg('regexp_match', 2, 3, 'text', (str: any, pattern: any, flags?: any) => {
    if (isNull(str) || isNull(pattern)) return null;
    const s = toString(str);
    const p = toString(pattern);
    const f = flags !== undefined && flags !== null ? toString(flags) : '';
    try {
      const re = new RegExp(p, f);
      const m = s.match(re);
      if (!m) return null;
      const captured = m.slice(1);
      // PG returns text[] — return array of captured groups or full match as single element
      return captured.length > 0 ? captured : m[0];
    } catch {
      return null;
    }
  });

  reg('regexp_matches', 2, 3, 'text', (str: any, pattern: any, flags?: any) => {
    if (isNull(str) || isNull(pattern)) return null;
    const s = toString(str);
    const p = toString(pattern);
    const f = flags !== undefined && flags !== null ? toString(flags) : '';
    try {
      const gFlag = f.includes('g') ? 'g' : '';
      const restFlags = f.replace(/g/g, '');
      const re = new RegExp(p, restFlags);
      if (gFlag) {
        const globalRe = new RegExp(p, gFlag + restFlags);
        const matches: string[][] = [];
        let m;
        while ((m = globalRe.exec(s)) !== null) {
          matches.push(m.slice(1).length > 0 ? m.slice(1) : [m[0]]);
        }
        return matches.length > 0 ? matches : null;
      }
      const m = s.match(re);
      if (!m) return null;
      return [m.slice(1).length > 0 ? m.slice(1) : [m[0]]];
    } catch {
      return null;
    }
  });

  reg('regexp_replace', 3, 4, 'text', (str: any, pattern: any, replacement: any, flags?: any) => {
    if (isNull(str) || isNull(pattern) || isNull(replacement)) return null;
    const s = toString(str);
    const p = toString(pattern);
    const r = toString(replacement);
    const f = flags !== undefined && flags !== null ? toString(flags) : '';
    try {
      const isGlobal = f.includes('g');
      const reFlags = f.replace(/g/g, '');
      const re = new RegExp(p, reFlags);
      if (isGlobal) {
        const gre = new RegExp(p, 'g' + reFlags);
        return s.replace(gre, r);
      }
      return s.replace(re, r);
    } catch {
      return null;
    }
  });

  reg('regexp_split_to_array', 2, 3, 'text', (str: any, pattern: any, flags?: any) => {
    if (isNull(str) || isNull(pattern)) return null;
    const s = toString(str);
    const p = toString(pattern);
    const f = flags !== undefined && flags !== null ? toString(flags) : '';
    try {
      const re = new RegExp(p, f);
      return s.split(re);
    } catch {
      return null;
    }
  });

  reg('regexp_split_to_table', 2, 3, 'text', (str: any, pattern: any, flags?: any) => {
    if (isNull(str) || isNull(pattern)) return [];
    const s = toString(str);
    const p = toString(pattern);
    const f = flags !== undefined && flags !== null ? toString(flags) : '';
    try {
      const re = new RegExp(p, f);
      return s.split(re);
    } catch {
      return [];
    }
  });

  // regexp_count(str, pattern[, position[, flags]]) → int
  reg('regexp_count', 2, 4, 'numeric', (str: any, pattern: any, position?: any, flags?: any) => {
    if (isNull(str) || isNull(pattern)) return null;
    const s = toString(str);
    const p = toString(pattern);
    const start = position !== undefined && position !== null ? Math.max(0, toInt(position) - 1) : 0;
    const f = flags !== undefined && flags !== null ? toString(flags) : '';
    try {
      const global = f.includes('g') ? f : f + 'g';
      const re = new RegExp(p, global);
      const sliced = s.slice(start);
      return (sliced.match(re) || []).length;
    } catch {
      return null;
    }
  });

  reg('repeat', 2, 2, 'text', (str: any, n: any) => {
    if (isNull(str) || isNull(n)) return null;
    const s = toString(str);
    const count = toInt(n);
    if (isNaN(count) || count < 0) return null;
    return s.repeat(count);
  });

  reg('replace', 3, 3, 'text', (str: any, from: any, to: any) => {
    if (isNull(str) || isNull(from) || isNull(to)) return null;
    const s = toString(str);
    const f = toString(from);
    const t = toString(to);
    if (f.length === 0) return s;
    return s.split(f).join(t);
  });

  reg('reverse', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    const s = toString(v);
    return s.split('').reverse().join('');
  });

  reg('right', 2, 2, 'text', (str: any, n: any) => {
    if (isNull(str) || isNull(n)) return null;
    const s = toString(str);
    const count = toInt(n);
    if (isNaN(count)) return null;
    // Mirror `left`: n >= 0 takes the last n chars; n < 0 drops the last |n| chars.
    if (count >= 0) return s.slice(Math.max(0, s.length - count));
    return s.slice(0, Math.max(0, s.length + count));
  });

  reg('rpad', 2, 3, 'text', (str: any, len: any, fill?: any) => {
    if (isNull(str) || isNull(len)) return null;
    const s = toString(str);
    const l = toInt(len);
    if (isNaN(l)) return null;
    const f = fill !== undefined && fill !== null ? toString(fill) : ' ';
    if (f.length === 0) return s;
    if (l <= s.length) return s.slice(0, l);
    const padLen = l - s.length;
    const pad = f.repeat(Math.ceil(padLen / f.length)).slice(0, padLen);
    return s + pad;
  });

  reg('rtrim', 1, 2, 'text', (str: any, chars?: any) => {
    if (isNull(str)) return null;
    const s = toString(str);
    if (chars === undefined) return s.trimEnd();
    const c = toString(chars);
    if (c.length === 0) return s;
    const set = new Set(c);
    let i = s.length - 1;
    while (i >= 0 && set.has(s[i])) i--;
    return s.slice(0, i + 1);
  });

  reg('split_part', 3, 3, 'text', (str: any, delimiter: any, field: any) => {
    if (isNull(str) || isNull(delimiter) || isNull(field)) return null;
    const s = toString(str);
    const d = toString(delimiter);
    const f = toInt(field);
    if (isNaN(f)) return null;
    const parts = s.split(d);
    const idx = f > 0 ? f - 1 : parts.length + f;
    if (idx < 0 || idx >= parts.length) return '';
    return parts[idx];
  });

  reg('strpos', 2, 2, 'integer', (str: any, needle: any) => {
    if (isNull(str) || isNull(needle)) return null;
    const s = toString(str);
    const n = toString(needle);
    if (n.length === 0) return 1;
    const idx = s.indexOf(n);
    return idx === -1 ? 0 : idx + 1;
  });

  reg('substr', 2, 3, 'text', (str: any, from: any, count?: any) => {
    if (isNull(str) || isNull(from)) return null;
    const s = toString(str);
    const start = toInt(from);
    if (isNaN(start)) return null;
    const idx = start > 0 ? start - 1 : Math.max(0, s.length + start);
    if (count === undefined) return s.slice(idx);
    const c = toInt(count);
    if (isNaN(c)) return null;
    if (c < 0) return '';
    return s.slice(idx, idx + c);
  });

  // substring = alias for substr, plus SQL standard regex variants:
  //   SUBSTRING(string FROM start FOR count)       — position-based
  //   SUBSTRING(string FROM pattern)                — regex extraction
  //   SUBSTRING(string FROM pattern FOR escape)     — regex with escape char
  reg('substring', 2, 3, 'text', (str: any, from: any, third?: any) => {
    if (isNull(str) || isNull(from)) return null;
    const s = toString(str);

    // Detect regex variant: FROM is a string (pattern), not a number (position)
    if (typeof from === 'string' || from instanceof String || typeof from === 'bigint') {
      // Also check if from is purely numeric (optionally signed) — if so treat as position variant
      const fromStr = toString(from);
      if (/^-?\d+$/.test(fromStr)) {
        return doSubstringByPos(s, parseInt(fromStr, 10), third);
      }
      // Regex variant: SUBSTRING(str FROM pattern) or SUBSTRING(str FROM pattern FOR escape)
      if (third === undefined || third === null) {
        // Extract first match of pattern
        const match = s.match(new RegExp(fromStr));
        return match ? match[0] : '';
      }
      // SUBSTRING(str FROM pattern FOR escape) — with escape char
      // In standard SQL, the escape char is used within pattern to escape meta-characters.
      // Simplified: treat escape as a literal marker — keep chars after non-escaped escape
      const escapeStr = toString(third);
      if (!escapeStr) {
        const match = s.match(new RegExp(fromStr));
        return match ? match[0] : '';
      }
      // With escape char: escape the escape char in the pattern before matching
      const escapedPattern = fromStr.replace(new RegExp(escapeStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '\\$&');
      try {
        const match = s.match(new RegExp(escapedPattern));
        return match ? match[0] : '';
      } catch {
        return '';
      }
    }

    return doSubstringByPos(s, from, third);
  });

  function doSubstringByPos(s: string, from: any, count?: any): string {
    const start = toInt(from);
    if (isNaN(start)) return '';
    const idx = start > 0 ? start - 1 : Math.max(0, s.length + start);
    if (count === undefined) return s.slice(idx);
    const c = toInt(count);
    if (isNaN(c)) return '';
    if (c < 0) return '';
    return s.slice(idx, idx + c);
  }

  reg('translate', 3, 3, 'text', (str: any, from: any, to: any) => {
    if (isNull(str) || isNull(from) || isNull(to)) return null;
    const s = toString(str);
    const f = toString(from);
    const t = toString(to);
    const map = new Map<string, string | null>();
    for (let i = 0; i < f.length; i++) {
      map.set(f[i], i < t.length ? t[i] : null);
    }
    return s.split('').map(ch => {
      const replacement = map.get(ch);
      if (replacement === undefined) return ch;
      return replacement;
    }).join('');
  });

  reg('trim', 1, 3, 'text', (str: any, chars?: any, where?: any) => {
    if (isNull(str)) return null;
    const s = toString(str);
    // In PG: TRIM(LEADING/TRAILING/BOTH chars FROM str)
    // Here we support trim(str), trim(str, chars), trim(str, chars, where)
    if (chars === undefined && where === undefined) return s.trim();
    const c = toString(chars);
    const set = new Set(c);
    let result = s;
    const mode = where !== undefined ? toString(where).toUpperCase() : 'BOTH';
    if (mode === 'LEADING' || mode === 'BOTH') {
      let i = 0;
      while (i < result.length && set.has(result[i])) i++;
      result = result.slice(i);
    }
    if (mode === 'TRAILING' || mode === 'BOTH') {
      let i = result.length - 1;
      while (i >= 0 && set.has(result[i])) i--;
      result = result.slice(0, i + 1);
    }
    return result;
  });

  reg('unistr', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    const s = toString(v);
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
      return String.fromCodePoint(parseInt(hex, 16));
    });
  });

  reg('upper', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    return toString(v).toUpperCase();
  });

  reg('lower', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    return toString(v).toLowerCase();
  });

  reg('btrim', 1, 2, 'text', (str: any, chars?: any) => {
    if (isNull(str)) return null;
    const s = toString(str);
    if (chars === undefined) return s.trim();
    const c = toString(chars);
    if (c.length === 0) return s;
    const set = new Set(c);
    let start = 0;
    while (start < s.length && set.has(s[start])) start++;
    let end = s.length - 1;
    while (end >= start && set.has(s[end])) end--;
    return s.slice(start, end + 1);
  });

  reg('bit_length', 1, 1, 'integer', (v: any) => {
    if (isNull(v)) return null;
    return Buffer.byteLength(toString(v), 'utf8') * 8;
  });

  reg('char_length', 1, 1, 'integer', (v: any) => {
    if (isNull(v)) return null;
    return toString(v).length;
  });

  reg('character_length', 1, 1, 'integer', (v: any) => {
    if (isNull(v)) return null;
    return toString(v).length;
  });

  reg('encode', 2, 2, 'text', (data: any, format: any) => {
    if (isNull(data) || isNull(format)) return null;
    const fmt = toString(format).toLowerCase();
    // data can be a string or Buffer
    let buf: Buffer;
    if (Buffer.isBuffer(data)) {
      buf = data;
    } else if (data instanceof Uint8Array) {
      buf = Buffer.from(data);
    } else {
      buf = Buffer.from(toString(data), 'utf8');
    }
    switch (fmt) {
      case 'hex': return buf.toString('hex');
      case 'base64': return buf.toString('base64');
      case 'escape': return buf.toString('utf8');
      default: return null;
    }
  });

  reg('decode', 2, 2, 'text', (data: any, format: any) => {
    if (isNull(data) || isNull(format)) return null;
    const s = toString(data);
    const fmt = toString(format).toLowerCase();
    let buf: Buffer;
    switch (fmt) {
      case 'hex':
        buf = Buffer.from(s, 'hex');
        break;
      case 'base64':
        buf = Buffer.from(s, 'base64');
        break;
      case 'escape':
        buf = Buffer.from(s, 'utf8');
        break;
      default:
        return null;
    }
    return buf.toString('utf8');
  });

  // SHA family
  reg('sha256', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    return crypto.createHash('sha256').update(toString(v)).digest('hex');
  });

  reg('sha224', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    return crypto.createHash('sha224').update(toString(v)).digest('hex');
  });

  reg('sha384', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    return crypto.createHash('sha384').update(toString(v)).digest('hex');
  });

  reg('sha512', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    return crypto.createHash('sha512').update(toString(v)).digest('hex');
  });

  // ════════════════════════════════════════
  //  3. Date/Time Functions (~25)
  // ════════════════════════════════════════

  reg('age', 1, 2, 'text', (v1: any, v2?: any) => {
    // age(timestamp) or age(timestamp, timestamp)
    if (isNull(v1)) return null;
    if (v2 === undefined) {
      // age from now
      const d1 = parseDate(v1);
      if (!d1) return null;
      return formatInterval(Date.now() - d1.getTime());
    }
    if (isNull(v2)) return null;
    const d1 = parseDate(v1);
    const d2 = parseDate(v2);
    if (!d1 || !d2) return null;
    return formatInterval(d1.getTime() - d2.getTime());
  });

  reg('clock_timestamp', 0, 0, 'timestamp', () => {
    return fmtTimestamp(new Date());
  });

  reg('current_date', 0, 0, 'text', () => {
    return fmtDate(new Date());
  });

  reg('current_time', 0, 0, 'text', () => {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  });

  reg('current_timestamp', 0, 0, 'timestamp', () => {
    return fmtTimestamp(new Date());
  });

  reg('date_bin', 3, 3, 'timestamp', (stride: any, source: any, origin: any) => {
    if (isNull(stride) || isNull(source) || isNull(origin)) return null;
    const s = parseDate(source);
    const o = parseDate(origin);
    if (!s || !o) return null;
    const strideMs = parseIntervalMs(stride);
    if (strideMs === null || strideMs <= 0) return null;
    const diff = s.getTime() - o.getTime();
    const bins = Math.floor(diff / strideMs);
    const result = new Date(o.getTime() + bins * strideMs);
    return fmtTimestamp(result);
  });

  reg('date_part', 2, 2, 'numeric', (part: any, source: any) => {
    if (isNull(part) || isNull(source)) return null;
    return extractDatePart(toString(part).toLowerCase(), source);
  });

  reg('date_trunc', 2, 2, 'timestamp', (part: any, source: any) => {
    if (isNull(part) || isNull(source)) return null;
    const p = toString(part).toLowerCase();
    const d = parseDate(source);
    if (!d) return null;
    const truncated = truncateDate(p, d);
    return truncated ? fmtTimestamp(truncated) : null;
  });

  reg('extract', 2, 2, 'numeric', (part: any, source: any) => {
    if (isNull(part) || isNull(source)) return null;
    return extractDatePart(toString(part).toLowerCase(), source);
  });

  reg('isfinite', 1, 1, 'boolean', (v: any) => {
    if (isNull(v)) return null;
    const d = parseDate(v);
    if (!d) return false;
    return isFinite(d.getTime());
  });

  reg('justify_days', 1, 1, 'interval', (v: any) => {
    // Simple: convert days to months+days approximation
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n)) return null;
    const days = Math.floor(n);
    const months = Math.floor(days / 30);
    const remainingDays = days % 30;
    const parts: string[] = [];
    if (months > 0) parts.push(`${months} mon${months > 1 ? 's' : ''}`);
    if (remainingDays > 0) parts.push(`${remainingDays} day${remainingDays > 1 ? 's' : ''}`);
    return parts.join(' ') || '0 days';
  });

  reg('justify_hours', 1, 1, 'interval', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n)) return null;
    const hours = Math.floor(n);
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    const parts: string[] = [];
    if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
    if (remainingHours > 0) parts.push(`${remainingHours} hour${remainingHours > 1 ? 's' : ''}`);
    return parts.join(' ') || '0 hours';
  });

  reg('justify_interval', 1, 1, 'interval', (v: any) => {
    if (isNull(v)) return null;
    const n = toNumber(v);
    if (isNaN(n)) return null;
    const totalHours = n;
    const days = Math.floor(totalHours / 24);
    const hours = Math.floor(totalHours % 24);
    const months = Math.floor(days / 30);
    const remainingDays = days % 30;
    const parts: string[] = [];
    if (months > 0) parts.push(`${months} mon${months > 1 ? 's' : ''}`);
    if (remainingDays > 0) parts.push(`${remainingDays} day${remainingDays > 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    return parts.join(' ') || '0 hours';
  });

  reg('localtime', 0, 0, 'text', () => {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  });

  reg('localtimestamp', 0, 0, 'timestamp', () => {
    return fmtTimestamp(new Date());
  });

  reg('make_date', 3, 3, 'text', (year: any, month: any, day: any) => {
    if (isNull(year) || isNull(month) || isNull(day)) return null;
    const y = toInt(year);
    const m = toInt(month);
    const d = toInt(day);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
    const dt = new Date(y, m - 1, d);
    // Verify the date is valid
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return fmtDate(dt);
  });

  reg('make_interval', 0, 7, 'interval', (years?: any, months?: any, weeks?: any, days?: any, hours?: any, mins?: any, secs?: any) => {
    const y = years !== undefined && years !== null ? toNumber(years) : 0;
    const mo = months !== undefined && months !== null ? toNumber(months) : 0;
    const w = weeks !== undefined && weeks !== null ? toNumber(weeks) : 0;
    const d = days !== undefined && days !== null ? toNumber(days) : 0;
    const h = hours !== undefined && hours !== null ? toNumber(hours) : 0;
    const mi = mins !== undefined && mins !== null ? toNumber(mins) : 0;
    const s = secs !== undefined && secs !== null ? toNumber(secs) : 0;
    if ([y, mo, w, d, h, mi, s].some(isNaN)) return null;
    const totalDays = d + w * 7;
    const parts: string[] = [];
    if (Math.abs(y) > 0) parts.push(`${y} year${Math.abs(y) !== 1 ? 's' : ''}`);
    if (Math.abs(mo) > 0) parts.push(`${mo} mon${Math.abs(mo) !== 1 ? 's' : ''}`);
    if (Math.abs(totalDays) > 0) parts.push(`${totalDays} day${Math.abs(totalDays) !== 1 ? 's' : ''}`);
    if (Math.abs(h) > 0) parts.push(`${h} hour${Math.abs(h) !== 1 ? 's' : ''}`);
    if (Math.abs(mi) > 0) parts.push(`${mi} min${Math.abs(mi) !== 1 ? 's' : ''}`);
    if (Math.abs(s) > 0 || parts.length === 0) parts.push(`${s} sec${Math.abs(s) !== 1 ? 's' : ''}`);
    return parts.join(' ');
  });

  reg('make_time', 3, 3, 'text', (hour: any, min: any, sec: any) => {
    if (isNull(hour) || isNull(min) || isNull(sec)) return null;
    const h = toInt(hour);
    const m = toInt(min);
    const s = toNumber(sec);
    if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s >= 60) return null;
    // Whole seconds pad to "05"; fractional seconds pad the integer part to
    // "03.500000" so the seconds field is always two digits wide.
    const secInt = Math.floor(s).toString().padStart(2, '0');
    const secStr = s === Math.floor(s) ? secInt : `${secInt}.${s.toFixed(6).split('.')[1]}`;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${secStr}`;
  });

  reg('make_timestamp', 6, 6, 'timestamp', (year: any, month: any, day: any, hour: any, min: any, sec: any) => {
    if ([year, month, day, hour, min, sec].some(isNull)) return null;
    const y = toInt(year);
    const mo = toInt(month);
    const d = toInt(day);
    const h = toInt(hour);
    const mi = toInt(min);
    const s = toNumber(sec);
    if ([y, mo, d, h, mi, s].some(isNaN)) return null;
    const dt = new Date(y, mo - 1, d, h, mi, Math.floor(s));
    return fmtTimestamp(dt);
  });

  reg('make_timestamptz', 6, 6, 'timestamptz', (year: any, month: any, day: any, hour: any, min: any, sec: any) => {
    if ([year, month, day, hour, min, sec].some(isNull)) return null;
    const y = toInt(year);
    const mo = toInt(month);
    const d = toInt(day);
    const h = toInt(hour);
    const mi = toInt(min);
    const s = toNumber(sec);
    if ([y, mo, d, h, mi, s].some(isNaN)) return null;
    const dt = new Date(y, mo - 1, d, h, mi, Math.floor(s));
    return fmtTimestamp(dt);
  });

  reg('now', 0, 0, 'timestamp', () => {
    return fmtTimestamp(new Date());
  });

  reg('pg_sleep', 1, 1, 'text', (v: any) => {
    if (v === null || v === undefined) return null;
    const sec = toNumber(v);
    if (isNaN(sec) || sec < 0) return null;
    const ms = Math.round(sec * 1000);
    if (ms <= 0) return 'pg_sleep';
    // 同步阻塞指定毫秒
    const sab = new SharedArrayBuffer(4);
    const i32 = new Int32Array(sab);
    Atomics.wait(i32, 0, 0, ms);
    return 'pg_sleep';
  });

  reg('statement_timestamp', 0, 0, 'timestamp', () => {
    return fmtTimestamp(new Date());
  });

  reg('timeofday', 0, 0, 'text', () => {
    const now = new Date();
    const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][now.getDay()];
    const mon = ['Mon', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getMonth()];
    const d = String(now.getDate()).padStart(2, ' ');
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const y = now.getFullYear();
    const tz = 'CST'; // Simplified
    return `${dow} ${mon} ${d} ${h}:${m}:${s} ${tz} ${y}`;
  });

  reg('transaction_timestamp', 0, 0, 'timestamp', () => {
    return fmtTimestamp(new Date());
  });

  // ════════════════════════════════════════
  //  4. Set-Returning Functions (XX series)
  // ════════════════════════════════════════

  reg('generate_series', 2, 3, 'setof integer', (start: any, stop: any, step?: any) => {
    if (isNull(start) || isNull(stop)) return [];
    const s = toNumber(start);
    const e = toNumber(stop);
    const st = step !== undefined && step !== null ? toNumber(step) : 1;
    if (isNaN(s) || isNaN(e) || isNaN(st) || st === 0) return [];
    const results: number[] = [];
    if (st > 0) {
      for (let i = s; i <= e; i += st) {
        results.push(i);
      }
    } else {
      for (let i = s; i >= e; i += st) {
        results.push(i);
      }
    }
    return results;
  });

  reg('generate_subscripts', 2, 3, 'setof integer', (arr: any, dim: any, reverse?: any) => {
    if (isNull(arr) || isNull(dim)) return [];
    if (!Array.isArray(arr)) return [];
    const d = toInt(dim);
    if (isNaN(d) || d < 1) return [];
    const len = arr.length;
    if (len === 0) return [];
    const rev = reverse !== undefined && reverse !== null && toString(reverse).toLowerCase() === 'true';
    const results: number[] = [];
    if (rev) {
      for (let i = len; i >= 1; i--) results.push(i);
    } else {
      for (let i = 1; i <= len; i++) results.push(i);
    }
    return results;
  });

  // ════════════════════════════════════════
  //  5. JSON Functions (P3)
  // ════════════════════════════════════════

  // json_build_object(VARIADIC any) → json
  reg('json_build_object', 0, Infinity, 'text', (...args: any[]) => {
    const obj: Record<string, any> = {};
    for (let i = 0; i < args.length - 1; i += 2) {
      const key = args[i] !== null && args[i] !== undefined ? String(args[i]) : null;
      if (key === null) continue;
      obj[key] = args[i + 1] !== undefined ? args[i + 1] : null;
    }
    return JSON.stringify(obj);
  });

  // to_jsonb(anyelement) → jsonb — alias of to_json (jsonb is rendered as json text)
  reg('to_jsonb', 1, 1, 'text', (v: any) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') {
      try { JSON.parse(v); return v; } catch { /* not json */ }
      return JSON.stringify(v);
    }
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  });

  // jsonb_build_object(VARIADIC any) → jsonb — alias of json_build_object
  reg('jsonb_build_object', 0, Infinity, 'text', (...args: any[]) => {
    const obj: Record<string, any> = {};
    for (let i = 0; i < args.length - 1; i += 2) {
      const key = args[i] !== null && args[i] !== undefined ? String(args[i]) : null;
      if (key === null) continue;
      obj[key] = args[i + 1] !== undefined ? args[i + 1] : null;
    }
    return JSON.stringify(obj);
  });

  // jsonb_build_array(VARIADIC any) → jsonb array
  reg('jsonb_build_array', 0, Infinity, 'text', (...args: any[]) => {
    return JSON.stringify(args.map((a) => (a === undefined ? null : a)));
  });

  // to_json(anyelement) → json
  reg('to_json', 1, 1, 'text', (v: any) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') {
      // 尝试解析已经是 JSON 字符串的情况
      try { JSON.parse(v); return v; } catch { /* not json */ }
      return JSON.stringify(v);
    }
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  });

  // row_to_json(record) → json
  reg('row_to_json', 1, 1, 'text', (v: any) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return '{}'; }
    }
    return JSON.stringify({ value: v });
  });

  // json_agg(any) → text (simulated aggregate via JSON array builder)
  reg('json_agg', 1, 1, 'text', (v: any) => {
    if (v === null || v === undefined) return '[]';
    // Accept single values as single-element arrays
    if (typeof v === 'object' && Array.isArray(v)) {
      try { return JSON.stringify(v); } catch { return '[]'; }
    }
    return JSON.stringify([v]);
  });

  // ════════════════════════════════════════
  //  6. PG Stat Function Stubs (P3)
  // ════════════════════════════════════════

  // pg_blocking_pids(pid int4) → int4[]
  reg('pg_blocking_pids', 1, 1, 'text', (_pid: any) => {
    if (blockingPidsLockMgr) {
      try {
        const waitInfo = blockingPidsLockMgr.getWaitInfo();
        if (waitInfo.length > 0) {
          const blockers = [...new Set(waitInfo.map(w => {
            let hash = 0;
            for (let i = 0; i < w.waitingFor.length; i++) {
              hash = ((hash << 5) - hash) + w.waitingFor.charCodeAt(i);
              hash |= 0;
            }
            return Math.abs(hash);
          }))];
          return `{${blockers.join(',')}}`;
        }
      } catch { /* fallthrough */ }
    }
    return '{}';
  });

  // pg_prewarm(regclass) → integer
  // No-op stub: SQLite does not have a managed buffer pool.
  reg('pg_prewarm', 1, 1, 'integer', (_rel: any) => {
    return 0;
  });

  // ── Advisory lock stubs ──────────────────────────────────────
  // PostgreSQL advisory lock functions: no-op stubs for SQLite compat.
  // Actual interception happens in AdvisoryLockShim.ts at the SQL layer.
  // These stubs exist so that FunctionMap lookups don't produce errors.

  reg('pg_advisory_lock', 1, 2, 'text', (..._args: any[]) => {
    return null; // no-op
  });

  reg('pg_try_advisory_lock', 1, 2, 'boolean', (..._args: any[]) => {
    return true; // always succeeds
  });

  reg('pg_advisory_unlock', 1, 2, 'boolean', (..._args: any[]) => {
    return true; // always succeeds
  });

  reg('pg_advisory_unlock_all', 0, 0, 'boolean', () => {
    return true;
  });

  reg('pg_advisory_xact_lock', 1, 2, 'text', (..._args: any[]) => {
    return null; // no-op
  });

  reg('pg_try_advisory_xact_lock', 1, 2, 'boolean', (..._args: any[]) => {
    return true; // always succeeds
  });

  // pg_backend_pid() → integer (process.pid)
  reg('pg_backend_pid', 0, 0, 'integer', () => process.pid);

  // pg_is_in_recovery() → boolean
  reg('pg_is_in_recovery', 0, 0, 'boolean', () => false);

  // current_setting(name text) → text
  reg('current_setting', 1, 1, 'text', (name: any) => {
    if (name === null || name === undefined) return null;
    try {
      const guc = GucSystem.getDefaultInstance().registry.get(String(name));
      return (guc?.value != null) ? String(guc.value) : null;
    } catch { return null; }
  });

  // current_query() → text
  reg('current_query', 0, 0, 'text', () => '');

  // current_schemas(include_implicit boolean) → text[]
  reg('current_schemas', 1, 1, 'text', (includeImplicit: any) => {
    if (includeImplicit && String(includeImplicit).toLowerCase() === 'true') {
      return '{pg_catalog,public}';
    }
    return '{public}';
  });

  // pg_cancel_backend(pid integer) → boolean
  reg('pg_cancel_backend', 1, 1, 'boolean', (_pid: any) => true);

  // pg_terminate_backend(pid integer) → boolean
  reg('pg_terminate_backend', 1, 1, 'boolean', (_pid: any) => true);

  // pg_reload_conf() → boolean
  reg('pg_reload_conf', 0, 0, 'boolean', () => true);

  // ════════════════════════════════════════
  //  14. Administration & Backup Functions
  // ════════════════════════════════════════

  // pg_start_backup(label text) → pg_lsn
  reg('pg_start_backup', 1, 1, 'text', (label: any) => {
    void label; // mark backup boundary — real orchestration in BackupManager
    try {
      const { WALStateManager } = require('../storage/WALStateManager');
      return WALStateManager.getInstance().getCurrentLSN() ?? '0/0';
    } catch { return '0/0'; }
  });

  // pg_stop_backup() → pg_lsn (with backup label table result set in PG)
  reg('pg_stop_backup', 0, 0, 'text', () => {
    try {
      const { WALStateManager } = require('../storage/WALStateManager');
      return WALStateManager.getInstance().getCurrentLSN() ?? '0/0';
    } catch { return '0/0'; }
  });

  // pg_switch_wal() → pg_lsn
  reg('pg_switch_wal', 0, 0, 'text', () => {
    try {
      const { WALStateManager } = require('../storage/WALStateManager');
      return WALStateManager.getInstance().switchWAL() ?? '0/0';
    } catch { return '0/0'; }
  });

  // pg_current_wal_lsn() → pg_lsn
  reg('pg_current_wal_lsn', 0, 0, 'text', () => {
    try {
      const { WALStateManager } = require('../storage/WALStateManager');
      return WALStateManager.getInstance().getCurrentLSN() ?? '0/0';
    } catch { return '0/0'; }
  });

  // pg_current_wal_insert_lsn() → pg_lsn
  reg('pg_current_wal_insert_lsn', 0, 0, 'text', () => {
    try {
      const { WALStateManager } = require('../storage/WALStateManager');
      return WALStateManager.getInstance().getCurrentLSN() ?? '0/0';
    } catch { return '0/0'; }
  });

  // ════════════════════════════════════════
  //  15. Database Size Functions
  // ════════════════════════════════════════

  // pg_size_pretty(size int8) → text
  // PostgreSQL returns binary (power-of-2) sizes: bytes → kB (1024) → MB (1024²) → GB (1024³) → TB
  reg('pg_size_pretty', 1, 1, 'text', (v: any) => {
    if (isNull(v)) return null;
    const bytes = toNumber(v);
    if (isNaN(bytes) || bytes < 0) return null;
    if (bytes < 1024) return `${Math.round(bytes)} bytes`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${+kb.toFixed(kb < 10 ? 2 : 0)} kB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${+mb.toFixed(mb < 10 ? 2 : 0)} MB`;
    const gb = mb / 1024;
    if (gb < 1024) return `${+gb.toFixed(gb < 10 ? 2 : 0)} GB`;
    const tb = gb / 1024;
    return `${+tb.toFixed(tb < 10 ? 2 : 0)} TB`;
  });

  // Helper: estimate relation size based on SQLite b-tree pages
  function getRelationSize(rel: string): number {
    try {
      const db = getCurrentDbRef();
      if (!db) return 0;
      // For SQLite databases, query approximate page count for this table
      // Use PRAGMA schema.page_count as base, proportionally allocate
      if (typeof (db as any).prepare === 'function') {
        const pageSizeRow = (db as any).prepare('PRAGMA main.page_size').get();
        const pageSize = pageSizeRow?.['page_size'] ?? pageSizeRow?.page_size ?? 4096;
        const countRow = (db as any).prepare('PRAGMA main.page_count').get();
        const totalPages = countRow?.['page_count'] ?? countRow?.page_count ?? 0;
        // Count all tables to proportionally distribute
        const tables = (db as any).prepare(
          "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table'"
        ).get();
        const tableCount = Math.max(1, tables?.cnt ?? 1);
        return Math.round((totalPages * pageSize) / tableCount);
      }
    } catch { /* fallthrough */ }
    return 0;
  }

  // pg_relation_size(relation text) → int8
  reg('pg_relation_size', 1, 1, 'integer', (rel: any) => {
    if (isNull(rel)) return null;
    return getRelationSize(toString(rel));
  });

  // pg_total_relation_size(relation text) → int8 (table + indexes + TOAST)
  reg('pg_total_relation_size', 1, 1, 'integer', (rel: any) => {
    if (isNull(rel)) return null;
    const base = getRelationSize(toString(rel));
    // Indexes typically add ~30-50% overhead; estimate at 40%
    return Math.round(base * 1.4);
  });

  // pg_table_size(relation text) → int8 (table + TOAST + FSM)
  reg('pg_table_size', 1, 1, 'integer', (rel: any) => {
    if (isNull(rel)) return null;
    return getRelationSize(toString(rel));
  });

  // pg_indexes_size(relation text) → int8 (total indexes size)
  reg('pg_indexes_size', 1, 1, 'integer', (rel: any) => {
    if (isNull(rel)) return null;
    // Indexes typically add ~20-30% overhead
    return Math.round(getRelationSize(toString(rel)) * 0.3);
  });

  // ════════════════════════════════════════
  //  16. Transaction / XID Functions
  // ════════════════════════════════════════

  // pg_current_xact_id() → xid8 (current transaction ID)
  reg('pg_current_xact_id', 0, 0, 'integer', () => {
    try {
      // Try to read xidCounter from MVCCExecutor
      const { MVCCExecutor } = require('../query/MVCCExecutor');
      if (typeof MVCCExecutor.xidCounter !== 'undefined') {
        return Number(MVCCExecutor.xidCounter);
      }
    } catch { /* fallthrough */ }
    return 0;
  });

  // pg_last_committed_xact() → xid (last committed transaction ID)
  reg('pg_last_committed_xact', 0, 0, 'integer', () => {
    try {
      const { MVCCExecutor } = require('../query/MVCCExecutor');
      if (typeof MVCCExecutor.lastCommittedXid !== 'undefined') {
        return Number(MVCCExecutor.lastCommittedXid);
      }
    } catch { /* fallthrough */ }
    return 0;
  });

  // ════════════════════════════════════════
  //  17. Network / inet / cidr Functions
  // ════════════════════════════════════════

  // host(inet|cidr) → text — the address portion without the /suffix.
  reg('host', 1, 1, 'text', (inetVal: any) => {
    if (isNull(inetVal)) return null;
    const parsed = parseIp(toString(inetVal));
    return parsed.isValid ? parsed.address : toString(inetVal);
  });

  // masklen(inet|cidr) → integer — the prefix length (32/128 when unspecified).
  reg('masklen', 1, 1, 'integer', (inetVal: any) => {
    if (isNull(inetVal)) return null;
    return parseIp(toString(inetVal)).prefixLength;
  });

  // family(inet|cidr) → integer — 4 for IPv4, 6 for IPv6.
  reg('family', 1, 1, 'integer', (inetVal: any) => {
    if (isNull(inetVal)) return null;
    return parseIp(toString(inetVal)).version;
  });

  // text(inet|cidr) → text — the canonical address[/suffix] form.
  reg('text', 1, 1, 'text', (inetVal: any) => {
    if (isNull(inetVal)) return null;
    const parsed = parseIp(toString(inetVal));
    if (!parsed.isValid) return toString(inetVal);
    const full = parsed.version === 4 ? 32 : 128;
    return parsed.prefixLength < full
      ? `${parsed.address}/${parsed.prefixLength}`
      : parsed.address;
  });

  // abbrev(inet) → text — abbreviated display form (same canonical text here).
  reg('abbrev', 1, 1, 'text', (inetVal: any) => {
    if (isNull(inetVal)) return null;
    const parsed = parseIp(toString(inetVal));
    if (!parsed.isValid) return toString(inetVal);
    const full = parsed.version === 4 ? 32 : 128;
    return parsed.prefixLength < full
      ? `${parsed.address}/${parsed.prefixLength}`
      : parsed.address;
  });

  // set_masklen(inet, int) → inet — set the prefix length of an address.
  reg('set_masklen', 2, 2, 'inet', (inetVal: any, prefixlen: any) => {
    if (isNull(inetVal) || isNull(prefixlen)) return null;
    return setMasklen(toString(inetVal), Number(prefixlen));
  });

  // inet_merge(inet, inet) → cidr — smallest network containing both addresses.
  reg('inet_merge', 2, 2, 'cidr', (inet1: any, inet2: any) => {
    if (isNull(inet1) || isNull(inet2)) return null;
    return inetMerge(toString(inet1), toString(inet2));
  });

  // inet_same_family(inet, inet) → boolean — whether both share an IP family.
  reg('inet_same_family', 2, 2, 'boolean', (inet1: any, inet2: any) => {
    if (isNull(inet1) || isNull(inet2)) return null;
    return inetSameFamily(toString(inet1), toString(inet2));
  });

  // inet_client_addr() → inet — the client address of the current connection.
  reg('inet_client_addr', 0, 0, 'inet', () => inetClientAddr());

  // inet_client_port() → integer — the client TCP port of the current connection.
  reg('inet_client_port', 0, 0, 'integer', () => inetClientPort());

  // inet_server_addr() → inet — the server address of the current connection.
  reg('inet_server_addr', 0, 0, 'inet', () => inetServerAddr());

  // inet_server_port() → integer — the server TCP port of the current connection.
  reg('inet_server_port', 0, 0, 'integer', () => inetServerPort());

  return map;
}

// ──────────────────────────────────────────────
//  Internal helpers
// ──────────────────────────────────────────────

function quoteIdent(v: any): string {
  const s = toString(v);
  // If identifier is safe (only letters, digits, underscores), return as-is
  if (/^[a-z_][a-z0-9_]*$/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function quoteLiteral(v: any): string {
  const s = toString(v);
  return `'${s.replace(/'/g, "''")}'`;
}

/** Extract a date part from a value */
function extractDatePart(part: string, source: any): number | null {
  if (!VALID_DATE_PARTS.has(part)) return null;

  const d = parseDate(source);
  if (!d) return null;

  switch (part) {
    case 'year': return d.getFullYear();
    case 'month': return d.getMonth() + 1;
    case 'day': return d.getDate();
    case 'hour': return d.getHours();
    case 'minute': return d.getMinutes();
    case 'second': return d.getSeconds() + d.getMilliseconds() / 1000;
    case 'millisecond': return d.getMilliseconds();
    case 'quarter': return Math.floor(d.getMonth() / 3) + 1;
    case 'doy': {
      const start = new Date(d.getFullYear(), 0, 0);
      const diff = d.getTime() - start.getTime();
      return Math.floor(diff / 86400000);
    }
    case 'dow': return d.getDay(); // 0=Sun, 6=Sat (PG: 0=Sun)
    case 'isodow': return d.getDay() === 0 ? 7 : d.getDay();
    case 'week': return getISOWeek(d);
    case 'isoyear': return getISOYear(d);
    case 'epoch': return d.getTime() / 1000;
    case 'decade': return Math.floor(d.getFullYear() / 10) * 10;
    case 'century': return Math.ceil(d.getFullYear() / 100);
    case 'millennium': return Math.ceil(d.getFullYear() / 1000);
    case 'timezone': return 0;
    case 'timezone_hour': return 0;
    case 'timezone_minute': return 0;
    default: return null;
  }
}

/** Get ISO week number */
function getISOWeek(d: Date): number {
  const temp = new Date(d.getTime());
  temp.setHours(0, 0, 0, 0);
  // Thursday in same week
  const dayNum = d.getDay() || 7;
  temp.setDate(temp.getDate() + 4 - dayNum);
  const yearStart = new Date(temp.getFullYear(), 0, 1);
  return Math.ceil(((temp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Get ISO year */
function getISOYear(d: Date): number {
  const temp = new Date(d.getTime());
  const dayNum = d.getDay() || 7;
  temp.setDate(temp.getDate() + 4 - dayNum);
  return temp.getFullYear();
}

/** Truncate a date to the specified part */
function truncateDate(part: string, d: Date): Date | null {
  const r = new Date(d.getTime());

  switch (part) {
    case 'year': {
      r.setMonth(0, 1);
      r.setHours(0, 0, 0, 0);
      return r;
    }
    case 'quarter': {
      const q = Math.floor(d.getMonth() / 3) * 3;
      r.setMonth(q, 1);
      r.setHours(0, 0, 0, 0);
      return r;
    }
    case 'month': {
      r.setDate(1);
      r.setHours(0, 0, 0, 0);
      return r;
    }
    case 'week': {
      const day = r.getDay();
      const diff = day === 0 ? -6 : 1 - day; // Monday start
      r.setDate(r.getDate() + diff);
      r.setHours(0, 0, 0, 0);
      return r;
    }
    case 'isoyear': {
      const isoYear = getISOYear(d);
      // Find Jan 4 of the ISO year (ISO week 1 always contains Jan 4)
      const jan4 = new Date(isoYear, 0, 4);
      const dayOfWeek = jan4.getDay() || 7;
      const monday = new Date(jan4);
      monday.setDate(jan4.getDate() - dayOfWeek + 1);
      return monday;
    }
    case 'day':
    case 'date': {
      r.setHours(0, 0, 0, 0);
      return r;
    }
    case 'hour': {
      r.setMinutes(0, 0, 0);
      return r;
    }
    case 'minute': {
      r.setSeconds(0, 0);
      return r;
    }
    case 'second': {
      r.setMilliseconds(0);
      return r;
    }
    default: {
      return null;
    }
  }
}

/** Parse an interval string like '1 hour' or '30 minutes' to milliseconds */
function parseIntervalMs(v: any): number | null {
  if (isNull(v)) return null;
  const s = toString(v).trim().toLowerCase();

  // Try numeric-only (assume microseconds for PG compat)
  const numOnly = toNumber(v);
  if (s.match(/^-?\d+(\.\d+)?$/) && !isNaN(numOnly)) {
    return numOnly; // Already in ms or us depending on context
  }

  // Parse "N unit" format
  const match = s.match(/^(-?\d+(?:\.\d+)?)\s*(year|month|week|day|hour|minute|second|sec|min|hr)s?\s*$/);
  if (!match) return null;

  const val = parseFloat(match[1]);
  const unit = match[2];

  switch (unit) {
    case 'year': return val * 365.25 * 86400000;
    case 'month': return val * 30 * 86400000;
    case 'week': return val * 7 * 86400000;
    case 'day': return val * 86400000;
    case 'hour':
    case 'hr': return val * 3600000;
    case 'minute':
    case 'min': return val * 60000;
    case 'second':
    case 'sec': return val * 1000;
    default: return null;
  }
}
