import { describe, it, expect, beforeEach } from 'vitest';
import { GucSystem } from '../core/GucSystem';

describe('GucSystem — dynamic registry and singleton', () => {
  let guc: GucSystem;

  beforeEach(() => {
    guc = GucSystem.getInstance();
    // Reset runtime state back to empty between tests (resetAllToDefaults clears values + registry).
    guc.registry.resetAllToDefaults();
  });

  it('returns a shared singleton from getInstance and getDefaultInstance', () => {
    expect(GucSystem.getInstance()).toBe(guc);
    expect(GucSystem.getDefaultInstance()).toBe(guc);
  });

  it('set() records a value observable through get()', () => {
    guc.set('statement_timeout', '1000');
    expect(guc.get('statement_timeout')).toEqual({ value: '1000' });
  });

  it('get() falls back from registry to the bare values map', () => {
    // No registry entry — get() must consult the values map (its `if (entry)` false arm).
    guc.set('bare_value', '42');
    expect(guc.get('bare_value')).toEqual({ value: '42' });
    // And a registered entry takes precedence over the values map.
    guc.registry.register({ name: 'bare_value', value: 'registered' });
    expect(guc.get('bare_value')).toEqual(expect.objectContaining({ value: 'registered' }));
  });

  it('get() returns an empty object for an unset parameter', () => {
    expect(guc.get('never_set')).toEqual({});
  });

  it('getAll() snapshots every runtime-set value', () => {
    guc.set('a', '1');
    guc.set('b', '2');
    expect(guc.getAll()).toEqual({ a: '1', b: '2' });
  });

  it('handleSet() stores the value and reports success (null error)', () => {
    const err = guc.handleSet('work_mem', '64MB');
    expect(err).toBeNull();
    expect(guc.get('work_mem')).toEqual({ value: '64MB' });
  });

  it('handleShow() reports ok for a set value', () => {
    guc.set('search_path', 'public');
    expect(guc.handleShow('search_path')).toEqual({ ok: true, value: 'public' });
  });

  it('handleShow() reports not-ok for an unset value', () => {
    expect(guc.handleShow('never_set')).toEqual({ ok: false, value: '' });
  });

  it('registry.set() mirrors top-level set(), returning null error', () => {
    const err = guc.registry.set('foo', 'bar');
    expect(err).toBeNull();
    expect(guc.get('foo')).toEqual({ value: 'bar' });
  });

  it('registry.register() + registry.get() round-trip a full entry', () => {
    guc.registry.register({ name: 'enable_hashjoin', value: 'off', vartype: 'string' });
    const entry = guc.registry.get('enable_hashjoin');
    expect(entry).toMatchObject({ name: 'enable_hashjoin', value: 'off', vartype: 'string' });
  });

  it('registry.get() returns undefined for an unregistered parameter', () => {
    expect(guc.registry.get('unknown')).toBeUndefined();
  });

  it('set() updates an existing registry entry value', () => {
    guc.registry.register({ name: 'enable_hashjoin', value: 'on' });
    guc.set('enable_hashjoin', 'off');
    expect(guc.registry.get('enable_hashjoin')?.value).toBe('off');
  });

  it('handleShow() prefers a registered entry value', () => {
    guc.registry.register({ name: 'default_transaction_isolation', value: 'serializable' });
    expect(guc.handleShow('default_transaction_isolation')).toEqual({
      ok: true,
      value: 'serializable',
    });
  });

  it('resetAllToDefaults() clears both values and registry', () => {
    guc.set('a', '1');
    guc.registry.register({ name: 'b', value: '2' });
    guc.registry.resetAllToDefaults();
    expect(guc.getAll()).toEqual({});
    expect(guc.registry.get('b')).toBeUndefined();
  });

  it('getPgSettingsView() returns the standard pg_settings snapshot', () => {
    const rows = guc.getPgSettingsView();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('name');
    expect(rows[0]).toHaveProperty('setting');
  });
});
