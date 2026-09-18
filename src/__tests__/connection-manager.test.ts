/**
 * Unit tests for ConnectionManager and ActiveQueryRegistry.
 *
 * Exercises session/query registration, mutation, removal, and snapshot
 * isolation, plus the ActiveQuery field contract (number timestamps, nullable
 * client address, optional backendStart) consumed by pg_stat_activity.
 */
import { describe, it, expect } from 'vitest';
import { ConnectionManager, type ActiveQuery, type SessionInfo } from '../monitoring/ConnectionManager';
import { ActiveQueryRegistry } from '../monitoring/ActiveQueryRegistry';

function makeQuery(overrides: Partial<ActiveQuery> = {}): ActiveQuery {
  return {
    pid: 100,
    userId: 'alice',
    clientAddr: '10.0.0.1',
    queryStart: 1700000000000,
    state: 'active',
    sql: 'SELECT 1',
    database: 'mydb',
    userName: 'alice',
    backendStart: 1699999999000,
    ...overrides,
  };
}

describe('ConnectionManager sessions', () => {
  it('registers and retrieves a session', () => {
    const cm = new ConnectionManager();
    const s: SessionInfo = { sessionId: 's1', ssl: true, sslVersion: 'TLSv1.3', clientDn: null };
    cm.registerSession(s);
    expect(cm.getSession('s1')).toEqual(s);
  });

  it('returns undefined for an unknown session', () => {
    const cm = new ConnectionManager();
    expect(cm.getSession('nope')).toBeUndefined();
  });

  it('overwrites an existing session on re-register', () => {
    const cm = new ConnectionManager();
    cm.registerSession({ sessionId: 's1', ssl: false, sslVersion: null, clientDn: null });
    cm.registerSession({ sessionId: 's1', ssl: true, sslVersion: 'TLSv1.2', clientDn: 'cn=alice' });
    expect(cm.getSession('s1')?.ssl).toBe(true);
    expect(cm.getSession('s1')?.sslVersion).toBe('TLSv1.2');
  });

  it('unregisters a session and reports success', () => {
    const cm = new ConnectionManager();
    cm.registerSession({ sessionId: 's1', ssl: false, sslVersion: null, clientDn: null });
    expect(cm.unregisterSession('s1')).toBe(true);
    expect(cm.unregisterSession('s1')).toBe(false);
    expect(cm.getSession('s1')).toBeUndefined();
  });

  it('returns session ids as a snapshot', () => {
    const cm = new ConnectionManager();
    cm.registerSession({ sessionId: 'a', ssl: false, sslVersion: null, clientDn: null });
    cm.registerSession({ sessionId: 'b', ssl: false, sslVersion: null, clientDn: null });
    const ids = cm.getSessionIds();
    expect(ids).toEqual(['a', 'b']);
    ids.push('c'); // must not affect registry
    expect(cm.getSessionIds()).toEqual(['a', 'b']);
  });

  it('returns sessions as a snapshot', () => {
    const cm = new ConnectionManager();
    cm.registerSession({ sessionId: 's1', ssl: true, sslVersion: 'TLSv1.3', clientDn: 'x' });
    const sessions = cm.getSessions();
    sessions[0].ssl = false; // must not affect registry
    expect(cm.getSession('s1')?.ssl).toBe(true);
  });
});

describe('ConnectionManager queries', () => {
  it('begins and reads back an active query', () => {
    const cm = new ConnectionManager();
    cm.beginQuery(makeQuery());
    const qs = cm.getActiveQueries();
    expect(qs).toHaveLength(1);
    expect(qs[0].sql).toBe('SELECT 1');
  });

  it('overwrites a query on the same pid', () => {
    const cm = new ConnectionManager();
    cm.beginQuery(makeQuery({ sql: 'SELECT 1' }));
    cm.beginQuery(makeQuery({ sql: 'SELECT 2' }));
    expect(cm.getActiveQueries()).toHaveLength(1);
    expect(cm.getActiveQueries()[0].sql).toBe('SELECT 2');
  });

  it('updates state and sql of a running query', () => {
    const cm = new ConnectionManager();
    cm.beginQuery(makeQuery());
    cm.updateQuery(100, { state: 'idle in transaction', sql: 'SELECT 9' });
    const q = cm.getActiveQueries()[0];
    expect(q.state).toBe('idle in transaction');
    expect(q.sql).toBe('SELECT 9');
  });

  it('updateQuery is a no-op for an unknown pid', () => {
    const cm = new ConnectionManager();
    cm.updateQuery(999, { state: 'idle' });
    expect(cm.getActiveQueries()).toHaveLength(0);
  });

  it('ends a query and reports success', () => {
    const cm = new ConnectionManager();
    cm.beginQuery(makeQuery());
    expect(cm.endQuery(100)).toBe(true);
    expect(cm.endQuery(100)).toBe(false);
    expect(cm.getActiveQueries()).toHaveLength(0);
  });

  it('getActiveQueries returns a defensive snapshot', () => {
    const cm = new ConnectionManager();
    cm.beginQuery(makeQuery());
    const qs = cm.getActiveQueries();
    qs[0].sql = 'MUTATED';
    qs[0].clientAddr = '1.1.1.1';
    const fresh = cm.getActiveQueries();
    expect(fresh[0].sql).toBe('SELECT 1');
    expect(fresh[0].clientAddr).toBe('10.0.0.1');
  });
});

describe('ActiveQueryRegistry', () => {
  it('registers and lists queries', () => {
    const reg = new ActiveQueryRegistry();
    reg.register(makeQuery());
    expect(reg.list()).toHaveLength(1);
    expect(reg.getActiveQueries()).toHaveLength(1);
    expect(reg.size).toBe(1);
  });

  it('overwrites on the same pid and grows on new pids', () => {
    const reg = new ActiveQueryRegistry();
    reg.register(makeQuery({ pid: 100 }));
    reg.register(makeQuery({ pid: 200 }));
    expect(reg.size).toBe(2);
    reg.register(makeQuery({ pid: 100, sql: 'SELECT 2' }));
    expect(reg.size).toBe(2);
    expect(reg.list().find((q) => q.pid === 100)?.sql).toBe('SELECT 2');
  });

  it('unregisters by pid and reports success', () => {
    const reg = new ActiveQueryRegistry();
    reg.register(makeQuery());
    expect(reg.unregister(100)).toBe(true);
    expect(reg.unregister(100)).toBe(false);
    expect(reg.size).toBe(0);
  });

  it('updates state/sql and is a no-op for unknown pid', () => {
    const reg = new ActiveQueryRegistry();
    reg.register(makeQuery());
    reg.update(100, { state: 'idle' });
    expect(reg.list()[0].state).toBe('idle');
    reg.update(999, { state: 'active' });
    expect(reg.size).toBe(1);
  });

  it('list returns a defensive snapshot', () => {
    const reg = new ActiveQueryRegistry();
    reg.register(makeQuery());
    const out = reg.list();
    out[0].sql = 'MUTATED';
    expect(reg.list()[0].sql).toBe('SELECT 1');
  });
});

describe('ActiveQuery field contract', () => {
  it('accepts null clientAddr (local connection)', () => {
    const cm = new ConnectionManager();
    cm.beginQuery(makeQuery({ clientAddr: null }));
    expect(cm.getActiveQueries()[0].clientAddr).toBeNull();
  });

  it('accepts a query without backendStart (lightweight source fallback)', () => {
    const cm = new ConnectionManager();
    const q = makeQuery();
    delete q.backendStart;
    cm.beginQuery(q);
    expect(cm.getActiveQueries()[0].backendStart).toBeUndefined();
  });
});
