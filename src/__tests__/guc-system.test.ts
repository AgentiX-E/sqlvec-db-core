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

  it('set() writes the single registry map so registry.get() observes it (BUG #116)', () => {
    // A bare set()/handleSet() must also be visible via registry.get(), which
    // current_setting()/SHOW use; previously set() wrote a separate `values` map that
    // registry.get() never read.
    guc.set('bare_value', '42');
    expect(guc.registry.get('bare_value')).toEqual({ name: 'bare_value', value: '42' });
    guc.handleSet('another_value', 'x');
    expect(guc.registry.get('another_value')?.value).toBe('x');
  });

  it('get() returns a minimal { value } shape, not the raw registry entry', () => {
    guc.registry.register({ name: 'v', value: '1', vartype: 'string' });
    expect(guc.get('v')).toEqual({ value: '1' });
  });

  it('registry.register() preserves metadata while set() updates only the value', () => {
    guc.registry.register({ name: 'enable_hashjoin', value: 'on', vartype: 'string' });
    guc.set('enable_hashjoin', 'off');
    expect(guc.registry.get('enable_hashjoin')).toEqual({
      name: 'enable_hashjoin',
      value: 'off',
      vartype: 'string',
    });
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

  it('registry.register() merges into an existing entry of the same name', () => {
    guc.registry.register({ name: 'g', value: 'v1', vartype: 'string' });
    guc.registry.register({ name: 'g', value: 'v2', unit: 'ms' });
    expect(guc.registry.get('g')).toEqual({ name: 'g', value: 'v2', vartype: 'string', unit: 'ms' });
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
