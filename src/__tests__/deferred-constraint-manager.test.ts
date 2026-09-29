import { describe, it, expect, beforeEach } from 'vitest';
import { DeferredConstraintManager } from '../query/DeferredConstraintManager';

describe('DeferredConstraintManager', () => {
  let mgr: DeferredConstraintManager;

  beforeEach(() => {
    mgr = new DeferredConstraintManager();
  });

  describe('setConstraintsDeferred / isDeferred', () => {
    it('defaults to not deferred for unknown session', () => {
      expect(mgr.isDeferred('unknown')).toBe(false);
    });

    it('sets and reads deferred state', () => {
      mgr.setConstraintsDeferred('s1', true);
      expect(mgr.isDeferred('s1')).toBe(true);

      mgr.setConstraintsDeferred('s1', false);
      expect(mgr.isDeferred('s1')).toBe(false);
    });

    it('tracks state independently per session', () => {
      mgr.setConstraintsDeferred('a', true);
      mgr.setConstraintsDeferred('b', false);
      expect(mgr.isDeferred('a')).toBe(true);
      expect(mgr.isDeferred('b')).toBe(false);
    });
  });

  describe('queueFkCheck', () => {
    it('does not queue when not deferred', () => {
      mgr.setConstraintsDeferred('s', false);
      mgr.queueFkCheck('s', 'orders', ['customer_id'], 'customers', ['id'], [42], 'SIMPLE');
      expect(mgr.getPendingCount('s')).toBe(0);
    });

    it('queues when deferred', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['customer_id'], 'customers', ['id'], [42], 'SIMPLE');
      expect(mgr.getPendingCount('s')).toBe(1);
    });

    it('uses SIMPLE as default match type', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['customer_id'], 'customers', ['id'], [42]);
      // If it were FULL, a partial-NULL would throw; a plain value is unaffected.
      const violations = mgr.validateAll('s', () => true);
      expect(violations).toEqual([]);
    });
  });

  describe('queueUniqueCheck', () => {
    it('does not queue when not deferred', () => {
      mgr.setConstraintsDeferred('s', false);
      mgr.queueUniqueCheck('s', 'users', 'uq_email', ['email'], ['a@b.c'], 'row1');
      expect(mgr.getPendingCount('s')).toBe(0);
    });

    it('queues when deferred', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueUniqueCheck('s', 'users', 'uq_email', ['email'], ['a@b.c'], 'row1');
      expect(mgr.getPendingCount('s')).toBe(1);
    });
  });

  describe('validateAll', () => {
    it('returns empty for unknown session', () => {
      expect(mgr.validateAll('nope')).toEqual([]);
    });

    it('returns empty when no pending checks', () => {
      mgr.setConstraintsDeferred('s', true);
      expect(mgr.validateAll('s')).toEqual([]);
    });

    it('skips FK validation when no checkFkExistsFn provided', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['a'], 't', ['b'], [1], 'SIMPLE');
      expect(mgr.validateAll('s')).toEqual([]);
    });

    it('skips UNIQUE validation when no checkUniqueExistsFn provided', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueUniqueCheck('s', 'users', 'uq', ['a'], [1], 'r1');
      expect(mgr.validateAll('s')).toEqual([]);
    });

    it('reports FK violation when reference does not exist', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['customer_id'], 'customers', ['id'], [42], 'SIMPLE');
      const violations = mgr.validateAll('s', () => false);
      expect(violations).toHaveLength(1);
      expect(violations[0].constraintType).toBe('FOREIGN KEY');
      expect(violations[0].sqlState).toBe('23503');
      expect(violations[0].table).toBe('orders');
      expect(violations[0].message).toContain('customer_id');
    });

    it('passes FK when reference exists', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['customer_id'], 'customers', ['id'], [42], 'SIMPLE');
      expect(mgr.validateAll('s', () => true)).toEqual([]);
    });

    it('reports UNIQUE violation when duplicate exists', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueUniqueCheck('s', 'users', 'uq_email', ['email'], ['a@b.c'], 'row1');
      const violations = mgr.validateAll('s', undefined, () => true);
      expect(violations).toHaveLength(1);
      expect(violations[0].constraintType).toBe('UNIQUE');
      expect(violations[0].constraintName).toBe('uq_email');
      expect(violations[0].sqlState).toBe('23505');
    });

    it('passes UNIQUE when no duplicate', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueUniqueCheck('s', 'users', 'uq_email', ['email'], ['a@b.c'], 'row1');
      expect(mgr.validateAll('s', undefined, () => false)).toEqual([]);
    });

    it('passes excludeRowId (localRowId) through to unique check fn', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueUniqueCheck('s', 'users', 'uq_email', ['email'], ['a@b.c'], 'row-abc');
      let receivedId: string | undefined;
      mgr.validateAll('s', undefined, (_t, _c, _v, excludeRowId) => {
        receivedId = excludeRowId;
        return false;
      });
      expect(receivedId).toBe('row-abc');
    });

    it('validates multiple mixed checks and aggregates violations', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['a'], 't', ['b'], [1], 'SIMPLE');
      mgr.queueUniqueCheck('s', 'users', 'uq', ['c'], [2], 'r2');
      const violations = mgr.validateAll('s', () => false, () => true);
      expect(violations).toHaveLength(2);
    });

    it('clears pending checks after validation', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['a'], 't', ['b'], [1], 'SIMPLE');
      mgr.validateAll('s', () => true);
      expect(mgr.getPendingCount('s')).toBe(0);
    });
  });

  describe('MATCH semantics (NULL handling)', () => {
    it('MATCH SIMPLE skips check when any FK column is NULL', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['a', 'b'], 't', ['x', 'y'], [1, null], 'SIMPLE');
      let called = false;
      const violations = mgr.validateAll('s', () => {
        called = true;
        return false;
      });
      expect(called).toBe(false);
      expect(violations).toEqual([]);
    });

    it('MATCH PARTIAL skips check when any FK column is NULL', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['a', 'b'], 't', ['x', 'y'], [1, null], 'PARTIAL');
      let called = false;
      const violations = mgr.validateAll('s', () => {
        called = true;
        return false;
      });
      expect(called).toBe(false);
      expect(violations).toEqual([]);
    });

    it('MATCH FULL reports a violation for partially-NULL values', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['a', 'b'], 't', ['x', 'y'], [1, null], 'FULL');
      let called = false;
      const violations = mgr.validateAll('s', () => {
        called = true;
        return false;
      });
      expect(called).toBe(false);
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toContain('MATCH FULL');
      expect(violations[0].sqlState).toBe('23503');
    });

    it('MATCH FULL skips check when all FK columns are NULL', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['a', 'b'], 't', ['x', 'y'], [null, null], 'FULL');
      let called = false;
      const violations = mgr.validateAll('s', () => {
        called = true;
        return false;
      });
      expect(called).toBe(false);
      expect(violations).toEqual([]);
    });

    it('MATCH FULL still validates fully non-NULL values', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['a', 'b'], 't', ['x', 'y'], [1, 2], 'FULL');
      let called = false;
      const violations = mgr.validateAll('s', () => {
        called = true;
        return true;
      });
      expect(called).toBe(true);
      expect(violations).toEqual([]);
    });
  });

  describe('clearPending', () => {
    it('clears pending checks for a session', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'orders', ['a'], 't', ['b'], [1]);
      mgr.clearPending('s');
      expect(mgr.getPendingCount('s')).toBe(0);
    });

    it('does nothing for unknown session', () => {
      expect(() => mgr.clearPending('nope')).not.toThrow();
    });
  });

  describe('constraint registration', () => {
    it('registers and retrieves a constraint', () => {
      mgr.registerConstraint('con1', 'FOREIGN KEY', 't', ['a'], true, false);
      const def = mgr.getConstraint('con1');
      expect(def).toBeDefined();
      expect(def?.type).toBe('FOREIGN KEY');
      expect(def?.table).toBe('t');
      expect(def?.columns).toEqual(['a']);
      expect(def?.deferred).toBe(true);
      expect(def?.initiallyDeferred).toBe(false);
    });

    it('returns undefined for unknown constraint', () => {
      expect(mgr.getConstraint('missing')).toBeUndefined();
    });

    it('lists all constraints with names', () => {
      mgr.registerConstraint('con1', 'UNIQUE', 't', ['a'], false, false);
      mgr.registerConstraint('con2', 'FOREIGN KEY', 'u', ['b'], true, true);
      const all = mgr.getAllConstraints();
      expect(all).toHaveLength(2);
      expect(all.map((c) => c.name).sort()).toEqual(['con1', 'con2']);
      expect(all.find((c) => c.name === 'con2')?.initiallyDeferred).toBe(true);
    });

    it('unregisters a constraint', () => {
      mgr.registerConstraint('con1', 'UNIQUE', 't', ['a'], false, false);
      mgr.unregisterConstraint('con1');
      expect(mgr.getConstraint('con1')).toBeUndefined();
    });
  });

  describe('pending counts', () => {
    it('returns 0 for unknown session', () => {
      expect(mgr.getPendingCount('nope')).toBe(0);
    });

    it('totals pending across sessions', () => {
      mgr.setConstraintsDeferred('a', true);
      mgr.setConstraintsDeferred('b', true);
      mgr.queueFkCheck('a', 'c', ['x'], 'p', ['y'], [1]);
      mgr.queueFkCheck('b', 'c', ['x'], 'p', ['y'], [2]);
      mgr.queueUniqueCheck('b', 't', 'uq', ['z'], [3], 'r');
      expect(mgr.getTotalPendingCount()).toBe(3);
    });
  });

  describe('reset', () => {
    it('clears all sessions and constraints', () => {
      mgr.setConstraintsDeferred('s', true);
      mgr.queueFkCheck('s', 'c', ['x'], 'p', ['y'], [1]);
      mgr.registerConstraint('con', 'UNIQUE', 't', ['a'], false, false);
      mgr.reset();
      expect(mgr.getTotalPendingCount()).toBe(0);
      expect(mgr.getAllConstraints()).toEqual([]);
      expect(mgr.isDeferred('s')).toBe(false);
    });
  });
});
