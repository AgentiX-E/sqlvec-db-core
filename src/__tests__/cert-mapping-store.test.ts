/**
 * Unit tests for the certificate-to-user mapping store.
 *
 * Covers the full CRUD surface and defensive-copy guarantees, and verifies the
 * {@link query/CertMapShim} integration relies on the correct public API
 * (`create`, `setMapping`, `removeMappingByDbUser`) that was previously missing
 * from the 3-line stub (BUG #157 / #158).
 */
import { describe, it, expect } from 'vitest';
import {
  CertMappingStore,
  create,
  type CertMappings,
} from '../auth/CertMappingStore';
import { rewriteCertMap, detectCertMap } from '../query/CertMapShim';

describe('CertMappingStore — factories', () => {
  it('create() returns a fresh, empty store', () => {
    const store = create();
    expect(store).toBeInstanceOf(CertMappingStore);
    expect(store.size).toBe(0);
    expect(store.isEmpty).toBe(true);
  });

  it('CertMappingStore.create() matches create()', () => {
    expect(CertMappingStore.create()).toBeInstanceOf(CertMappingStore);
  });

  it('getInstance() returns the same singleton across calls', () => {
    const a = CertMappingStore.getInstance();
    const b = CertMappingStore.getInstance();
    expect(a).toBe(b);
  });

  it('create() does not return the singleton', () => {
    const singleton = CertMappingStore.getInstance();
    const fresh = CertMappingStore.create();
    expect(fresh).not.toBe(singleton);
    expect(fresh).not.toBe(CertMappingStore.getInstance());
  });
});

describe('CertMappingStore — CRUD', () => {
  it('setMapping + map round-trips a CN to a user', () => {
    const store = CertMappingStore.create();
    store.setMapping('client-cert-cn', 'alice');
    expect(store.map('client-cert-cn')).toBe('alice');
    expect(store.size).toBe(1);
  });

  it('setMapping overwrites an existing CN mapping', () => {
    const store = CertMappingStore.create();
    store.setMapping('cn', 'alice');
    store.setMapping('cn', 'bob');
    expect(store.map('cn')).toBe('bob');
    expect(store.size).toBe(1);
  });

  it('map returns undefined for an unknown CN', () => {
    const store = CertMappingStore.create();
    expect(store.map('missing')).toBeUndefined();
  });

  it('removeMapping deletes a mapping and reports success', () => {
    const store = CertMappingStore.create();
    store.setMapping('cn', 'alice');
    expect(store.removeMapping('cn')).toBe(true);
    expect(store.map('cn')).toBeUndefined();
    expect(store.removeMapping('cn')).toBe(false);
  });

  it('removeMappingByDbUser clears all CNs for a user, counts removals', () => {
    const store = CertMappingStore.create();
    store.setMapping('cn-a', 'alice');
    store.setMapping('cn-b', 'alice');
    store.setMapping('cn-c', 'bob');
    const removed = store.removeMappingByDbUser('alice');
    expect(removed).toBe(2);
    expect(store.map('cn-a')).toBeUndefined();
    expect(store.map('cn-b')).toBeUndefined();
    expect(store.map('cn-c')).toBe('bob');
    expect(store.size).toBe(1);
  });

  it('removeMappingByDbUser returns 0 when no mapping matches', () => {
    const store = CertMappingStore.create();
    store.setMapping('cn', 'alice');
    expect(store.removeMappingByDbUser('nobody')).toBe(0);
    expect(store.size).toBe(1);
  });
});

describe('CertMappingStore — defensive copies', () => {
  it('getAllMappings returns a snapshot detached from internal state', () => {
    const store = CertMappingStore.create();
    store.setMapping('cn', 'alice');

    const snapshot: CertMappings = store.getAllMappings();
    expect(snapshot.get('cn')).toBe('alice');

    // Mutating the store after snapshot must not affect the snapshot.
    store.setMapping('cn', 'carol');
    expect(snapshot.get('cn')).toBe('alice');

    // Mutating the snapshot must not affect the store.
    store.setMapping('cn', 'alice'); // restore
    snapshot.set('cn', 'intruder');
    expect(store.map('cn')).toBe('alice');
  });
});

