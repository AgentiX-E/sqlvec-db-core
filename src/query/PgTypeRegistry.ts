/**
 * PgTypeRegistry — PostgreSQL 类型系统注册表
 *
 * Provides OID ↔ 类型名双向查找、类型分类、隐式类型兼容判断，
 * 以及类型输入/输出函数（模拟 PostgreSQL 行为）。
 *
 * GAP-2: SQL 类型系统
 */

// ──────────────────────────────────────────────
//  Enums & Interfaces
// ──────────────────────────────────────────────

export enum PgTypeCategory {
  Numeric = 'N',     // int2, int4, int8, float4, float8, numeric
  Boolean = 'B',     // bool
  String = 'S',      // text, varchar, bpchar, name, "char"
  DateTime = 'D',    // timestamp, timestamptz, date, time, timetz, interval
  Binary = 'I',      // bytea
  Network = 'X',     // inet, cidr, macaddr, macaddr8
  Geometric = 'G',   // point, line, lseg, box, path, polygon, circle
  JSON = 'J',        // json, jsonb
  Bit = 'b',         // bit, bit varying
  TextSearch = 'T',  // tsvector, tsquery
  UUID = 'U',        // uuid
  XML = 'M',         // xml
  Enum = 'E',        // enum
  Range = 'R',       // range types
  Pseudo = 'P',      // pseudo-types
  Array = 'A',       // array types
  Composite = 'C',   // composite types
  Domain = 'D',      // domain types
}

export interface PgType {
  oid: number;
  name: string;
  category: PgTypeCategory;
  size: number;        // bytes (-1 for variable)
  inputFunc: string;   // text → this type
  outputFunc: string;  // this type → text
  typdelim: string;    // delimiter for arrays
  typbasetype: number; // base type OID (for domains)
  typtype: 'b' | 'c' | 'd' | 'e' | 'p' | 'r'; // base/composite/domain/enum/pseudo/range
}

// ──────────────────────────────────────────────
//  OID Constants
// ──────────────────────────────────────────────

export const PG_OID = {
  // Numeric
  INT2: 21,
  INT4: 23,
  INT8: 20,
  FLOAT4: 700,
  FLOAT8: 701,
  NUMERIC: 1700,
  OID: 26,
  XID: 28,
  CID: 29,
  TID: 27,

  // Boolean
  BOOL: 16,

  // String
  TEXT: 25,
  VARCHAR: 1043,
  BPCHAR: 1042,
  NAME: 19,
  CHAR: 18,

  // Binary
  BYTEA: 17,

  // DateTime
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  DATE: 1082,
  TIME: 1083,
  TIMETZ: 1266,
  INTERVAL: 1186,

  // UUID
  UUID: 2950,

  // JSON
  JSON: 114,
  JSONB: 3802,

  // Network
  INET: 869,
  CIDR: 650,
  MACADDR: 829,
  MACADDR8: 774,

  // Geometric
  POINT: 600,
  LINE: 628,
  LSEG: 601,
  BOX: 603,
  PATH: 602,
  POLYGON: 604,
  CIRCLE: 718,

  // Text Search
  TSVECTOR: 3614,
  TSQUERY: 3615,

  // XML
  XML: 142,

  // Bit string
  BIT: 1560,
  VARBIT: 1562,

  // System/Meta
  PG_LSN: 3220,

  // Currency
  MONEY: 790,
} as const;

// ──────────────────────────────────────────────
//  Type Output Functions (PG value → text)
// ──────────────────────────────────────────────

export type TypeOutput = (value: any) => string;

/** int2/int4 output: number → signed decimal string */
function int2Output(value: number): string {
  return Math.round(value).toString();
}

function int4Output(value: number): string {
  return Math.round(value).toString();
}

/** int8 output: bigint | number → decimal string */
function int8Output(value: bigint | number): string {
  if (typeof value === 'bigint') return value.toString();
  return BigInt(Math.round(value)).toString();
}

function float4Output(value: number): string {
  // PG float4 uses up to 9 significant digits, scientific notation if needed
  const s = value.toPrecision(9);
  // Avoid unnecessary trailing zeros after decimal
  const n = parseFloat(s);
  return n.toString();
}

function float8Output(value: number): string {
  return value.toString();
}

function numericOutput(value: number | string): string {
  if (typeof value === 'string') return value;
  return value.toString();
}

/** bool output: boolean → 't' | 'f' */
function boolOutput(value: boolean): string {
  return value ? 't' : 'f';
}

function textOutput(value: string): string {
  return value;
}

function varcharOutput(value: string): string {
  return value;
}

function bpcharOutput(value: string): string {
  return value;
}

function nameOutput(value: string): string {
  return value;
}

/** bytea output: Buffer | Uint8Array → hex escape format */
function byteaOutput(value: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return '\\x' + buf.toString('hex');
}

/** timestamp/timestamptz output: Date → ISO 8601 */
function timestampOutput(value: Date): string {
  // YYYY-MM-DD HH:MM:SS.mmm (no timezone)
  return padDateTime(value);
}

function timestamptzOutput(value: Date): string {
  // YYYY-MM-DD HH:MM:SS.mmm+HH:MM
  return padDateTime(value) + formatTZ(value);
}

function dateOutput(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function timeOutput(value: Date): string {
  const h = String(value.getHours()).padStart(2, '0');
  const mi = String(value.getMinutes()).padStart(2, '0');
  const s = String(value.getSeconds()).padStart(2, '0');
  const ms = String(value.getMilliseconds()).padStart(3, '0');
  return `${h}:${mi}:${s}.${ms}`;
}

function timetzOutput(value: Date): string {
  return timeOutput(value) + formatTZ(value);
}

function intervalOutput(value: string | { hours?: number; minutes?: number; seconds?: number; days?: number; months?: number }): string {
  if (typeof value === 'string') return value;
  const parts: string[] = [];
  if (value.months) parts.push(`${value.months} mon`);
  if (value.days) parts.push(`${value.days} day`);
  if (value.hours || value.minutes || value.seconds) {
    const h = value.hours ?? 0;
    const m = value.minutes ?? 0;
    const s = value.seconds ?? 0;
    parts.push(`${h}:${m}:${s}`);
  }
  return parts.join(' ');
}

function uuidOutput(value: string): string {
  return value;
}

function jsonOutput(value: any): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function jsonbOutput(value: any): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function inetOutput(value: string): string {
  return value;
}

function cidrOutput(value: string): string {
  return value;
}

function macaddrOutput(value: string): string {
  return value;
}

function pointOutput(value: { x: number; y: number } | string): string {
  if (typeof value === 'string') return value;
  return `(${value.x},${value.y})`;
}

function lineOutput(value: { a: number; b: number; c: number } | string): string {
  if (typeof value === 'string') return value;
  return `{${value.a},${value.b},${value.c}}`;
}

function lsegOutput(value: { x1: number; y1: number; x2: number; y2: number } | string): string {
  if (typeof value === 'string') return value;
  return `[(${value.x1},${value.y1}),(${value.x2},${value.y2})]`;
}

function boxOutput(value: { x1: number; y1: number; x2: number; y2: number } | string): string {
  if (typeof value === 'string') return value;
  return `(${value.x1},${value.y1}),(${value.x2},${value.y2})`;
}

function pathOutput(value: { points: Array<{ x: number; y: number }>; closed?: boolean } | string): string {
  if (typeof value === 'string') return value;
  const pts = value.points.map(p => `(${p.x},${p.y})`).join(',');
  // PostgreSQL distinguishes closed paths `((...))` from open paths `[ ... ]`;
  // each point is already parenthesized `(x,y)`, so a single outer `(...)` for
  // closed paths yields `((x,y),(x,y))`, while open paths use square brackets.
  return value.closed ? `(${pts})` : `[${pts}]`;
}

function polygonOutput(value: { points: Array<{ x: number; y: number }> } | string): string {
  if (typeof value === 'string') return value;
  const pts = value.points.map(p => `(${p.x},${p.y})`).join(',');
  return `(${pts})`;
}

function circleOutput(value: { x: number; y: number; r: number } | string): string {
  if (typeof value === 'string') return value;
  return `<(${value.x},${value.y}),${value.r}>`;
}

function tsvectorOutput(value: string): string {
  return value;
}

function tsqueryOutput(value: string): string {
  return value;
}

function xmlOutput(value: string): string {
  return value;
}

function bitOutput(value: string): string {
  return value;
}

function varbitOutput(value: string): string {
  return value;
}

/** pg_lsn output: bigint → 'X/Y' hex format (PG LSN notation) */
function pgLsnOutput(value: bigint | number): string {
  const n = typeof value === 'bigint' ? value : BigInt(value);
  const upper = n >> 32n;
  const lower = n & 0xFFFFFFFFn;
  return `${upper.toString(16).padStart(8, '0')}/${lower.toString(16).padStart(8, '0')}`;
}

/** money output: number → '$1,234.56' */
function moneyOutput(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${formatted}`;
}

function oidOutput(value: number): string {
  return value.toString();
}

function xidOutput(value: number): string {
  return value.toString();
}

function cidOutput(value: number): string {
  return value.toString();
}

function tidOutput(value: string): string {
  return value;
}

function charOutput(value: string): string {
  return value;
}

// ──────────────────────────────────────────────
//  Type Input Functions (text → PG value)
// ──────────────────────────────────────────────

export type TypeInput = (text: string) => any;

function int2Input(text: string): number {
  const n = parseInt(text, 10);
  if (n < -32768 || n > 32767) {
    throw new RangeError(`int2 out of range: ${text}`);
  }
  return n;
}

function int4Input(text: string): number {
  const n = parseInt(text, 10);
  return n;
}

function int8Input(text: string): bigint {
  return BigInt(text);
}

function float4Input(text: string): number {
  return parseFloat(text);
}

function float8Input(text: string): number {
  return parseFloat(text);
}

function numericInput(text: string): string {
  return text;
}

function boolInput(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (lower === 't' || lower === 'true' || lower === 'yes' || lower === '1' || lower === 'on') return true;
  if (lower === 'f' || lower === 'false' || lower === 'no' || lower === '0' || lower === 'off') return false;
  throw new Error(`invalid boolean input: "${text}"`);
}

function textInput(text: string): string {
  return text;
}

function varcharInput(text: string): string {
  return text;
}

function bpcharInput(text: string): string {
  return text;
}

function nameInput(text: string): string {
  return text;
}

function charInput(text: string): string {
  return text.charAt(0);
}

function byteaInput(text: string): Buffer {
  if (text.startsWith('\\x')) {
    return Buffer.from(text.slice(2), 'hex');
  }
  // PG hex format without \x prefix or simple escape format — treat as hex if only hex chars
  if (/^[0-9a-fA-F]+$/.test(text)) {
    return Buffer.from(text, 'hex');
  }
  return Buffer.from(text, 'utf-8');
}

function timestampInput(text: string): Date {
  const d = new Date(text);
  if (isNaN(d.getTime())) throw new Error(`invalid timestamp: "${text}"`);
  return d;
}

function timestamptzInput(text: string): Date {
  const d = new Date(text);
  if (isNaN(d.getTime())) throw new Error(`invalid timestamptz: "${text}"`);
  return d;
}

function dateInput(text: string): Date {
  const d = new Date(text);
  if (isNaN(d.getTime())) throw new Error(`invalid date: "${text}"`);
  return d;
}

function timeInput(text: string): Date {
  // Parse HH:MM:SS.mmm
  const d = new Date(`1970-01-01T${text}Z`);
  if (isNaN(d.getTime())) throw new Error(`invalid time: "${text}"`);
  return d;
}

function timetzInput(text: string): Date {
  // Parse with timezone offset
  const d = new Date(`1970-01-01T${text}`);
  if (isNaN(d.getTime())) throw new Error(`invalid timetz: "${text}"`);
  return d;
}

function intervalInput(text: string): string {
  return text;
}

function uuidInput(text: string): string {
  // Accept standard UUID format
  if (!/^[0-9a-fA-F-]{36}$/.test(text) && !/^[0-9a-fA-F]{32}$/.test(text)) {
    throw new Error(`invalid uuid: "${text}"`);
  }
  return text;
}

function jsonInput(text: string): string {
  // Validate JSON
  JSON.parse(text);
  return text;
}

function jsonbInput(text: string): string {
  JSON.parse(text);
  return text;
}

function inetInput(text: string): string {
  return text;
}

function cidrInput(text: string): string {
  return text;
}

function macaddrInput(text: string): string {
  return text;
}

/** pg_lsn input: 'X/Y' hex format → bigint WAL offset */
function pgLsnInput(text: string): bigint {
  const m = text.match(/^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/);
  if (!m) throw new Error(`invalid pg_lsn input: "${text}"`);
  const upper = BigInt(parseInt(m[1], 16));
  const lower = BigInt(parseInt(m[2], 16));
  return (upper << 32n) | lower;
}

/** money input: '$1,234.56' or '1234.56' → number */
function moneyInput(text: string): number {
  const cleaned = text.replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  if (isNaN(n)) throw new Error(`invalid money input: "${text}"`);
  return n;
}

function oidInput(text: string): number {
  return parseInt(text, 10);
}

function xidInput(text: string): number {
  return parseInt(text, 10);
}

function cidInput(text: string): number {
  return parseInt(text, 10);
}

function tidInput(text: string): string {
  return text;
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/** Format DateTime as PG timestamp style: YYYY-MM-DD HH:MM:SS.mmm */
function padDateTime(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${y}-${mo}-${day} ${h}:${mi}:${s}.${ms}`;
}

/** Format timezone offset as ±HH:MM */
function formatTZ(d: Date): string {
  const offset = -d.getTimezoneOffset(); // minutes, reverse sign
  const sign = offset >= 0 ? '+' : '-';
  const absMin = Math.abs(offset);
  const h = String(Math.floor(absMin / 60)).padStart(2, '0');
  const m = String(absMin % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

// ──────────────────────────────────────────────
//  Output function map
// ──────────────────────────────────────────────

const OUTPUT_FUNCTIONS: Record<string, TypeOutput> = {
  int2: int2Output,
  int4: int4Output,
  int8: int8Output,
  float4: float4Output,
  float8: float8Output,
  numeric: numericOutput,
  bool: boolOutput,
  text: textOutput,
  varchar: varcharOutput,
  bpchar: bpcharOutput,
  name: nameOutput,
  char: charOutput,
  bytea: byteaOutput,
  timestamp: timestampOutput,
  timestamptz: timestamptzOutput,
  date: dateOutput,
  time: timeOutput,
  timetz: timetzOutput,
  interval: intervalOutput,
  uuid: uuidOutput,
  json: jsonOutput,
  jsonb: jsonbOutput,
  inet: inetOutput,
  cidr: cidrOutput,
  macaddr: macaddrOutput,
  macaddr8: macaddrOutput,
  point: pointOutput,
  line: lineOutput,
  lseg: lsegOutput,
  box: boxOutput,
  path: pathOutput,
  polygon: polygonOutput,
  circle: circleOutput,
  tsvector: tsvectorOutput,
  tsquery: tsqueryOutput,
  xml: xmlOutput,
  bit: bitOutput,
  varbit: varbitOutput,
  pg_lsn: pgLsnOutput,
  money: moneyOutput,
  oid: oidOutput,
  xid: xidOutput,
  cid: cidOutput,
  tid: tidOutput,
};

const INPUT_FUNCTIONS: Record<string, TypeInput> = {
  int2: int2Input,
  int4: int4Input,
  int8: int8Input,
  float4: float4Input,
  float8: float8Input,
  numeric: numericInput,
  bool: boolInput,
  text: textInput,
  varchar: varcharInput,
  bpchar: bpcharInput,
  name: nameInput,
  char: charInput,
  bytea: byteaInput,
  timestamp: timestampInput,
  timestamptz: timestamptzInput,
  date: dateInput,
  time: timeInput,
  timetz: timetzInput,
  interval: intervalInput,
  uuid: uuidInput,
  json: jsonInput,
  jsonb: jsonbInput,
  inet: inetInput,
  cidr: cidrInput,
  macaddr: macaddrInput,
  macaddr8: macaddrInput,
  point: textInput,
  line: textInput,
  lseg: textInput,
  box: textInput,
  path: textInput,
  polygon: textInput,
  circle: textInput,
  tsvector: textInput,
  tsquery: textInput,
  xml: textInput,
  bit: textInput,
  varbit: textInput,
  pg_lsn: pgLsnInput,
  money: moneyInput,
  oid: oidInput,
  xid: xidInput,
  cid: cidInput,
  tid: tidInput,
};

// ──────────────────────────────────────────────
//  Type Compatibility Rules
//  (Based on PG implicit coercion)
// ──────────────────────────────────────────────

interface CompatRule {
  from: number; // source OID
  to: number[];  // compatible target OIDs (implicit cast)
}

const COMPAT_RULES: CompatRule[] = [
  // Numeric widening hierarchy
  { from: PG_OID.INT2, to: [PG_OID.INT4, PG_OID.INT8, PG_OID.FLOAT4, PG_OID.FLOAT8, PG_OID.NUMERIC] },
  { from: PG_OID.INT4, to: [PG_OID.INT8, PG_OID.FLOAT4, PG_OID.FLOAT8, PG_OID.NUMERIC] },
  { from: PG_OID.INT8, to: [PG_OID.NUMERIC, PG_OID.FLOAT8] },
  { from: PG_OID.FLOAT4, to: [PG_OID.FLOAT8, PG_OID.NUMERIC] },
  { from: PG_OID.FLOAT8, to: [PG_OID.NUMERIC] },

  // String widening
  { from: PG_OID.VARCHAR, to: [PG_OID.TEXT] },
  { from: PG_OID.BPCHAR, to: [PG_OID.TEXT] },
  { from: PG_OID.NAME, to: [PG_OID.TEXT] },
  { from: PG_OID.CHAR, to: [PG_OID.TEXT] },

  // JSON → JSONB
  { from: PG_OID.JSON, to: [PG_OID.JSONB] },

  // bit → varbit
  { from: PG_OID.BIT, to: [PG_OID.VARBIT] },

  // Timestamp family: timestamptz → timestamp (lossy), but generally not implicit
  // We'll keep it conservative — no implicit cross-category coercion
];

// ──────────────────────────────────────────────
//  Registry
// ──────────────────────────────────────────────

export class PgTypeRegistry {
  private byOidMap = new Map<number, PgType>();
  private byNameMap = new Map<string, PgType>();

  constructor() {
    this.registerBuiltinTypes();
  }

  // ── Built-in type registration ──

  private registerBuiltinTypes(): void {
    const types: PgType[] = [
      // ── Numeric (N) ──
      { oid: PG_OID.INT2, name: 'int2', category: PgTypeCategory.Numeric, size: 2, inputFunc: 'int2in', outputFunc: 'int2out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.INT4, name: 'int4', category: PgTypeCategory.Numeric, size: 4, inputFunc: 'int4in', outputFunc: 'int4out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.INT8, name: 'int8', category: PgTypeCategory.Numeric, size: 8, inputFunc: 'int8in', outputFunc: 'int8out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.FLOAT4, name: 'float4', category: PgTypeCategory.Numeric, size: 4, inputFunc: 'float4in', outputFunc: 'float4out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.FLOAT8, name: 'float8', category: PgTypeCategory.Numeric, size: 8, inputFunc: 'float8in', outputFunc: 'float8out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.NUMERIC, name: 'numeric', category: PgTypeCategory.Numeric, size: -1, inputFunc: 'numeric_in', outputFunc: 'numeric_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.OID, name: 'oid', category: PgTypeCategory.Numeric, size: 4, inputFunc: 'oidin', outputFunc: 'oidout', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.XID, name: 'xid', category: PgTypeCategory.Numeric, size: 4, inputFunc: 'xidin', outputFunc: 'xidout', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.CID, name: 'cid', category: PgTypeCategory.Numeric, size: 4, inputFunc: 'cidin', outputFunc: 'cidout', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.TID, name: 'tid', category: PgTypeCategory.Numeric, size: 6, inputFunc: 'tidin', outputFunc: 'tidout', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── Boolean (B) ──
      { oid: PG_OID.BOOL, name: 'bool', category: PgTypeCategory.Boolean, size: 1, inputFunc: 'boolin', outputFunc: 'boolout', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── String (S) ──
      { oid: PG_OID.TEXT, name: 'text', category: PgTypeCategory.String, size: -1, inputFunc: 'textin', outputFunc: 'textout', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.VARCHAR, name: 'varchar', category: PgTypeCategory.String, size: -1, inputFunc: 'varcharin', outputFunc: 'varcharout', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.BPCHAR, name: 'bpchar', category: PgTypeCategory.String, size: -1, inputFunc: 'bpcharin', outputFunc: 'bpcharout', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.NAME, name: 'name', category: PgTypeCategory.String, size: 64, inputFunc: 'namein', outputFunc: 'nameout', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.CHAR, name: 'char', category: PgTypeCategory.String, size: 1, inputFunc: 'charin', outputFunc: 'charout', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── Binary (I) ──
      { oid: PG_OID.BYTEA, name: 'bytea', category: PgTypeCategory.Binary, size: -1, inputFunc: 'byteain', outputFunc: 'byteaout', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── DateTime (D) ──
      { oid: PG_OID.TIMESTAMP, name: 'timestamp', category: PgTypeCategory.DateTime, size: 8, inputFunc: 'timestamp_in', outputFunc: 'timestamp_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.TIMESTAMPTZ, name: 'timestamptz', category: PgTypeCategory.DateTime, size: 8, inputFunc: 'timestamptz_in', outputFunc: 'timestamptz_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.DATE, name: 'date', category: PgTypeCategory.DateTime, size: 4, inputFunc: 'date_in', outputFunc: 'date_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.TIME, name: 'time', category: PgTypeCategory.DateTime, size: 8, inputFunc: 'time_in', outputFunc: 'time_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.TIMETZ, name: 'timetz', category: PgTypeCategory.DateTime, size: 12, inputFunc: 'timetz_in', outputFunc: 'timetz_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.INTERVAL, name: 'interval', category: PgTypeCategory.DateTime, size: 16, inputFunc: 'interval_in', outputFunc: 'interval_out', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── Network (X) ──
      { oid: PG_OID.INET, name: 'inet', category: PgTypeCategory.Network, size: -1, inputFunc: 'inet_in', outputFunc: 'inet_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.CIDR, name: 'cidr', category: PgTypeCategory.Network, size: -1, inputFunc: 'cidr_in', outputFunc: 'cidr_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.MACADDR, name: 'macaddr', category: PgTypeCategory.Network, size: 6, inputFunc: 'macaddr_in', outputFunc: 'macaddr_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.MACADDR8, name: 'macaddr8', category: PgTypeCategory.Network, size: 8, inputFunc: 'macaddr8_in', outputFunc: 'macaddr8_out', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── Geometric (G) ──
      { oid: PG_OID.POINT, name: 'point', category: PgTypeCategory.Geometric, size: 16, inputFunc: 'point_in', outputFunc: 'point_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.LINE, name: 'line', category: PgTypeCategory.Geometric, size: 24, inputFunc: 'line_in', outputFunc: 'line_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.LSEG, name: 'lseg', category: PgTypeCategory.Geometric, size: 32, inputFunc: 'lseg_in', outputFunc: 'lseg_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.BOX, name: 'box', category: PgTypeCategory.Geometric, size: 32, inputFunc: 'box_in', outputFunc: 'box_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.PATH, name: 'path', category: PgTypeCategory.Geometric, size: -1, inputFunc: 'path_in', outputFunc: 'path_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.POLYGON, name: 'polygon', category: PgTypeCategory.Geometric, size: -1, inputFunc: 'polygon_in', outputFunc: 'polygon_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.CIRCLE, name: 'circle', category: PgTypeCategory.Geometric, size: 24, inputFunc: 'circle_in', outputFunc: 'circle_out', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── JSON (J) ──
      { oid: PG_OID.JSON, name: 'json', category: PgTypeCategory.JSON, size: -1, inputFunc: 'json_in', outputFunc: 'json_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.JSONB, name: 'jsonb', category: PgTypeCategory.JSON, size: -1, inputFunc: 'jsonb_in', outputFunc: 'jsonb_out', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── Text Search (T) ──
      { oid: PG_OID.TSVECTOR, name: 'tsvector', category: PgTypeCategory.TextSearch, size: -1, inputFunc: 'tsvector_in', outputFunc: 'tsvector_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.TSQUERY, name: 'tsquery', category: PgTypeCategory.TextSearch, size: -1, inputFunc: 'tsquery_in', outputFunc: 'tsquery_out', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── Bit string (b) ──
      { oid: PG_OID.BIT, name: 'bit', category: PgTypeCategory.Bit, size: -1, inputFunc: 'bit_in', outputFunc: 'bit_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      { oid: PG_OID.VARBIT, name: 'varbit', category: PgTypeCategory.Bit, size: -1, inputFunc: 'varbit_in', outputFunc: 'varbit_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      // ── System/Meta ──
      { oid: PG_OID.PG_LSN, name: 'pg_lsn', category: PgTypeCategory.Numeric, size: 8, inputFunc: 'pg_lsn_in', outputFunc: 'pg_lsn_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
      // ── Currency ──
      { oid: PG_OID.MONEY, name: 'money', category: PgTypeCategory.Numeric, size: 8, inputFunc: 'money_in', outputFunc: 'money_out', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── UUID (U) ──
      { oid: PG_OID.UUID, name: 'uuid', category: PgTypeCategory.UUID, size: 16, inputFunc: 'uuid_in', outputFunc: 'uuid_out', typdelim: ',', typbasetype: 0, typtype: 'b' },

      // ── XML (M) ──
      { oid: PG_OID.XML, name: 'xml', category: PgTypeCategory.XML, size: -1, inputFunc: 'xml_in', outputFunc: 'xml_out', typdelim: ',', typbasetype: 0, typtype: 'b' },
    ];

    for (const t of types) {
      this.byOidMap.set(t.oid, t);
      this.byNameMap.set(t.name, t);
    }
  }

  // ── Lookup ──

  /** Look up type by OID. Returns undefined for unknown OIDs. */
  byOid(oid: number): PgType | undefined {
    return this.byOidMap.get(oid);
  }

  /** Look up type by name. Returns undefined for unknown names. */
  byName(name: string): PgType | undefined {
    return this.byNameMap.get(name);
  }

  /** Return all registered types. */
  allTypes(): PgType[] {
    return Array.from(this.byOidMap.values());
  }

  /** Return the number of registered types. */
  get size(): number {
    return this.byOidMap.size;
  }

  // ── Compatibility ──

  /**
   * Check if sourceOID can be implicitly coerced to targetOID.
   * Based on PG's implicit cast rules.
   *
   * - Same OID is always compatible
   * - Widening within same category is compatible (int2→int4, varchar→text)
   * - Cross-category implicit casts must be explicitly defined
   */
  isCompatible(targetOID: number, sourceOID: number): boolean {
    // Same type → always compatible
    if (targetOID === sourceOID) return true;

    // Check explicit rules
    for (const rule of COMPAT_RULES) {
      if (rule.from === sourceOID && rule.to.includes(targetOID)) {
        return true;
      }
    }

    return false;
  }

  // ── Output ──

  /**
   * Convert a JavaScript value to its PostgreSQL text representation.
   *
   * @param typeName - The PG type name
   * @param value - The value to convert
   * @returns The text representation
   */
  output(typeName: string, value: any): string {
    const fn = OUTPUT_FUNCTIONS[typeName];
    if (!fn) {
      // Fallback: toString for unknown types
      if (value === null || value === undefined) return '';
      return String(value);
    }
    return fn(value);
  }

  /**
   * Parse a PostgreSQL text representation into a JavaScript value.
   *
   * @param typeName - The PG type name
   * @param text - The text to parse
   * @returns The parsed JavaScript value
   */
  input(typeName: string, text: string): any {
    const fn = INPUT_FUNCTIONS[typeName];
    if (!fn) return text;
    return fn(text);
  }
}

// ──────────────────────────────────────────────
//  Singleton instance
// ──────────────────────────────────────────────

/** Default shared registry instance */
export const defaultTypeRegistry = new PgTypeRegistry();
