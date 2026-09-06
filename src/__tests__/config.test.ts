/**
 * ConfigValidator and SqlVecConfig unit tests.
 *
 * Verifies Zod-based config validation (validate/validatePartial/ports/hosts/
 * node IDs/formatErrors) and the JSON-file + env-var config loading path used
 * by `loadConfig()`. Covers success, failure, and boundary cases.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigValidator } from '../config/ConfigValidator';
import { loadConfig } from '../config/SqlVecConfig';

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    cluster: { nodeId: 'node-0001', ...overrides.cluster },
    vector: { dimension: 768, ...overrides.vector },
    replication: { tickMs: 500, ...overrides.replication },
    storage: { shardDir: './data/shards', ...overrides.storage },
  };
}

describe('ConfigValidator.validate', () => {
  it('accepts a minimal valid config', () => {
    const r = ConfigValidator.validate(validConfig());
    expect(r.success).toBe(true);
    expect(r.data).toBeDefined();
    expect(r.errors).toBeUndefined();
  });

  it('rejects a config missing the required nodeId', () => {
    const cfg = validConfig();
    delete (cfg.cluster as any).nodeId;
    const r = ConfigValidator.validate(cfg);
    expect(r.success).toBe(false);
    expect(r.errors!.length).toBeGreaterThan(0);
    expect(r.errors![0]).toHaveProperty('path');
    expect(r.errors![0]).toHaveProperty('message');
  });

  it('rejects a config missing the whole cluster object', () => {
    const r = ConfigValidator.validate({ vector: {} });
    expect(r.success).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    const r = ConfigValidator.validate(validConfig({ cluster: { pgPort: 99999 } }));
    expect(r.success).toBe(false);
  });
});

describe('ConfigValidator.validatePartial', () => {
  it('accepts a partial raw config', () => {
    const r = ConfigValidator.validatePartial({ cluster: { nodeId: 'n1' } });
    // Partial schema allows optional string/number ports etc.
    expect(r.success).toBe(true);
  });

  it('reports errors for invalid partial input', () => {
    // The raw schema expects `cluster` to be an object; a non-object value
    // (e.g. a number) must fail validation.
    const r = ConfigValidator.validatePartial({ cluster: 123 });
    expect(r.success).toBe(false);
    expect(r.errors!.length).toBeGreaterThan(0);
  });
});

describe('ConfigValidator field validators', () => {
  it('validatePort accepts 1..65535 integers only', () => {
    expect(ConfigValidator.validatePort(1)).toBe(true);
    expect(ConfigValidator.validatePort(5432)).toBe(true);
    expect(ConfigValidator.validatePort(65535)).toBe(true);
    expect(ConfigValidator.validatePort(0)).toBe(false);
    expect(ConfigValidator.validatePort(65536)).toBe(false);
    expect(ConfigValidator.validatePort(3.14)).toBe(false);
    expect(ConfigValidator.validatePort(NaN)).toBe(false);
  });

  it('validateHost accepts non-empty strings only', () => {
    expect(ConfigValidator.validateHost('localhost')).toBe(true);
    expect(ConfigValidator.validateHost('127.0.0.1')).toBe(true);
    expect(ConfigValidator.validateHost('')).toBe(false);
    expect(ConfigValidator.validateHost('   ')).toBe(false);
    expect(ConfigValidator.validateHost(42 as any)).toBe(false);
  });

  it('validateNodeId accepts non-empty strings only', () => {
    expect(ConfigValidator.validateNodeId('node-1')).toBe(true);
    expect(ConfigValidator.validateNodeId('')).toBe(false);
    expect(ConfigValidator.validateNodeId('  ')).toBe(false);
    expect(ConfigValidator.validateNodeId(123 as any)).toBe(false);
  });
});

describe('ConfigValidator.formatErrors', () => {
  it('returns null for a valid config', () => {
    expect(ConfigValidator.formatErrors(validConfig())).toBeNull();
  });

  it('returns a formatted multi-line string for invalid config', () => {
    const s = ConfigValidator.formatErrors({ vector: {} });
    expect(typeof s).toBe('string');
    expect(s).toContain('[');
    expect(s).toContain(']');
  });
});

describe('loadConfig', () => {
  let tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('SQLVEC_') || k === 'TDE_ENABLED') delete process.env[k];
    }
  });

  it('loads defaults when no config path is provided', () => {
    const cfg = loadConfig();
    expect(cfg.cluster.clusterName).toBe('sqlvec-default');
    expect(cfg.cluster.pgPort).toBe(5432);
    expect(cfg.cluster.nodeId).toMatch(/^node_/);
    expect(cfg.vector.dimension).toBe(768);
    // rawDefaults seeds shardDir as './data/shards' (the `||` short-circuits
    // before path.join), so the default is the literal seeded value.
    expect(cfg.storage.shardDir).toBe('./data/shards');
  });

  it('loads a JSON config file when a valid path is provided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    tmpDirs.push(dir);
    const file = join(dir, 'sqlvec.json');
    writeFileSync(file, JSON.stringify({
      cluster: { nodeId: 'custom-node', pgPort: 7000, dataDir: '/tmp/db' },
      vector: { dimension: 384 },
    }));
    const cfg = loadConfig(file);
    expect(cfg.cluster.nodeId).toBe('custom-node');
    expect(cfg.cluster.pgPort).toBe(7000);
    expect(cfg.vector.dimension).toBe(384);
    expect(cfg.storage.shardDir).toBe(join('/tmp/db', 'shards'));
  });

  it('falls back to defaults when the config path does not exist', () => {
    const cfg = loadConfig('/nonexistent/path/config.json');
    expect(cfg.cluster.clusterName).toBe('sqlvec-default');
  });

  it('applies env-var overrides via rawDefaults', () => {
    process.env.SQLVEC_PG_PORT = '9999';
    process.env.SQLVEC_NODE_ID = 'env-node';
    process.env.TDE_ENABLED = 'true';
    const cfg = loadConfig();
    expect(cfg.cluster.pgPort).toBe(9999);
    expect(cfg.cluster.nodeId).toBe('env-node');
    expect(cfg.tde.enabled).toBe(true);
  });

  it('applies env overrides on top of a JSON config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    tmpDirs.push(dir);
    const file = join(dir, 'sqlvec.json');
    writeFileSync(file, JSON.stringify({ cluster: { nodeId: 'json-node', pgPort: 1234 } }));
    process.env.SQLVEC_PG_PORT = '5555';
    const cfg = loadConfig(file);
    expect(cfg.cluster.nodeId).toBe('json-node'); // from file
    expect(cfg.cluster.pgPort).toBe(5555);        // overridden by env
  });

  it('parses boolean env vars correctly (autoForward != false)', () => {
    process.env.SQLVEC_AUTO_FORWARD = 'false';
    const cfg = loadConfig();
    expect(cfg.cluster.autoForward).toBe(false);
  });
});
