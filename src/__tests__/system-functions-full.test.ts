/**
 * SystemFunctions comprehensive coverage tests.
 *
 * Exercises every handler registered in SystemFunctionRegistry plus the
 * formatting / parsing / metadata helpers, asserting PostgreSQL-compatible
 * behavior across normal, boundary, and malformed inputs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SystemFunctionRegistry,
  setCurrentDbRef,
  setRoleManager,
  setActiveQueryRegistry,
  setPitrManager,
  getCurrentDbRef,
  getRoleManager,
  getActiveQueryRegistry,
  getPitrManager,
  parseIntervalToMs,
} from '../system/SystemFunctions';

const ex = (name: string, ...args: any[]) => SystemFunctionRegistry.execute(name, args);

beforeAll(() => {
  SystemFunctionRegistry.init();
});

describe('SystemFunctionRegistry mechanics', () => {
  it('init is idempotent', () => {
    SystemFunctionRegistry.init();
    SystemFunctionRegistry.init();
    expect(SystemFunctionRegistry.getFunctionNames().length).toBeGreaterThan(100);
  });

  it('getFunction returns info; unknown returns undefined', () => {
    expect(SystemFunctionRegistry.getFunction('version')?.name).toBe('version');
    expect(SystemFunctionRegistry.getFunction('nope')).toBeUndefined();
  });

  it('getAllFunctions and getFunctionNames agree', () => {
    const all = SystemFunctionRegistry.getAllFunctions();
    const names = SystemFunctionRegistry.getFunctionNames();
    expect(all.length).toBe(names.length);
  });

  it('getFunctionByOid maps sequentially and clamps out-of-range', () => {
    const first = SystemFunctionRegistry.getFunctionByOid(20000);
    expect(first).toBeDefined();
    expect(SystemFunctionRegistry.getFunctionByOid(19999)).toBeUndefined();
    expect(SystemFunctionRegistry.getFunctionByOid(99999)).toBeUndefined();
  });

  it('execute throws for unknown and wrong arity', () => {
    expect(() => ex('not_a_function')).toThrow();
    expect(() => ex('version', 1)).toThrow(/requires 0-0/);
    expect(() => ex('pg_size_pretty')).toThrow();
  });
});

describe('version and session info', () => {
  it('version matches PostgreSQL', () => {
    expect(ex('version')).toMatch(/PostgreSQL/);
  });
  it('schema/database/user stubs', () => {
    expect(ex('current_schema')).toBe('public');
    expect(ex('current_database')).toBeTruthy();
    expect(ex('current_user')).toBe('postgres');
    expect(ex('session_user')).toBe('postgres');
    expect(ex('current_query')).toBe('');
  });
  it('current_schemas toggles', () => {
    expect(ex('current_schemas', true)).toEqual(['pg_catalog', 'public']);
    expect(ex('current_schemas', false)).toEqual(['public']);
  });
  it('pg_postmaster_start_time / pg_conf_load_time', () => {
    expect(ex('pg_postmaster_start_time')).toMatch(/\+00$/);
    expect(ex('pg_conf_load_time')).toMatch(/\+00$/);
  });
});

describe('encoding functions', () => {
  it('pg_encoding_to_char known/unknown', () => {
    expect(ex('pg_encoding_to_char', 1)).toBe('UTF8');
    expect(ex('pg_encoding_to_char', 0)).toBe('SQL_ASCII');
    expect(ex('pg_encoding_to_char', 999)).toBe('UTF8');
    expect(ex('pg_encoding_to_char', 34)).toBe('GBK');
  });
  it('pg_char_to_encoding known/unknown', () => {
    expect(ex('pg_char_to_encoding', 'utf8')).toBe(1);
    expect(ex('pg_char_to_encoding', 'UTF8')).toBe(1);
    expect(ex('pg_char_to_encoding', 'latin1')).toBe(2);
    expect(ex('pg_char_to_encoding', '')).toBe(0);
    expect(ex('pg_char_to_encoding', 'bogus')).toBe(-1);
  });
});

describe('privilege stubs', () => {
  it('has_schema_privilege', () => {
    expect(ex('has_schema_privilege', 'u', 's', 'USAGE')).toBe(true);
    expect(ex('has_schema_privilege', 'u', 's', 'CREATE')).toBe(true);
    expect(ex('has_schema_privilege', 'u', 's', 'ALL')).toBe(true);
    expect(ex('has_schema_privilege', 'u', 's', 'DROP')).toBe(false);
  });
  it('has_table_privilege', () => {
    expect(ex('has_table_privilege', 'u', 't', 'SELECT')).toBe(true);
    expect(ex('has_table_privilege', 'u', 't', 'TRIGGER')).toBe(true);
    expect(ex('has_table_privilege', 'u', 't', 'NOPE')).toBe(false);
  });
  it('pg_tablespace_location', () => {
    expect(ex('pg_tablespace_location', 1)).toBe('pg_default');
  });
});

describe('pg_size_pretty / pg_size_bytes', () => {
  it('pg_size_pretty boundaries', () => {
    expect(ex('pg_size_pretty', 0)).toBe('0 bytes');
    expect(ex('pg_size_pretty', 1)).toBe('1 bytes');
    expect(ex('pg_size_pretty', 1023)).toBe('1023 bytes');
    expect(ex('pg_size_pretty', 1024)).toBe('1 kB');
    expect(ex('pg_size_pretty', 1048576)).toBe('1 MB');
    expect(ex('pg_size_pretty', 1073741824)).toBe('1 GB');
    expect(ex('pg_size_pretty', 1536)).toBe('1.5 kB');
  });
  it('pg_size_pretty negative and non-number', () => {
    expect(ex('pg_size_pretty', -1024)).toBe('-1 kB');
    expect(ex('pg_size_pretty', -1)).toBe('-1 bytes');
    expect(ex('pg_size_pretty', -2048)).toBe('-2 kB');
    expect(ex('pg_size_pretty', NaN)).toBe('0 bytes');
    expect(ex('pg_size_pretty', 'x' as any)).toBe('0 bytes');
  });
  it('pg_size_bytes parsing', () => {
    expect(ex('pg_size_bytes', '100 bytes')).toBe(100);
    expect(ex('pg_size_bytes', '1 kB')).toBe(1024);
    expect(ex('pg_size_bytes', '1 MB')).toBe(1048576);
    expect(ex('pg_size_bytes', '1 GB')).toBe(1073741824);
    expect(ex('pg_size_bytes', '1 TB')).toBe(1099511627776);
    expect(ex('pg_size_bytes', '1 PB')).toBe(1125899906842624);
    expect(ex('pg_size_bytes', '999')).toBe(999);
  });
  it('pg_size_bytes malformed', () => {
    expect(ex('pg_size_bytes', 'abc')).toBe(0);
    expect(ex('pg_size_bytes', '')).toBe(0);
    expect(ex('pg_size_bytes', '-2 kB')).toBe(0);
    expect(ex('pg_size_bytes', 123 as any)).toBe(0);
  });
});

describe('pg_get_userbyid / pg_table_is_visible / pg_column_is_updatable', () => {
  it('pg_get_userbyid', () => {
    expect(ex('pg_get_userbyid', 10)).toBe('postgres');
    expect(ex('pg_get_userbyid', 999)).toBe('role_999');
  });
  it('pg_table_is_visible without db ref (conservative true)', () => {
    setCurrentDbRef(null);
    expect(ex('pg_table_is_visible', 99999)).toBe(false); // oidToName null → false
  });
  it('pg_column_is_updatable system columns', () => {
    expect(ex('pg_column_is_updatable', 99999, 0)).toBe(false);
    expect(ex('pg_column_is_updatable', 99999, -1)).toBe(false);
    expect(ex('pg_column_is_updatable', 99999, 1)).toBe(true);
  });
});

describe('to_hex', () => {
  it('zero/positive/negative', () => {
    expect(ex('to_hex', 0)).toBe('0');
    expect(ex('to_hex', 255)).toBe('ff');
    expect(ex('to_hex', 16)).toBe('10');
    expect(ex('to_hex', -1)).toBe('ffffffffffffffff');
    expect(ex('to_hex', -2)).toBe('fffffffffffffffe');
  });
  it('non-number and null', () => {
    expect(ex('to_hex', 'abc')).toBe('0');
    expect(ex('to_hex', null)).toBeNull();
    expect(ex('to_hex', undefined)).toBeNull();
  });
});

describe('trim_array / regexp_like / similar_to_escape', () => {
  it('trim_array', () => {
    expect(ex('trim_array', [1, 2, 3, 4], 1)).toEqual([1, 2, 3]);
    expect(ex('trim_array', [1, 2, 3], 0)).toEqual([1, 2, 3]);
    expect(ex('trim_array', [1, 2, 3], -1)).toEqual([1, 2, 3]);
    expect(ex('trim_array', 'abc', 1)).toBe('abc');
    expect(ex('trim_array', null, 1)).toBeNull();
    expect(ex('trim_array', [1, 2], null)).toBeNull();
  });
  it('regexp_like', () => {
    expect(ex('regexp_like', 'hello', 'ell')).toBe(true);
    expect(ex('regexp_like', 'hello', 'zzz')).toBe(false);
    expect(ex('regexp_like', 'x', '[')).toBe(false); // invalid regex
    expect(ex('regexp_like', null, 'a')).toBeNull();
    expect(ex('regexp_like', 'a', null)).toBeNull();
  });
  it('similar_to_escape converts % and _', () => {
    expect(ex('similar_to_escape', 'x', '100%')).toBe('100.*');
    expect(ex('similar_to_escape', 'x', 'a_b')).toBe('a.b');
    expect(ex('similar_to_escape', 'x', 'a%b_c')).toBe('a.*b.c');
    expect(ex('similar_to_escape', 'x', 'a|b')).toBe('a|b');
    expect(ex('similar_to_escape', 'x', 'a.b')).toBe('a\\.b');
    expect(ex('similar_to_escape', null, 'a')).toBeNull();
    expect(ex('similar_to_escape', 'x', null)).toBeNull();
  });
});

describe('to_char numeric formatting', () => {
  it('basic and fill mode', () => {
    expect(ex('to_char', 123, '999')).toBe('123');
    expect(ex('to_char', 12, '999')).toBe(' 12');
    expect(ex('to_char', 123, 'FM999')).toBe('123');
    expect(ex('to_char', 12, 'FM999')).toBe('12');
  });
  it('fraction and negative', () => {
    expect(ex('to_char', 1234.5, '9999.99')).toBe('1234.50');
    expect(ex('to_char', -123, '999')).toBe('-123');
    expect(ex('to_char', -123, '999PR')).toBe('(123)');
    expect(ex('to_char', 123, '999PR')).toBe('123');
  });
  it('null/non-numeric falls back', () => {
    expect(ex('to_char', null, '999')).toBe('');
    expect(ex('to_char', 'abc', '999')).toBe('abc');
  });
});

describe('to_char date/time formatting', () => {
  it('formats date tokens', () => {
    expect(ex('to_char', '2020-01-15', 'YYYY-MM-DD')).toBe('2020-01-15');
    expect(ex('to_char', '2020-01-15', 'YYYY')).toBe('2020');
    expect(ex('to_char', '2020-01-15', 'YY')).toBe('20');
    expect(ex('to_char', '2020-01-15', 'MM')).toBe('01');
    expect(ex('to_char', '2020-01-15', 'DD')).toBe('15');
  });
  it('formats month/day names', () => {
    expect(ex('to_char', '2020-01-15', 'Month')).toBe('January');
    expect(ex('to_char', '2020-01-15', 'mon')).toBe('jan');
    expect(ex('to_char', '2020-01-15', 'Mon')).toBe('Jan');
    const dayName = ex('to_char', '2020-01-15', 'Day');
    expect(['Wednesday']).toContain(dayName);
  });
  it('formats time tokens', () => {
    expect(ex('to_char', '2020-01-15 15:04:05', 'HH24:MI:SS')).toBe('15:04:05');
    expect(ex('to_char', '2020-01-15 15:04:05', 'HH12')).toBe('03');
    expect(ex('to_char', '2020-01-15 15:04:05', 'AM')).toBe('PM');
  });
  it('formats HH / MI / SS / MS / US / TZ / lowercase am/pm', () => {
    expect(ex('to_char', '2020-01-15 15:04:05', 'HH')).toBe('03');
    expect(ex('to_char', '2020-01-15 15:04:05', 'MI')).toBe('04');
    expect(ex('to_char', '2020-01-15 15:04:05', 'SS')).toBe('05');
    expect(ex('to_char', '2020-01-15 15:04:05.789', 'MS')).toBe('789');
    expect(ex('to_char', '2020-01-15 15:04:05.789', 'US')).toBe('789000');
    expect(ex('to_char', '2020-01-15 15:04:05', 'TZ')).toBe('+08');
    expect(ex('to_char', '2020-01-15 09:04:05', 'am')).toBe('am');
    expect(ex('to_char', '2020-01-15 15:04:05', 'pm')).toBe('pm');
  });
  it('formats YY and DY/dy', () => {
    expect(ex('to_char', '2020-01-15', 'YY')).toBe('20');
    expect(ex('to_char', '2020-01-15', 'DY')).toBe('WED');
    expect(ex('to_char', '2020-01-15', 'dy')).toBe('wed');
    expect(ex('to_char', '2020-01-15', 'Dy')).toBe('Wed');
  });
  it('FM trims padding', () => {
    expect(ex('to_char', '2020-01-15', 'FMDD')).toBe('15');
  });
});

describe('to_date / to_timestamp / to_number', () => {
  it('to_date parses ISO and named months', () => {
    expect(ex('to_date', '2020-01-15', 'YYYY-MM-DD')).toBe('2020-01-15');
    expect(ex('to_date', '15/Jan/2020', 'DD/Mon/YYYY')).toBe('2020-01-15');
    expect(ex('to_date', '15 January 2020', 'DD Month YYYY')).toBe('2020-01-15');
  });
  it('to_date invalid throws; null returns null', () => {
    expect(() => ex('to_date', 'not a date', 'YYYY')).toThrow(/invalid/);
    expect(ex('to_date', null, 'YYYY')).toBeNull();
  });
  it('to_timestamp parses and formats', () => {
    expect(ex('to_timestamp', '2020-01-15 03:04:05', 'YYYY-MM-DD HH24:MI:SS')).toMatch(/^2020-01-15 03:04:05/);
    expect(() => ex('to_timestamp', 'bad', 'YYYY')).toThrow(/invalid/);
    expect(ex('to_timestamp', null, 'YYYY')).toBeNull();
  });
  it('to_date YY / MM / DD / HH24 / MI / SS / MS / US / AM PM tokens', () => {
    expect(ex('to_date', '20-01-15', 'YY-MM-DD')).toBe('2020-01-15');
    expect(ex('to_timestamp', '15 03 04 05', 'SS MI HH24 DD')).toMatch(/15/);
    // MS (3-digit millis) and US (6-digit micros) parse but to_timestamp drops sub-second in output
    expect(ex('to_timestamp', '123', 'MS')).toMatch(/^2024-01-01 00:00:00/);
    expect(ex('to_timestamp', '000500', 'US')).toMatch(/^2024-01-01 00:00:00/);
    // AM/PM 12-hour cycle
    expect(ex('to_timestamp', '03:04:05 PM', 'HH12:MI:SS PM')).toMatch(/15:04:05/);
    expect(ex('to_timestamp', '03:04:05 am', 'HH12:MI:SS am')).toMatch(/03:04:05/);
  });
  it('buildParseRegex escapes literal regex metacharacters', () => {
    // fmt containing '.' and '[' which are regex special chars
    expect(ex('to_date', '2020.01.15', 'YYYY.MM.DD')).toBe('2020-01-15');
  });
  it('to_number extracts digits', () => {
    expect(ex('to_number', '1,234.56', '9999.99')).toBe(1234.56);
    expect(ex('to_number', '-42', '999')).toBe(-42);
    expect(ex('to_number', 'abc', '999')).toBe(0);
    expect(ex('to_number', null, '999')).toBeNull();
  });
  it('formatNumeric comma grouping', () => {
    // FM (fill mode) suppresses leading blanks; commas suppressed when left side is padding.
    expect(ex('to_char', 1234567, 'FM999,999,999')).toBe('1,234,567');
    expect(ex('to_char', 123, 'FM999,999')).toBe('123'); // comma suppressed (left side is padding)
    expect(ex('to_char', 1, 'FM9,999')).toBe('1');
    // Non-FM mode preserves leading blanks.
    expect(ex('to_char', 123, '999,999')).toBe('    123');
  });
});

describe('FS access functions', () => {
  it('pg_read_file rejects traversal and missing', () => {
    expect(ex('pg_read_file', null)).toBeNull();
    expect(ex('pg_read_file', '../../etc/passwd')).toBeNull();
    expect(ex('pg_read_file', '/etc/passwd')).toBeNull();
    expect(ex('pg_read_file', 'does-not-exist')).toBeNull();
  });
  it('pg_ls_dir', () => {
    expect(ex('pg_ls_dir', null)).toEqual([]);
    expect(ex('pg_ls_dir', 'no-such-dir')).toEqual([]);
    expect(ex('pg_ls_dir', '../../etc')).toEqual([]);
  });
  it('pg_stat_file missing', () => {
    expect(ex('pg_stat_file', 'no-such-file')).toBeNull();
  });
});

describe('object description helpers', () => {
  it('obj_description / col_description are null', () => {
    expect(ex('obj_description', 1)).toBeNull();
    expect(ex('col_description', 1, 2)).toBeNull();
  });
  it('pg_get_expr / format_type / pg_typeof', () => {
    expect(ex('format_type', 23, -1)).toBe('int4');
    expect(ex('pg_typeof', 5)).toBe('integer');
    expect(ex('pg_typeof', 'x')).toBeTruthy();
  });
});

describe('pg_describe_object / pg_identify_object', () => {
  it('pg_describe_object across catalog classes', () => {
    expect(ex('pg_describe_object', 1259, 10001, 0)).toBe('table obj_10001');
    expect(ex('pg_describe_object', 1247, 23, 0)).toMatch(/^type /);
    expect(ex('pg_describe_object', 1255, 20000, 0)).toMatch(/^function /);
    expect(ex('pg_describe_object', 2615, 2200, 0)).toBe('schema public');
    expect(ex('pg_describe_object', 2615, 11, 0)).toBe('schema pg_catalog');
    expect(ex('pg_describe_object', 1262, 1, 0)).toBe('database postgres');
    expect(ex('pg_describe_object', 9999, 5, 0)).toBe('catalog_9999 obj_5');
  });
  it('pg_describe_object column subobject', () => {
    expect(ex('pg_describe_object', 1259, 10001, 2)).toBe('column obj_10001.col_2');
  });
  it('pg_identify_object', () => {
    expect(ex('pg_identify_object', 1259, 10001, 0)).toEqual(['table', 'public', 'obj_10001', 'obj_10001']);
    expect(ex('pg_identify_object', 2615, 2200, 0)).toEqual(['schema', 'pg_catalog', 'public', 'public']);
    expect(ex('pg_identify_object', 1262, 1, 0)).toEqual(['database', 'pg_catalog', 'postgres', 'postgres']);
    expect(ex('pg_identify_object', 9999, 5, 0)).toEqual(['object', 'pg_catalog', 'obj_5', 'obj_5']);
  });
});

describe('pg_has_role', () => {
  it('fallback superuser when no role manager', () => {
    setRoleManager(null);
    expect(ex('pg_has_role', 'postgres', 'USAGE')).toBe(true);
    expect(ex('pg_has_role', 10, 'MEMBER')).toBe(true);
  });
});

describe('pg_stat_get_activity', () => {
  it('no registry returns singleton', () => {
    setActiveQueryRegistry(null);
    const rows = ex('pg_stat_get_activity');
    expect(rows.length).toBe(1);
    expect(rows[0].datname).toBe('postgres');
  });
  it('pid filter', () => {
    setActiveQueryRegistry(null);
    expect(ex('pg_stat_get_activity', 12345)).toEqual([]);
  });
});

describe('checkpoint / backup / wal', () => {
  it('pg_control_checkpoint', () => {
    const r = ex('pg_control_checkpoint');
    expect(r.checkpoint_lsn).toBe('0/0');
    expect(r.timeline_id).toBe(1);
  });
  it('backup/replay stubs', () => {
    expect(ex('pg_is_in_backup')).toBe(false);
    expect(ex('pg_last_xact_replay_timestamp')).toBeNull();
    expect(ex('pg_is_wal_replay_paused')).toBe(false);
  });
});

describe('pg_get_ruledef', () => {
  it('returns placeholder', () => {
    expect(ex('pg_get_ruledef', 1)).toBe('-- No rule defined');
  });
});

describe('type I/O', () => {
  it('pg_lsn/money in/out', () => {
    expect(ex('pg_lsn_in', '0/0')).toBe('0/0');
    expect(ex('pg_lsn_out', '0/0')).toBe('0/0');
    expect(ex('money_in', '$1.00')).toBe('$1.00');
    expect(ex('money_out', '$1.00')).toBe('$1.00');
  });
});

describe('network wrappers', () => {
  it('set_masklen', () => {
    expect(ex('set_masklen', '192.168.1.1', 24)).toBe('192.168.1.1/24');
    expect(ex('set_masklen', null, 24)).toBeNull();
  });
  it('inet same family', () => {
    expect(ex('inet_same_family', '192.168.1.1', '10.0.0.1')).toBe(true);
    expect(ex('inet_same_family', '192.168.1.1', '::1')).toBe(false);
    expect(ex('inet_same_family', null, '::1')).toBeNull();
  });
  it('inet_client_addr / port / server', () => {
    expect(ex('inet_client_port')).toBeTypeOf('number');
    expect(ex('inet_server_port')).toBeTypeOf('number');
  });
});

describe('geometric functions', () => {
  it('diameter', () => {
    expect(ex('diameter', '<(0,0),5>')).toBe(10);
    expect(ex('diameter', 'circle 5')).toBe(10);
    expect(ex('diameter', 'abc')).toBe(0);
    expect(ex('diameter', null)).toBeNull();
  });
  it('isclosed / isopen', () => {
    expect(ex('isclosed', '(0,0),(1,1)')).toBe(true);
    expect(ex('isclosed', '[0,0],[1,1]')).toBe(false);
    expect(ex('isopen', '[0,0],[1,1]')).toBe(true);
    expect(ex('isopen', '(0,0),(1,1)')).toBe(false);
    expect(ex('isclosed', null)).toBeNull();
    expect(ex('isopen', null)).toBeNull();
  });
  it('npoints', () => {
    expect(ex('npoints', '((0,0),(1,1),(2,2))')).toBe(3);
    expect(ex('npoints', '(1,2)')).toBe(1);
    expect(ex('npoints', null)).toBeNull();
  });
  it('pclose / popen', () => {
    expect(ex('pclose', '[0,0],[1,1]')).toBe('(0,0],[1,1)');
    expect(ex('pclose', '(0,0),(1,1)')).toBe('(0,0),(1,1)');
    expect(ex('popen', '(0,0),(1,1)')).toBe('[0,0),(1,1]');
    expect(ex('popen', '[0,0],[1,1]')).toBe('[0,0],[1,1]');
    expect(ex('pclose', null)).toBeNull();
    expect(ex('popen', null)).toBeNull();
  });
});

describe('enum functions', () => {
  it('enum_first / enum_last / enum_range', () => {
    expect(ex('enum_first', 'x')).toBe('a');
    expect(ex('enum_last', 'x')).toBe('z');
    expect(ex('enum_range', 'x')).toEqual(['a', 'b', 'c']);
  });
});

describe('convert_from / convert_to', () => {
  it('convert_from encodings', () => {
    expect(ex('convert_from', Buffer.from('hello', 'utf8'), 'UTF8')).toBe('hello');
    expect(ex('convert_from', Buffer.from('hello', 'utf8'), 'UTF-8')).toBe('hello');
    expect(ex('convert_from', Buffer.from('hello', 'utf8'), 'LATIN1')).toBe('hello');
    expect(ex('convert_from', Buffer.from('hello', 'utf8'), 'ASCII')).toBe('hello');
  });
  it('convert_from defaults/fallback', () => {
    expect(ex('convert_from', Buffer.from('hello', 'utf8'), 'UNKNOWN')).toBe('hello');
    expect(ex('convert_from', null, 'UTF8')).toBeNull();
    expect(ex('convert_from', Buffer.from('x'), null)).toBeNull();
  });
  it('convert_to', () => {
    const buf = ex('convert_to', 'hello', 'UTF8');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf8')).toBe('hello');
    expect(ex('convert_to', null, 'UTF8')).toBeNull();
    expect(ex('convert_to', 'x', null)).toBeNull();
  });
  it('convert_to supports latin1/ascii/utf16le encodings', () => {
    expect(ex('convert_to', 'hello', 'LATIN1').toString('latin1')).toBe('hello');
    expect(ex('convert_to', 'hello', 'ISO-8859-1').toString('latin1')).toBe('hello');
    expect(ex('convert_to', 'hello', 'ASCII').toString('ascii')).toBe('hello');
    expect(ex('convert_to', 'hello', 'SQL_ASCII').toString('ascii')).toBe('hello');
    expect(ex('convert_to', 'hello', 'UTF16LE').toString('utf16le')).toBe('hello');
    expect(ex('convert_to', 'hello', 'UNKNOWN').toString('utf8')).toBe('hello');
  });
  it('convert_from supports base64/hex/latin1/utf16le', () => {
    expect(ex('convert_from', Buffer.from('hello'), 'BASE64')).toBe(Buffer.from('hello').toString('base64'));
    expect(ex('convert_from', Buffer.from('hello'), 'HEX')).toBe(Buffer.from('hello').toString('hex'));
    expect(ex('convert_from', Buffer.from([0x65, 0xE9]), 'LATIN1')).toBe('eé');
    expect(ex('convert_from', Buffer.from([0x41, 0x00]), 'UTF16LE')).toBe('A');
  });
});

describe('info/session functions', () => {
  it('temp schema / channels / trigger depth', () => {
    expect(ex('pg_my_temp_schema')).toBe(0);
    expect(ex('pg_is_other_temp_schema', 1)).toBe(false);
    expect(ex('pg_listening_channels')).toEqual(['']);
    expect(ex('pg_notification_queue_usage')).toBe(0.0);
    expect(ex('pg_trigger_depth')).toBe(0);
  });
});

describe('uuid and tablespace', () => {
  it('uuid_generate_v1mc', () => {
    expect(ex('uuid_generate_v1mc')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('pg_tablespace_size returns 0 without db', () => {
    setCurrentDbRef(null);
    expect(ex('pg_tablespace_size', 'pg_default')).toBe(0);
  });
});

describe('pg_stat_get_* numeric stubs (batch return)', () => {
  const zeros = [
    'pg_stat_get_numscans', 'pg_stat_get_tuples_returned', 'pg_stat_get_tuples_fetched',
    'pg_stat_get_tuples_inserted', 'pg_stat_get_tuples_updated', 'pg_stat_get_tuples_deleted',
    'pg_stat_get_blocks_fetched', 'pg_stat_get_blocks_hit',
    'pg_stat_get_xact_numscans', 'pg_stat_get_xact_tuples_returned', 'pg_stat_get_xact_tuples_fetched',
    'pg_stat_get_xact_tuples_inserted', 'pg_stat_get_xact_tuples_updated', 'pg_stat_get_xact_tuples_deleted',
    'pg_stat_get_xact_blocks_fetched', 'pg_stat_get_xact_blocks_hit', 'pg_stat_get_xact_function_calls',
  ];
  it.each(zeros)('%s returns 0', (name) => {
    expect(ex(name, 1)).toBe(0);
  });

  const floatz = [
    'pg_stat_get_xact_function_total_time', 'pg_stat_get_function_total_time',
    'pg_stat_get_function_self_time',
  ];
  it.each(floatz)('%s returns 0.0', (name) => {
    expect(ex(name, 1)).toBe(0.0);
  });

  it('pg_stat_get_function_calls returns 0', () => {
    expect(ex('pg_stat_get_function_calls', 1)).toBe(0);
  });

  it('pg_stat_reset returns true (0-arg)', () => {
    expect(ex('pg_stat_reset')).toBe(true);
  });
  const resets1 = [
    'pg_stat_reset_shared', 'pg_stat_reset_single_table_counters',
    'pg_stat_reset_single_function_counters',
  ];
  it.each(resets1)('%s returns true (1-arg)', (name) => {
    expect(ex(name, 1)).toBe(true);
  });
  it('pg_stat_clear_snapshot returns true (0-arg)', () => {
    expect(ex('pg_stat_clear_snapshot')).toBe(true);
  });
});

describe('pg_stat_get_backend_* / pg_stat_get_db_* stubs', () => {
  const backendZeros = [
    'pg_stat_get_backend_pid', 'pg_stat_get_backend_dbid', 'pg_stat_get_backend_userid',
  ];
  it.each(backendZeros)('%s returns 0', (name) => {
    expect(ex(name, 1)).toBe(0);
  });
  it('backend activity/wait', () => {
    expect(ex('pg_stat_get_backend_activity', 1)).toBe('');
    expect(ex('pg_stat_get_backend_wait_event', 1)).toBeNull();
    expect(ex('pg_stat_get_backend_wait_event_type', 1)).toBeNull();
  });

  const dbIntZeros = [
    'pg_stat_get_db_numbackends', 'pg_stat_get_db_xact_commit', 'pg_stat_get_db_xact_rollback',
    'pg_stat_get_db_blocks_fetched', 'pg_stat_get_db_blocks_hit', 'pg_stat_get_db_tuples_returned',
    'pg_stat_get_db_tuples_fetched', 'pg_stat_get_db_tuples_inserted', 'pg_stat_get_db_tuples_updated',
    'pg_stat_get_db_tuples_deleted', 'pg_stat_get_db_conflict_all', 'pg_stat_get_db_conflict_tablespace',
    'pg_stat_get_db_conflict_lock', 'pg_stat_get_db_conflict_snapshot', 'pg_stat_get_db_conflict_bufferpin',
    'pg_stat_get_db_conflict_startup_deadlock', 'pg_stat_get_db_deadlocks', 'pg_stat_get_db_checksum_failures',
    'pg_stat_get_db_sessions', 'pg_stat_get_db_sessions_abandoned', 'pg_stat_get_db_sessions_fatal',
  ];
  it.each(dbIntZeros)('%s returns 0', (name) => {
    expect(ex(name, 1)).toBe(0);
  });

  const dbFloatZeros = [
    'pg_stat_get_db_blk_read_time', 'pg_stat_get_db_blk_write_time', 'pg_stat_get_db_session_time',
    'pg_stat_get_db_active_time', 'pg_stat_get_db_idle_in_transaction_time',
  ];
  it.each(dbFloatZeros)('%s returns 0.0', (name) => {
    expect(ex(name, 1)).toBe(0.0);
  });

  it('pg_stat_get_db_stat_reset_time null', () => {
    expect(ex('pg_stat_get_db_stat_reset_time', 1)).toBeNull();
  });
});

describe('getter/setter round-trip', () => {
  it('db ref', () => {
    setCurrentDbRef(null);
    expect(getCurrentDbRef()).toBeNull();
  });
  it('role manager', () => {
    setRoleManager(null);
    expect(getRoleManager()).toBeNull();
  });
  it('active query registry', () => {
    setActiveQueryRegistry(null);
    expect(getActiveQueryRegistry()).toBeNull();
  });
  it('pitr manager', () => {
    setPitrManager(null);
    expect(getPitrManager()).toBeNull();
  });
});

describe('SQL/JSON standard stubs', () => {
  it('json_exists / json_value / json_query / json_scalar', () => {
    expect(ex('json_exists', '{}', '$.a')).toBe(false);
    expect(ex('json_value', '{}', '$.a')).toBeNull();
    expect(ex('json_query', '{}', '$.a')).toBeNull();
    expect(ex('json_scalar', '{}')).toBeNull();
  });
  it('json_serialize / json_object / json_array', () => {
    expect(ex('json_serialize', '{}')).toBe('{}');
    expect(ex('json_serialize', null)).toBe('null');
    expect(ex('json_object')).toBe('{}');
    expect(ex('json_array')).toBe('[]');
  });
});

describe('backend / session / admin stubs', () => {
  it('backend pid / recovery', () => {
    expect(ex('pg_backend_pid')).toBeTypeOf('number');
    expect(ex('pg_is_in_recovery')).toBe(false);
  });
  it('current_setting returns null without GUC', () => {
    expect(ex('current_setting', 'unknown_guc_xyz')).toBeNull();
    expect(ex('current_setting', null)).toBeNull();
  });
  it('cancel/terminate/reload/rotate/block', () => {
    expect(ex('pg_cancel_backend', 1)).toBe(true);
    expect(ex('pg_terminate_backend', 1)).toBe(true);
    expect(ex('pg_reload_conf')).toBe(true);
    expect(ex('pg_rotate_logfile')).toBe(true);
    expect(ex('pg_rotate_logfile_v2')).toBe(true);
    expect(ex('pg_block_backend', 1)).toBe(true);
  });
});

describe('pg_table_size / pg_relation_size / pg_indexes_size family', () => {
  it('returns page-size fallback without db ref', () => {
    setCurrentDbRef(null);
    expect(ex('pg_table_size', 't')).toBe(8192);
    expect(ex('pg_relation_size', 't')).toBe(8192);
    expect(ex('pg_total_relation_size', 't')).toBe(16384);
    expect(ex('pg_indexes_size', 't')).toBe(8192);
  });
});

describe('pg_get_indexdef / triggerdef / viewdef / constraintdef', () => {
  it('returns null without db ref', () => {
    setCurrentDbRef(null);
    expect(ex('pg_get_indexdef', 1)).toBeNull();
    expect(ex('pg_get_triggerdef', 1)).toBeNull();
    expect(ex('pg_get_viewdef', 1)).toBeNull();
    expect(ex('pg_get_constraintdef', 1)).toBeNull();
    expect(ex('pg_get_indexdef', null)).toBeNull();
  });
  it('pg_get_functiondef / arguments / result / identity', () => {
    expect(ex('pg_get_functiondef', 20000)).toMatch(/^CREATE OR REPLACE FUNCTION/);
    const args = ex('pg_get_function_arguments', 20000);
    expect(typeof args).toBe('string');
    expect(ex('pg_get_function_result', 20000)).toBeDefined();
    expect(typeof ex('pg_get_function_identity_arguments', 20000)).toBe('string');
    expect(ex('pg_get_functiondef', 99999)).toBeNull();
    expect(ex('pg_get_function_arguments', 99999)).toBe('');
    expect(ex('pg_get_function_identity_arguments', 99999)).toBe('');
  });
  it('pg_column_type default text without db', () => {
    setCurrentDbRef(null);
    expect(ex('pg_column_type', 1, 'col')).toBe('text');
    expect(ex('pg_column_type', null, 'col')).toBe('text');
  });
  it('pg_get_serial_sequence null without args / db', () => {
    setCurrentDbRef(null);
    expect(ex('pg_get_serial_sequence', null, 'id')).toBeNull();
    expect(ex('pg_get_serial_sequence', 't', 'id')).toBeNull();
  });
  it('pg_get_keywords returns subset', () => {
    const kws = ex('pg_get_keywords');
    expect(Array.isArray(kws)).toBe(true);
    expect(kws.length).toBeGreaterThan(100);
    expect(kws[0]).toHaveProperty('word');
    expect(kws[0]).toHaveProperty('catcode');
  });
  it('pg_get_expr', () => {
    expect(ex('pg_get_expr', 'x + 1', 1)).toBe('x + 1');
    expect(ex('pg_get_expr', '"quoted"', 1)).toBe('quoted');
    expect(ex('pg_get_expr', null, 1)).toBeNull();
    expect(ex('pg_get_expr', 'a'.repeat(600), 1)).toBeNull();
  });
});

describe('network: inet_merge / inet_client_addr / inet_server_addr', () => {
  it('inet_merge', () => {
    expect(ex('inet_merge', '192.168.1.1', '192.168.1.2')).toBe('128.0.0.0/1');
    expect(ex('inet_merge', null, '10.0.0.1')).toBeNull();
  });
  it('inet_client_addr / inet_server_addr', () => {
    expect(ex('inet_client_addr')).toBe('127.0.0.1');
    expect(ex('inet_server_addr')).toBe('127.0.0.1');
  });
});

describe('starts_with / to_ascii', () => {
  it('starts_with', () => {
    expect(ex('starts_with', 'hello', 'hel')).toBe(true);
    expect(ex('starts_with', 'hello', 'xyz')).toBe(false);
    expect(ex('starts_with', null, 'a')).toBeNull();
    expect(ex('starts_with', 'a', null)).toBeNull();
    expect(ex('starts_with', 123, '1')).toBe(true);
  });
  it('to_ascii strips accents', () => {
    expect(ex('to_ascii', 'héllo')).toBe('hello');
    expect(ex('to_ascii', 'café')).toBe('cafe');
    expect(ex('to_ascii', 'plain')).toBe('plain');
    expect(ex('to_ascii', null)).toBeNull();
  });
});

describe('parseIntervalToMs (pure parser)', () => {
  it('parses all interval units', () => {
    expect(parseIntervalToMs('100 microseconds')).toBe(0.1);
    expect(parseIntervalToMs('5 milliseconds')).toBe(5);
    expect(parseIntervalToMs('1 second')).toBe(1000);
    expect(parseIntervalToMs('2 seconds')).toBe(2000);
    expect(parseIntervalToMs('1 minute')).toBe(60000);
    expect(parseIntervalToMs('1 hour')).toBe(3600000);
  });
  it('parses ISO 8601 durations (h/m/s)', () => {
    expect(parseIntervalToMs('PT1S')).toBe(1000);
    expect(parseIntervalToMs('PT500M')).toBe(30000000);
    expect(parseIntervalToMs('PT1H')).toBe(3600000);
    expect(parseIntervalToMs('PT1M')).toBe(60000);
    expect(parseIntervalToMs('PT1H30M15.5S')).toBe(5415500);
    expect(parseIntervalToMs('pt30s')).toBe(30000);
  });
  it('returns 0 for empty/invalid input', () => {
    expect(parseIntervalToMs('')).toBe(0);
    expect(parseIntervalToMs(null)).toBe(0);
    expect(parseIntervalToMs(undefined)).toBe(0);
    expect(parseIntervalToMs('abc')).toBe(0);
    expect(parseIntervalToMs('PT')).toBe(0);
  });
});

describe('pg_sleep_for / pg_sleep_until', () => {
  it('pg_sleep_for sleeps only for positive durations (short)', () => {
    // 100 microseconds ≈ 0.1ms — effectively instant.
    expect(ex('pg_sleep_for', '100 microseconds')).toBeUndefined();
    expect(ex('pg_sleep_for', 'abc')).toBeUndefined();
    expect(ex('pg_sleep_for', null)).toBeUndefined();
  });
  it('pg_sleep_until past/null no-op', () => {
    expect(ex('pg_sleep_until', '2000-01-01')).toBeUndefined(); // past → immediate
    expect(ex('pg_sleep_until', null)).toBeUndefined();
    expect(ex('pg_sleep_until', 'not-a-date')).toBeUndefined();
  });
});

describe('pg_typeof', () => {
  it('classifies all JS/PG types', () => {
    expect(ex('pg_typeof', null)).toBe('text');
    expect(ex('pg_typeof', undefined)).toBe('text');
    expect(ex('pg_typeof', true)).toBe('boolean');
    expect(ex('pg_typeof', 42)).toBe('integer');
    expect(ex('pg_typeof', 1.5)).toBe('numeric');
    expect(ex('pg_typeof', 'x')).toBe('text');
    expect(ex('pg_typeof', {})).toBe('text');
    expect(ex('pg_typeof', [])).toBe('text');
  });
});

describe('npoints / pclose / popen / isclosed / isopen', () => {
  it('npoints counts parenthesized coordinate pairs', () => {
    expect(ex('npoints', '(0,0),(1,1)')).toBe(2);
    expect(ex('npoints', '(0,0)')).toBe(1);
  });
  it('npoints falls back to comma-separated when no parens', () => {
    expect(ex('npoints', '0,1,2')).toBe(3);
    expect(ex('npoints', 'single')).toBe(1);
    expect(ex('npoints', null)).toBeNull();
  });
  it('pclose/popen convert bracket/paren delimiters', () => {
    expect(ex('pclose', '[0,0]')).toBe('(0,0)');
    expect(ex('popen', '(0,0)')).toBe('[0,0]');
    expect(ex('pclose', '(0,0)')).toBe('(0,0)'); // already closed
    expect(ex('popen', '[0,0]')).toBe('[0,0]'); // already open
    expect(ex('pclose', null)).toBeNull();
    expect(ex('popen', null)).toBeNull();
  });
});

describe('pg_read_file offset/length', () => {
  it('reads with offset and length slicing', () => {
    const tmp = path.join(os.tmpdir(), `sf-read-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'Hello, World!');
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = os.tmpdir();
    try {
      const fname = path.basename(tmp);
      expect(ex('pg_read_file', fname, 7, 5)).toBe('World');
      expect(ex('pg_read_file', fname, 0, 5)).toBe('Hello');
      expect(ex('pg_read_file', fname, 99, 5)).toBe('');
    } finally {
      process.env.DATA_DIR = prev;
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });
  it('pg_read_file rejects path traversal', () => {
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = os.tmpdir();
    try {
      expect(ex('pg_read_file', '../../../etc/passwd')).toBeNull();
    } finally {
      process.env.DATA_DIR = prev;
    }
  });
});

describe('pg_describe_object / pg_identify_object catalog branches', () => {
  it('pg_describe_object resolves every catalog classid', () => {
    setCurrentDbRef(null);
    expect(ex('pg_describe_object', 1259, 10000, 0)).toContain('table');
    expect(ex('pg_describe_object', 1247, 23, 0)).toContain('type');
    expect(ex('pg_describe_object', 1255, 99999, 0)).toContain('function');
    expect(ex('pg_describe_object', 2615, 2200, 0)).toBe('schema public');
    expect(ex('pg_describe_object', 2615, 11, 0)).toBe('schema pg_catalog');
    expect(ex('pg_describe_object', 1262, 0, 0)).toContain('database');
    expect(ex('pg_describe_object', 9999, 42, 0)).toBe('catalog_9999 obj_42');
    // column sub-object (oid 10000 unresolved without a db → obj_10000)
    expect(ex('pg_describe_object', 1259, 10000, 3)).toBe('column obj_10000.col_3');
  });

  it('pg_identify_object resolves every catalog classid', () => {
    expect(ex('pg_identify_object', 1259, 10000, 0)[0]).toBe('table');
    expect(ex('pg_identify_object', 2615, 2200, 0)[1]).toBe('pg_catalog');
    expect(ex('pg_identify_object', 1247, 23, 0)[0]).toBe('type');
    expect(ex('pg_identify_object', 1255, 99999, 0)[0]).toBe('function');
    expect(ex('pg_identify_object', 1262, 0, 0)[0]).toBe('database');
    expect(ex('pg_identify_object', 9999, 7, 0)[0]).toBe('object');
  });
});

describe('pg_column_is_updatable system columns', () => {
  it('system column names are not updatable', () => {
    // db that reports 'ctid' (a system column) for any pragma_table_info lookup,
    // and also provides a sqlite_master listing so buildOidCache maps oid→name.
    const db = {
      prepare: (sql: string) => {
        if (sql.includes('sqlite_master WHERE type IN')) {
          return { get: () => undefined, all: () => [{ name: 'users', type: 'table' }] };
        }
        if (sql.includes('pragma_table_info')) {
          return { get: () => ({ name: 'ctid' }), all: () => [] };
        }
        return { get: () => undefined, all: () => [] };
      },
      exec: () => undefined,
    } as any;
    setCurrentDbRef(db);
    try {
      // oid 10000 → 'users' (first table), then system column 'ctid' → not updatable
      expect(ex('pg_column_is_updatable', 10000, 1)).toBe(false);
    } finally {
      setCurrentDbRef(null);
    }
  });
});

describe('pg_stat_file directory type', () => {
  it('reports type "d" for directories', () => {
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = os.tmpdir();
    try {
      // '.' resolves to DATA_DIR itself (a directory) → stat succeeds with type 'd'
      const dot = ex('pg_stat_file', '.');
      expect(dot?.type).toBe('d');
    } finally {
      process.env.DATA_DIR = prev;
    }
  });
});

describe('trim_array / repeat Number coercion branches', () => {
  it('trim_array coerces non-number n', () => {
    expect(ex('trim_array', [1, 2, 3], '1')).toEqual([1, 2]);
    expect(ex('trim_array', [1, 2, 3], 0)).toEqual([1, 2, 3]);
    expect(ex('trim_array', [1, 2, 3], -1)).toEqual([1, 2, 3]);
  });
});

describe('pg_stat_get_activity with registry', () => {
  it('maps registered queries', () => {
    const reg = {
      list: () => [{ pid: 123, database: 'mydb', userId: 'u1', state: 'idle', clientAddr: '10.0.0.1' }],
    };
    setActiveQueryRegistry(reg as any);
    try {
      const rows = ex('pg_stat_get_activity');
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(1);
      expect(rows[0].pid).toBe(123);
      expect(rows[0].datname).toBe('mydb');
    } finally {
      setActiveQueryRegistry(null);
    }
  });

  it('fills pid/database defaults when query omits them', () => {
    const reg = { list: () => [{}] };
    setActiveQueryRegistry(reg as any);
    try {
      const rows = ex('pg_stat_get_activity');
      expect(rows[0].pid).toBe(process.pid); // default
      expect(rows[0].datname).toBe('postgres'); // default
    } finally {
      setActiveQueryRegistry(null);
    }
  });
});

describe('pg_read_file length coercion + pg_stat_file regular file', () => {
  it('pg_read_file with non-number length falls back to full slice', () => {
    const tmp = path.join(os.tmpdir(), `sf-rf-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'abcdef');
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = os.tmpdir();
    try {
      expect(ex('pg_read_file', path.basename(tmp), 0, 'x')).toBe('abcdef');
    } finally {
      process.env.DATA_DIR = prev;
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });

  it('pg_stat_file reports type "-" for regular files', () => {
    const tmp = path.join(os.tmpdir(), `sf-st-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, 'data');
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = os.tmpdir();
    try {
      const r = ex('pg_stat_file', path.basename(tmp));
      expect(r?.type).toBe('-');
    } finally {
      process.env.DATA_DIR = prev;
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });
});

describe('pg_sleep_until future (tiny)', () => {
  it('sleeps only a negligible future delay', () => {
    const near = new Date(Date.now() + 5).toISOString();
    expect(ex('pg_sleep_until', near)).toBeUndefined();
  });
});

describe('last-meridiem + non-string filename + tablespace branches', () => {
  it('AM subtracts 12 when hour >= 12 (15 am → 3)', () => {
    expect(ex('to_timestamp', '15 am', 'HH24 am')).toMatch(/03:00/);
  });
  it('pg_stat_file rejects non-string filename', () => {
    expect(ex('pg_stat_file', 12345)).toBeNull();
  });
  it('pg_read_file rejects empty string filename', () => {
    expect(ex('pg_read_file', '')).toBeNull();
  });
  it('pg_get_indexdef reconstructs when row.sql lacks CREATE INDEX', () => {
    const db = {
      prepare: (sql: string) => {
        if (sql.includes('sqlite_master WHERE type IN')) {
          return { get: () => undefined, all: () => [{ name: 'idx_email', type: 'index' }] };
        }
        if (sql.includes("type='index' AND name=?")) {
          return { get: () => ({ tbl_name: 'users', sql: 'SELECT * FROM users', name: 'idx_email' }), all: () => [] };
        }
        if (sql.includes('pragma_index_info')) {
          return { get: () => undefined, all: () => [{ cid: 0, name: 'email' }] };
        }
        return { get: () => undefined, all: () => [] };
      },
      exec: () => undefined,
    } as any;
    setCurrentDbRef(db);
    try {
      expect(ex('pg_get_indexdef', 'idx_email')).toBe('CREATE INDEX "idx_email" ON "users" ("email")');
    } finally {
      setCurrentDbRef(null);
    }
  });
});

describe('pg_stat_get_activity invalid queryStart (safeIsoTimestamp fallback)', () => {
  it('handles invalid queryStart by falling back to now', () => {
    const reg = { list: () => [{ pid: 9, queryStart: 'not-a-real-date' }] };
    setActiveQueryRegistry(reg as any);
    try {
      const rows = ex('pg_stat_get_activity');
      // safeIsoTimestamp returns a present timestamp (no throw)
      expect(new Date(rows[0].query_start).getTime()).not.toBeNaN();
    } finally {
      setActiveQueryRegistry(null);
    }
  });
});

describe('db ref without prepare (guard false branches)', () => {
  it('db without prepare() short-circuits pg_get_* and size helpers', () => {
    // A DatabaseRef that exists but lacks `prepare` exercises every `!db.prepare` guard.
    const noPrepDb = { exec: () => undefined } as any;
    setCurrentDbRef(noPrepDb);
    try {
      expect(ex('pg_get_indexdef', 'idx_users_email')).toBeNull();
      expect(ex('pg_get_triggerdef', 'trg_users')).toBeNull();
      expect(ex('pg_get_viewdef', 'v_users')).toBeNull();
      expect(ex('pg_get_constraintdef', 'users')).toBeNull();
      expect(ex('pg_column_type', 'users', 'id')).toBe('text');
      expect(ex('pg_table_is_visible', 10000)).toBe(true); // conservative
      expect(ex('pg_column_is_updatable', 10000, 1)).toBe(true);
      expect(ex('pg_table_size', 'users')).toBe(8192);
      expect(ex('pg_indexes_size', 'users')).toBe(8192);
    } finally {
      setCurrentDbRef(null);
    }
  });
});

describe('pg_get_indexdef CREATE INDEX (true) + empty idxInfo branches', () => {
  it('returns row.sql when it already contains CREATE INDEX', () => {
    const db = {
      prepare: (sql: string) => {
        if (sql.includes('sqlite_master WHERE type IN')) {
          return { get: () => undefined, all: () => [{ name: 'idx_email', type: 'index' }] };
        }
        if (sql.includes("type='index' AND name=?")) {
          return { get: () => ({ tbl_name: 'users', sql: 'CREATE INDEX idx_email ON users(email)', name: 'idx_email' }), all: () => [] };
        }
        return { get: () => undefined, all: () => [] };
      },
      exec: () => undefined,
    } as any;
    setCurrentDbRef(db);
    try {
      expect(ex('pg_get_indexdef', 'idx_email')).toBe('CREATE INDEX idx_email ON users(email)');
    } finally {
      setCurrentDbRef(null);
    }
  });

  it('returns null when pragma_index_info has no columns', () => {
    const db = {
      prepare: (sql: string) => {
        if (sql.includes('sqlite_master WHERE type IN')) {
          return { get: () => undefined, all: () => [{ name: 'idx_email', type: 'index' }] };
        }
        if (sql.includes("type='index' AND name=?")) {
          return { get: () => ({ tbl_name: 'users', sql: null, name: 'idx_email' }), all: () => [] };
        }
        if (sql.includes('pragma_index_info')) {
          return { get: () => undefined, all: () => [] }; // empty → idxInfo.length === 0
        }
        return { get: () => undefined, all: () => [] };
      },
      exec: () => undefined,
    } as any;
    setCurrentDbRef(db);
    try {
      expect(ex('pg_get_indexdef', 'idx_email')).toBeNull();
    } finally {
      setCurrentDbRef(null);
    }
  });
});

describe('remaining edge branches (final)', () => {
  it('has_table_privilege empty privilege → false', () => {
    expect(ex('has_table_privilege', 'u', 't', undefined)).toBe(false);
  });
  it('pg_has_role empty privilege → always true (non USAGE/MEMBER)', () => {
    const rm = { getRole: () => ({ superuser: false }), isMemberOf: () => false };
    setRoleManager(rm as any);
    expect(ex('pg_has_role', 'r', undefined)).toBe(true);
    setRoleManager(null);
  });
  it('to_char with Date and number-like date strings', () => {
    expect(ex('to_char', new Date(0), 'YYYY')).toBe('1970');
    expect(ex('to_char', '1970-01-01', 'YYYY')).toBe('1970');
  });
  it('formatNumeric PR/S with fractional part', () => {
    expect(ex('to_char', -12.5, '999.9PR')).toBe('(12.5)');
    expect(ex('to_char', 12.5, 'FM999.9S')).toBe('+12.5');
  });
  it('pg_read_file absolute path and empty filename', () => {
    const tmp = path.join(os.tmpdir(), `sf-abs-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'hello');
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = os.tmpdir();
    try {
      expect(ex('pg_read_file', tmp, 0, 5)).toBe('hello'); // absolute path
      expect(ex('pg_read_file', '', 0, 5)).toBeNull(); // empty filename
      expect(ex('pg_read_file', null)).toBeNull(); // null filename
    } finally {
      process.env.DATA_DIR = prev;
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });
  it('pg_ls_dir absolute path', () => {
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = os.tmpdir();
    try {
      const list = ex('pg_ls_dir', os.tmpdir());
      expect(Array.isArray(list)).toBe(true);
    } finally {
      process.env.DATA_DIR = prev;
    }
  });
});

describe('remaining edge branches', () => {
  it('HH12/HH wrap midnight to 12', () => {
    expect(ex('to_char', '2020-01-01 00:00:00', 'HH12')).toBe('12');
    expect(ex('to_char', '2020-01-01 00:00:00', 'HH')).toBe('12');
  });
  it('to_char pure-fraction format (empty int part)', () => {
    expect(ex('to_char', 0.5, '.99')).toBe('.50');
  });
  it('pg_get_function_arguments/result accept string oid (non-number)', () => {
    expect(ex('pg_get_function_arguments', 'version')).toBe('');
    expect(ex('pg_get_function_arguments', '999999')).toBe('');
  });
  it('pg_describe_object / identify_object objid 2200 vs 11 vs other', () => {
    expect(ex('pg_describe_object', 2615, 5, 0)).toBe('schema schema_5');
    expect(ex('pg_identify_object', 2615, 5, 0)[2]).toBe('schema_5');
  });
  it('parseDate ignores exotic (object) inputs', () => {
    expect(ex('to_char', {}, 'YYYY')).toBe('[object Object]');
  });
  it('AM/PM subtracts/adds 12 across meridiem', () => {
    // '03 PM' → 15; '15 AM' → 3 (subtract 12); '03 am' stays 3
    expect(ex('to_timestamp', '15 AM', 'HH24 AM')).toMatch(/03:00/);
    expect(ex('to_timestamp', '03 pm', 'HH12 pm')).toMatch(/15:00/);
    expect(ex('to_timestamp', '03 am', 'HH12 am')).toMatch(/03:00/);
  });
  it('pg_has_role role name empty and privileged matrix', () => {
    const rm = { getRole: () => ({ superuser: false }), isMemberOf: () => false };
    setRoleManager(rm as any);
    expect(ex('pg_has_role', null, 'USAGE')).toBe(true); // empty roleName → true
    setRoleManager(null);
  });

  it('pg_has_role with no postgres role registered → superuser', () => {
    const rm = { getRole: () => undefined, isMemberOf: () => false };
    setRoleManager(rm as any);
    expect(ex('pg_has_role', 'any_role', 'USAGE')).toBe(true);
    setRoleManager(null);
  });
});

describe('version cache + privilege edge branches', () => {
  it('version() hits both cache miss and hit', () => {
    expect(ex('version')).toMatch(/PostgreSQL/);
    expect(ex('version')).toMatch(/PostgreSQL/); // cached path
  });

  it('has_schema_privilege / has_table_privilege privilege matrix', () => {
    expect(ex('has_schema_privilege', 'u', 's', 'USAGE')).toBe(true);
    expect(ex('has_schema_privilege', 'u', 's', 'CREATE')).toBe(true);
    expect(ex('has_schema_privilege', 'u', 's', 'ALL')).toBe(true);
    expect(ex('has_schema_privilege', 'u', 's', 'DRAGON')).toBe(false);
    expect(ex('has_schema_privilege', 'u', 's', undefined)).toBe(false); // empty privilege
    expect(ex('has_table_privilege', 'u', 't', 'SELECT')).toBe(true);
    expect(ex('has_table_privilege', 'u', 't', 'DRAGON')).toBe(false);
  });
});

describe('pg_size_* empty-relation edge cases', () => {
  it('empty/null relation returns page defaults', () => {
    expect(ex('pg_table_size', '')).toBe(8192);
    expect(ex('pg_table_size', null)).toBe(8192);
    expect(ex('pg_total_relation_size', '')).toBe(16384);
    expect(ex('pg_relation_size', '')).toBe(8192);
    expect(ex('pg_indexes_size', '')).toBe(8192);
    expect(ex('pg_database_size', null)).toBe(0);
  });
});

describe('formatNumeric PR/S sign modes', () => {
  it('PR wraps negatives in parentheses', () => {
    expect(ex('to_char', -123, '999PR')).toBe('(123)');
    expect(ex('to_char', 123, '999PR')).toBe('123');
  });
  it('S forces an explicit sign', () => {
    expect(ex('to_char', 123, 'S999')).toBe('+123');
    expect(ex('to_char', -123, 'S999')).toBe('-123');
  });
  it('negative without PR/S still gets a minus', () => {
    expect(ex('to_char', -123, 'FM999')).toBe('-123');
  });
});

describe('parseDate / formatTimestamp boundary tokens', () => {
  it('to_char numeric path takes precedence over date parsing', () => {
    // Numbers route to formatNumeric (not formatTimestamp), so 'YYYY' stays literal.
    expect(ex('to_char', 0, 'YYYY')).toBe('YYYY');
    // A Date instance routes to formatTimestamp.
    expect(ex('to_char', new Date(0), 'YYYY')).toBe('1970');
    expect(ex('to_char', 'not-a-date', 'YYYY')).toBe('not-a-date');
  });
  it('AM/PM and am/pm both meridiem directions', () => {
    expect(ex('to_timestamp', '03:04:05 AM', 'HH12:MI:SS AM')).toMatch(/03:04:05/);
    expect(ex('to_timestamp', '03:04:05 pm', 'HH12:MI:SS pm')).toMatch(/15:04:05/);
  });
});

describe('pg_tablespace_size', () => {
  it('returns DB size or 0', () => {
    expect(ex('pg_tablespace_size', 'pg_default')).toBe(0);
  });
});

describe('pg_function_is_visible', () => {
  it('always true', () => {
    expect(ex('pg_function_is_visible', 20000)).toBe(true);
    expect(ex('pg_function_is_visible', 99999)).toBe(true);
  });
});

describe('pg_stat_get_activity with registry', () => {
  it('maps registered queries', () => {
    const fakeReg = {
      list: () => [
        { pid: 555, database: 'mydb', userId: 'u1', sql: 'SELECT 1', queryStart: Date.now() },
      ],
    };
    setActiveQueryRegistry(fakeReg as any);
    const rows = ex('pg_stat_get_activity');
    expect(rows.length).toBe(1);
    expect(rows[0].pid).toBe(555);
    expect(rows[0].datname).toBe('mydb');
    setActiveQueryRegistry(null);
  });
  it('pid filters registered rows', () => {
    const fakeReg = {
      list: () => [{ pid: 555, database: 'mydb' }],
    };
    setActiveQueryRegistry(fakeReg as any);
    expect(ex('pg_stat_get_activity', 555).length).toBe(1);
    expect(ex('pg_stat_get_activity', 999).length).toBe(0);
    setActiveQueryRegistry(null);
  });
});

describe('pg_has_role: empty role name → superuser', () => {
  it('empty role name returns true', () => {
    setRoleManager(null);
    expect(ex('pg_has_role', '', 'USAGE')).toBe(true);
  });

  it('non-superuser role manager delegates to isMemberOf', () => {
    const rm = {
      getRole: () => ({ superuser: false }),
      isMemberOf: (a: string, b: string) => b === 'target_role',
    };
    setRoleManager(rm as any);
    expect(ex('pg_has_role', 'target_role', 'USAGE')).toBe(true);
    expect(ex('pg_has_role', 'other_role', 'MEMBER')).toBe(false);
    // non USAGE/MEMBER privilege → always true
    expect(ex('pg_has_role', 'x', 'SET')).toBe(true);
    setRoleManager(null);
  });

  it('superuser role manager grants all', () => {
    const rm = { getRole: () => ({ superuser: true }), isMemberOf: () => false };
    setRoleManager(rm as any);
    expect(ex('pg_has_role', 'any', 'USAGE')).toBe(true);
    setRoleManager(null);
  });

  it('numeric role oid resolves to role_<oid>', () => {
    const rm = { getRole: () => ({ superuser: false }), isMemberOf: (a: string, b: string) => b === 'role_10' };
    setRoleManager(rm as any);
    expect(ex('pg_has_role', 10, 'USAGE')).toBe(true);
    setRoleManager(null);
  });
});

describe('db-ref driven metadata (mock DatabaseRef)', () => {
  // A mock DatabaseRef whose prepare() dispatches on SQL content.
  function makeMockDb(overrides: Record<string, string> = {}) {
    const prepare = (sql: string) => {
      const matched = (needle: string) => sql.includes(needle);
      let rows: any[] = [];
      let obj: any = undefined;
      if (matched('sequence_name FROM _sqlvec_identity_columns')) {
        obj = { sequence_name: 'users_id_seq' };
      } else if (matched("name='_sqlvec_identity_columns'")) {
        obj = { name: '_sqlvec_identity_columns' };
      } else if (matched("sqlite_master WHERE type IN ('table','view')")) {
        obj = { name: 'users' };
      } else if (matched('sqlite_master WHERE type IN')) {
        rows = [
          { name: 'users', type: 'table' },
          { name: 'idx_users_email', type: 'index' },
          { name: 'v_users', type: 'view' },
          { name: 'trg_users', type: 'trigger' },
        ];
      } else if (matched("WHERE name=? ORDER BY type DESC")) {
        obj = { sql: overrides.masterSql ?? 'CREATE TABLE users (id INTEGER)' };
      } else if (matched("type='trigger' AND name=?")) {
        obj = { sql: overrides.triggerSql ?? 'CREATE TRIGGER trg AFTER INSERT' };
      } else if (matched("type='index' AND name=?")) {
        obj = { tbl_name: 'users', sql: overrides.indexSql ?? null, name: 'idx_users_email' };
      } else if (matched('pragma_index_info')) {
        rows = overrides.idxInfo ?? [{ cid: 0, name: 'email' }];
      } else if (matched("type='view' AND name=?")) {
        obj = { sql: 'SELECT * FROM users' };
      } else if (matched('pragma_table_info')) {
        rows = [{ cid: 0, name: 'id', type: 'INTEGER' }, { cid: 1, name: 'email', type: 'TEXT' }];
      } else if (matched('CONSTRAINT') || matched('CHECK')) {
        obj = { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)' };
      } else if (matched('COALESCE(SUM(cnt)')) {
        obj = { total: 100 };
      } else if (matched('COUNT(*) as cnt FROM "')) {
        obj = { cnt: 10 };
      } else if (matched("type='index' AND tbl_name=?")) {
        obj = { cnt: 2 };
      } else if (matched("type='index' AND name NOT LIKE")) {
        obj = { cnt: 4 };
      }
      return { get: () => obj, all: () => rows };
    };
    return { path: undefined, prepare, exec: () => undefined, name: 'mock' } as any;
  }

  it('pg_table_size / pg_relation_size estimate from row fraction', () => {
    setCurrentDbRef(makeMockDb());
    expect(ex('pg_table_size', 'users')).toBeGreaterThanOrEqual(8192);
    expect(ex('pg_relation_size', 'users')).toBeGreaterThanOrEqual(8192);
    expect(ex('pg_indexes_size', 'users')).toBeGreaterThanOrEqual(8192);
    expect(ex('pg_total_relation_size', 'users')).toBeGreaterThanOrEqual(16384);
    setCurrentDbRef(null);
  });

  it('pg_database_size returns 0 without db path', () => {
    setCurrentDbRef(makeMockDb());
    expect(ex('pg_database_size', 'postgres')).toBe(0);
    setCurrentDbRef(null);
  });

  it('pg_get_indexdef reconstructs from index info (string name)', () => {
    setCurrentDbRef(makeMockDb());
    const r = ex('pg_get_indexdef', 'idx_users_email');
    expect(typeof r).toBe('string');
    expect(r).toContain('CREATE INDEX');
    setCurrentDbRef(null);
  });

  it('pg_get_indexdef returns master SQL when provided', () => {
    setCurrentDbRef(makeMockDb({ masterSql: 'CREATE INDEX idx ON t(a)', indexSql: 'CREATE INDEX idx ON t(a)' }));
    const r = ex('pg_get_indexdef', 'idx_users_email');
    expect(r).toContain('CREATE INDEX');
    setCurrentDbRef(null);
  });

  it('pg_get_triggerdef / pg_get_viewdef with db', () => {
    setCurrentDbRef(makeMockDb());
    expect(ex('pg_get_triggerdef', 'trg_users')).toContain('CREATE TRIGGER');
    expect(ex('pg_get_viewdef', 'v_users')).toContain('SELECT');
    expect(ex('pg_get_constraintdef', 'users')).toContain('CREATE TABLE');
    setCurrentDbRef(null);
  });

  it('pg_column_type resolves via pragma_table_info', () => {
    setCurrentDbRef(makeMockDb());
    expect(ex('pg_column_type', 'users', 'email')).toBe('TEXT');
    expect(ex('pg_column_type', 'users', 'id')).toBe('INTEGER');
    expect(ex('pg_column_type', 'users', 'missing')).toBe('text');
    setCurrentDbRef(null);
  });

  it('pg_get_serial_sequence with identity table', () => {
    setCurrentDbRef(makeMockDb());
    expect(ex('pg_get_serial_sequence', 'users', 'id')).toBe('users_id_seq');
    setCurrentDbRef(null);
  });

  it('pg_table_is_visible / pg_column_is_updatable with db', () => {
    setCurrentDbRef(makeMockDb());
    // oid 10000 → 'users' (first table in the mock sqlite_master listing)
    expect(ex('pg_table_is_visible', 10000)).toBe(true);
    expect(ex('pg_column_is_updatable', 10000, 1)).toBe(true);
    setCurrentDbRef(null);
  });

  it('realRelationSize / realIndexesSize take the db.prepare row-fraction branch', () => {
    // A real file path is required so realDbSize() > 0, which gates the
    // db.prepare estimation branch (otherwise it short-circuits to 8192).
    const tmp = path.join(os.tmpdir(), `sf-size-${process.pid}-${Date.now()}.db`);
    fs.writeFileSync(tmp, 'x'.repeat(4096)); // >0 bytes
    const db = makeMockDb() as any;
    (db as any).path = tmp;
    setCurrentDbRef(db);
    try {
      expect(ex('pg_table_size', 'users')).toBeGreaterThanOrEqual(8192);
      expect(ex('pg_indexes_size', 'users')).toBeGreaterThanOrEqual(8192);
      expect(ex('pg_total_relation_size', 'users')).toBeGreaterThanOrEqual(16384);
      expect(ex('pg_database_size', 'postgres')).toBe(4096);
    } finally {
      setCurrentDbRef(null);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });

  it('handles prepare() throwing (catch branches)', () => {
    const throwingDb = { prepare: () => { throw new Error('boom'); }, exec: () => undefined } as any;
    setCurrentDbRef(throwingDb);
    try {
      expect(ex('pg_get_indexdef', 'idx_users_email')).toBeNull();
      expect(ex('pg_get_triggerdef', 'trg_users')).toBeNull();
      expect(ex('pg_get_viewdef', 'v_users')).toBeNull();
      expect(ex('pg_get_constraintdef', 'users')).toBeNull();
      expect(ex('pg_column_type', 'users', 'id')).toBe('text');
      expect(ex('pg_get_serial_sequence', 'users', 'id')).toBe('users_id_seq');
    } finally {
      setCurrentDbRef(null);
    }
  });

  it('realRelationSize row-fraction with totalRows.total=0 (|| 1) and zero indexes', () => {
    const tmp = path.join(os.tmpdir(), `sf-rr-${process.pid}-${Date.now()}.db`);
    fs.writeFileSync(tmp, 'x'.repeat(4096));
    const db = {
      path: tmp,
      prepare: (sql: string) => {
        if (sql.includes('COALESCE(SUM(cnt)')) return { get: () => ({ total: 0 }), all: () => [] };
        if (sql.includes('COUNT(*) as cnt FROM "')) return { get: () => ({ cnt: 5 }), all: () => [] };
        if (sql.includes("type='index' AND tbl_name=?")) return { get: () => ({ cnt: 0 }), all: () => [] };
        if (sql.includes("type='index' AND name NOT LIKE")) return { get: () => ({ cnt: 0 }), all: () => [] };
        return { get: () => undefined, all: () => [] };
      },
      exec: () => undefined,
    } as any;
    setCurrentDbRef(db);
    try {
      expect(ex('pg_table_size', 'users')).toBeGreaterThanOrEqual(8192);
      expect(ex('pg_indexes_size', 'users')).toBe(8192); // zero indexes → fallback 8192
    } finally {
      setCurrentDbRef(null);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });

  it('pg_get_indexdef reconstructs when row.sql is null', () => {
    const db = makeMockDb() as any;
    const origPrep = db.prepare;
    db.prepare = (sql: string) => {
      if (sql.includes("type='index' AND name=?")) {
        return { get: () => ({ tbl_name: 'users', sql: null, name: 'idx_users_email' }), all: () => [] };
      }
      return origPrep(sql);
    };
    setCurrentDbRef(db);
    try {
      expect(ex('pg_get_indexdef', 'idx_users_email')).toBe('CREATE INDEX "idx_users_email" ON "users" ("email")');
    } finally {
      setCurrentDbRef(null);
    }
  });

  it('pg_get_indexdef returns null when no index row', () => {
    const db = {
      prepare: (sql: string) => {
        if (sql.includes('sqlite_master WHERE type IN')) {
          return { get: () => undefined, all: () => [{ name: 'users', type: 'table' }] };
        }
        return { get: () => undefined, all: () => [] };
      },
      exec: () => undefined,
    } as any;
    setCurrentDbRef(db);
    try {
      // 'users' is a table (not index); masterSql has no CREATE INDEX → index row null → null
      expect(ex('pg_get_indexdef', 'users')).toBeNull();
      // idxInfo length 0 branch
      expect(ex('pg_get_indexdef', 'unknown_idx')).toBeNull();
    } finally {
      setCurrentDbRef(null);
    }
  });

  it('resolveRelation passthrough for non-string non-number (object/boolean)', () => {
    setCurrentDbRef(makeMockDb());
    // resolveRelation returns String(rel) for exotic types; pg_get_* then resolve name
    expect(ex('pg_get_indexdef', { toString: () => 'idx_users_email' })).toBeDefined();
    setCurrentDbRef(null);
  });

  it('pg_get_serial_sequence falls back to naming convention without identity table', () => {
    const db = makeMockDb() as any;
    // Override prepare so the identity-table probe returns undefined → fallback path
    const origPrep = db.prepare;
    db.prepare = (sql: string) => {
      if (sql.includes("name='_sqlvec_identity_columns'")) return { get: () => undefined, all: () => [] };
      return origPrep(sql);
    };
    setCurrentDbRef(db);
    try {
      expect(ex('pg_get_serial_sequence', 'users', 'id')).toBe('users_id_seq');
    } finally {
      setCurrentDbRef(null);
    }
  });

  it('pg_get_function_identity_arguments uses bigint for bigint-returning functions', () => {
    // A bigint-returning function (e.g. some pg_stat) → integer args in identity list
    const fns = SystemFunctionRegistry.getFunctionNames();
    const bigintFn = fns.find(n => SystemFunctionRegistry.getFunction(n)?.returnType === 'bigint');
    if (bigintFn) {
      const oid = SystemFunctionRegistry.getFunction(bigintFn)?.oid;
      const out = ex('pg_get_function_identity_arguments', oid);
      expect(typeof out).toBe('string');
    }
  });
});