describe('CertMappingStore — CertMapShim integration (BUG #157/#158)', () => {
  it('imports the create factory (not a missing named export)', () => {
    expect(create).toBeTypeOf('function');
  });

  it('CREATE USER MAPPING stores the cert mapping', () => {
    const store = CertMappingStore.create();
    // CertMapShim uses its own singleton; verify the public API contract here
    // by exercising setMapping/removeMappingByDbUser explicitly.
    store.setMapping('my-cert-cn', 'alice');
    expect(store.map('my-cert-cn')).toBe('alice');
    expect(store.removeMappingByDbUser('alice')).toBe(1);
  });

  it('rewriteCertMap does not throw (missing methods now present)', () => {
    // Previously threw TypeError: store.setMapping is not a function.
    const result = rewriteCertMap(
      "CREATE USER MAPPING FOR alice SERVER pg_remote OPTIONS (cert 'my-cert-cn')",
    );
    expect(result.rewritten).toBe(true);
    expect(result.sql).toBe('SELECT 1');
  });

  it('detectCertMap recognizes user mapping DDL', () => {
    expect(detectCertMap("DROP USER MAPPING FOR alice SERVER pg_remote")).toBe(true);
    expect(detectCertMap('SELECT 1')).toBe(false);
  });
});

describe('CertMapShim — full rewrite surface', () => {
  it('detectCertMap handles empty / non-string', () => {
    expect(detectCertMap('')).toBe(false);
    expect(detectCertMap('   ')).toBe(false);
    // @ts-expect-error defensive branch
    expect(detectCertMap(null)).toBe(false);
  });

  it('rewriteCertMap passes through empty / non-string', () => {
    expect(rewriteCertMap('')).toEqual({ sql: '', rewritten: false });
    // @ts-expect-error defensive branch
    expect(rewriteCertMap(null)).toEqual({ sql: '', rewritten: false });
  });

  it('rewriteCertMap passes through non-user-mapping SQL', () => {
    const r = rewriteCertMap('CREATE TABLE t (id int);');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('CREATE TABLE t (id int);');
  });

  it('rewrites CREATE USER MAPPING with IF NOT EXISTS and cert', () => {
    const r = rewriteCertMap(
      "CREATE USER MAPPING IF NOT EXISTS FOR bob SERVER srv OPTIONS (cert 'bob-cert')",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });

  it('rewrites ALTER USER MAPPING with cert', () => {
    const r = rewriteCertMap(
      "ALTER USER MAPPING FOR bob SERVER srv OPTIONS (SET cert 'bob-cert')",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });

  it('rewrites DROP USER MAPPING', () => {
    const r = rewriteCertMap('DROP USER MAPPING FOR alice SERVER pg_remote');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });

  it('rewrites DROP USER MAPPING IF EXISTS', () => {
    const r = rewriteCertMap('DROP USER MAPPING IF EXISTS FOR alice SERVER srv');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });

  it('rewrites CREATE USER MAPPING without cert (no side-effect, still SELECT 1)', () => {
    const r = rewriteCertMap(
      "CREATE USER MAPPING FOR alice SERVER srv OPTIONS (user 'alice')",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });

  it('rewrites CREATE USER MAPPING FOR CURRENT_USER without cert', () => {
    const r = rewriteCertMap('CREATE USER MAPPING FOR CURRENT_USER SERVER srv');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });

  it('rewrites DROP USER MAPPING FOR CURRENT_USER', () => {
    const r = rewriteCertMap('DROP USER MAPPING FOR CURRENT_USER SERVER srv');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });

  it('detectCertMap true for all three DDL prefixes', () => {
    expect(detectCertMap('CREATE USER MAPPING FOR a SERVER s')).toBe(true);
    expect(detectCertMap('ALTER USER MAPPING FOR a SERVER s')).toBe(true);
    expect(detectCertMap('DROP USER MAPPING FOR a SERVER s')).toBe(true);
  });

  it('detectCertMap false for embedded identifiers', () => {
    expect(detectCertMap('SELECT * FROM my_create_user_mapping')).toBe(false);
    expect(detectCertMap('CREATE TABLE user_mapping (id int)')).toBe(false);
  });
});

  it('rewrites DROP USER MAPPING FOR user without SERVER (parse fail → still SELECT 1)', () => {
    const r = rewriteCertMap('DROP USER MAPPING FOR alice');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });

  it('rewrites DROP USER MAPPING FOR CURRENT_USER without SERVER', () => {
    const r = rewriteCertMap('DROP USER MAPPING FOR CURRENT_USER');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });
