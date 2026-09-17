/**
 * Unit tests for the PgHbaConf host-based authentication parser.
 *
 * Exercises the tokenizer (quoting, comments, unbalanced quotes), the per-line
 * parser (local vs host rules, unknown/underspecified types, options), and the
 * configuration loader (empty input fallback, comment skipping, malformed-line
 * tolerance, snapshot isolation).
 */
import { describe, it, expect } from 'vitest';
import { PgHbaConf, type HbaRecord } from '../auth/pgHbaConf';

describe('PgHbaConf.load', () => {
  it('returns default rules for empty input', () => {
    const conf = PgHbaConf.load();
    const rules = conf.getRules();
    expect(rules).toHaveLength(3);
    expect(rules[0].type).toBe('local');
    expect(rules[0].authMethod).toBe('trust');
  });

  it('returns default rules for whitespace-only input', () => {
    const conf = PgHbaConf.load('   \n\t  ');
    expect(conf.getRules()).toHaveLength(3);
  });

  it('returns default rules when every line is comment/skipped', () => {
    const conf = PgHbaConf.load('# only a comment\n\n# another');
    expect(conf.getRules()).toHaveLength(3);
  });

  it('parses a local rule without address', () => {
    const conf = PgHbaConf.load('local all all trust');
    const rules = conf.getRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      type: 'local',
      database: 'all',
      user: 'all',
      address: null,
      authMethod: 'trust',
      options: {},
    });
  });

  it('parses a host rule with CIDR address', () => {
    const conf = PgHbaConf.load('host mydb alice 10.0.0.0/8 md5');
    const rules = conf.getRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe('host');
    expect(rules[0].database).toBe('mydb');
    expect(rules[0].user).toBe('alice');
    expect(rules[0].address).toBe('10.0.0.0/8');
    expect(rules[0].authMethod).toBe('md5');
  });

  it('parses hostssl and hostnossl types with addresses', () => {
    const conf = PgHbaConf.load(
      'hostssl all all ::1/128 scram-sha-256\nhostnossl all all 192.168.0.0/16 reject',
    );
    const rules = conf.getRules();
    expect(rules.map((r) => r.type)).toEqual(['hostssl', 'hostnossl']);
    expect(rules[0].address).toBe('::1/128');
    expect(rules[1].authMethod).toBe('reject');
  });

  it('parses options key=value pairs', () => {
    const conf = PgHbaConf.load('host all all 0.0.0.0/0 cert clientcert=verify-full map=ssl');
    const [rule] = conf.getRules();
    expect(rule.options).toEqual({ clientcert: 'verify-full', map: 'ssl' });
  });

  it('ignores option-like tokens without an equals sign', () => {
    const conf = PgHbaConf.load('host all all 0.0.0.0/0 md5 bogus');
    expect(conf.getRules()[0].options).toEqual({});
  });

  it('skips comment and blank lines, keeps valid ones', () => {
    const conf = PgHbaConf.load('# header\n\nlocal all all trust\n  # indented comment\nhost all all 127.0.0.1/32 md5\n');
    const rules = conf.getRules();
    expect(rules).toHaveLength(2);
    expect(rules[0].type).toBe('local');
    expect(rules[1].type).toBe('host');
  });

  it('skips malformed lines with fewer than required tokens', () => {
    const conf = PgHbaConf.load('local all\nhost all all 0.0.0.0/0\nnot-a-type all all trust');
    // "local all" (3 tokens) and "not-a-type" lines are skipped; "host ... trust" is missing.
    // host requires 5 tokens but only 4 given → skipped. Result: default rules.
    expect(conf.getRules()).toHaveLength(3);
  });

  it('preserves case by lowercasing the type token but keeps database/user', () => {
    const conf = PgHbaConf.load('HOST MyDb Alice 1.2.3.4/32 password');
    const [rule] = conf.getRules();
    expect(rule.type).toBe('host');
    expect(rule.database).toBe('MyDb');
    expect(rule.user).toBe('Alice');
  });

  it('handles CRLF line endings', () => {
    const conf = PgHbaConf.load('local all all trust\r\nhost all all 0.0.0.0/0 md5\r\n');
    expect(conf.getRules()).toHaveLength(2);
  });

  it('parses quoted values containing spaces', () => {
    const conf = PgHbaConf.load('host "my db" "some user" 0.0.0.0/0 "md5 password"');
    const [rule] = conf.getRules();
    expect(rule.database).toBe('my db');
    expect(rule.user).toBe('some user');
    expect(rule.authMethod).toBe('md5 password');
  });

  it('collapses runs of consecutive whitespace (empty-token guard branch)', () => {
    const conf = PgHbaConf.load('host\t\tall     all\t0.0.0.0/0   trust');
    const [rule] = conf.getRules();
    expect(rule.database).toBe('all');
    expect(rule.user).toBe('all');
    expect(rule.address).toBe('0.0.0.0/0');
    expect(rule.authMethod).toBe('trust');
  });

  it('skips a line with an unbalanced quote', () => {
    const conf = PgHbaConf.load('host "unclosed all 0.0.0.0/0 md5\nlocal all all trust');
    // The unbalanced-quote line is skipped; the local line is kept.
    const rules = conf.getRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe('local');
  });
});

describe('PgHbaConf snapshot isolation', () => {
  it('getRules returns a defensive copy of records and options', () => {
    const conf = PgHbaConf.load('host all all 0.0.0.0/0 md5 clientcert=verify-full');
    const first = conf.getRules();
    first[0].database = 'mutated';
    first[0].options.clientcert = 'mutated';

    const second = conf.getRules();
    expect(second[0].database).toBe('all');
    expect(second[0].options.clientcert).toBe('verify-full');
  });

  it('getRecords is an alias of getRules', () => {
    const conf = PgHbaConf.load('local all all trust');
    expect(conf.getRecords()).toEqual(conf.getRules());
  });
});

describe('PgHbaConf integration with HbaRecord contract', () => {
  it('produces records whose authMethod matches the hbaRecordToRow consumer', () => {
    const conf = PgHbaConf.load('host mydb alice 10.0.0.0/8 md5 clientcert=1');
    const rec: HbaRecord = conf.getRules()[0];
    // The pg_hba_file_rules view uses auth_method; ensure the field is present.
    expect(rec.authMethod).toBe('md5');
    expect(rec.address).toBe('10.0.0.0/8');
    expect(rec.options).toEqual({ clientcert: '1' });
  });
});
