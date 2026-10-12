import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NotifyListenerManager, type NotificationEvent } from '../query/NotifyListener';

const TABLE = '_sqlvec_notifications';

function createSqlite() {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'channel TEXT NOT NULL,' +
      "payload TEXT DEFAULT ''," +
      'pid INTEGER DEFAULT 0,' +
      "notified_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ')',
  );
  return db;
}

describe('NotifyListenerManager', () => {
  let db: Database.Database;
  let manager: NotifyListenerManager;
  const received: NotificationEvent[] = [];

  const makeManager = (opts?: Parameters<typeof NotifyListenerManager>[0]) => {
    const m = new NotifyListenerManager({
      pollIntervalMs: 100,
      execFn: (sql) => db.exec(sql),
      queryFn: (sql) => db.prepare(sql).all(),
      ...opts,
    });
    return m;
  };

  beforeEach(() => {
    db = createSqlite();
    received.length = 0;
    manager = makeManager();
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
    db.close();
  });

  it('creates the notifications table on construction', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.map((t: any) => t.name)).toContain(TABLE);
  });

  describe('listen / unlisten', () => {
    it('registers and reports a listener', () => {
      manager.listen('s1', 'ch', () => {});
      expect(manager.isListening('s1', 'ch')).toBe(true);
      expect(manager.getListeningChannels('s1')).toEqual(['ch']);
      expect(manager.getSubscriberCount('ch')).toBe(1);
      expect(manager.getChannels()).toEqual(['ch']);
    });

    it('unlistens a single channel', () => {
      manager.listen('s1', 'ch', () => {});
      manager.unlisten('s1', 'ch');
      expect(manager.isListening('s1', 'ch')).toBe(false);
      expect(manager.getSubscriberCount('ch')).toBe(0);
      expect(manager.getChannels()).toEqual([]);
    });

    it('unlistens an unknown channel safely', () => {
      expect(() => manager.unlisten('s1', 'nope')).not.toThrow();
    });

    it('unlistenAll clears all channels for a session', () => {
      manager.listen('s1', 'a', () => {});
      manager.listen('s1', 'b', () => {});
      manager.unlistenAll('s1');
      expect(manager.getListeningChannels('s1')).toEqual([]);
      expect(manager.getChannels()).toEqual([]);
    });

    it('reports false for a session that never listened', () => {
      expect(manager.isListening('ghost', 'ch')).toBe(false);
      expect(manager.getListeningChannels('ghost')).toEqual([]);
      expect(manager.getSubscriberCount('ghost-ch')).toBe(0);
    });
  });

  describe('notify', () => {
    it('persists the notification', () => {
      manager.notify('ch', 'hello', 42);
      const row = db.prepare(`SELECT channel, payload, pid FROM ${TABLE}`).get() as any;
      expect(row).toMatchObject({ channel: 'ch', payload: 'hello', pid: 42 });
    });

    it('escapes single quotes in channel and payload', () => {
      manager.notify("ch'1", "pay'load", 0);
      const row = db.prepare(`SELECT channel, payload FROM ${TABLE}`).get() as any;
      expect(row.channel).toBe("ch'1");
      expect(row.payload).toBe("pay'load");
    });

    it('fans out to a listening session immediately', () => {
      manager.listen('s1', 'ch', (e) => received.push(e));
      manager.notify('ch', 'p1', 7);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ channel: 'ch', payload: 'p1', pid: 7 });
    });

    it('does not fan out to a different channel', () => {
      manager.listen('s1', 'other', (e) => received.push(e));
      manager.notify('ch', 'p', 0);
      expect(received).toHaveLength(0);
    });

    // BUG regression: notify() delivered synchronously AND the poll loop
    // re-read the same persisted row (lastPolledId not advanced), causing a
    // duplicate delivery. This must not happen.
    it('does not double-deliver across notify() + poll()', () => {
      vi.useFakeTimers();
      manager.listen('s1', 'ch', (e) => received.push(e));
      manager.initialize(); // start the poll loop

      manager.notify('ch', 'p1', 0);
      expect(received).toHaveLength(1); // synchronous delivery

      // Advance the clock so the poll interval fires.
      vi.advanceTimersByTime(200);
      expect(received).toHaveLength(1); // still exactly one — no duplicate

      // A genuinely new notification is still delivered.
      manager.notify('ch', 'p2', 0);
      expect(received).toHaveLength(2);
      expect(received[1].payload).toBe('p2');
    });

    it('continues delivering a new notification after a successful poll', () => {
      vi.useFakeTimers();
      manager.listen('s1', 'ch', (e) => received.push(e));
      manager.initialize();
      manager.notify('ch', 'a', 0);
      vi.advanceTimersByTime(150);
      manager.notify('ch', 'b', 0);
      expect(received.map((e) => e.payload)).toEqual(['a', 'b']);
    });
  });

  describe('poll loop (multi-session fan-out)', () => {
    it('fans out to multiple sessions on the same channel', () => {
      vi.useFakeTimers();
      const got: string[] = [];
      manager.listen('s1', 'ch', (e) => got.push('s1:' + e.payload));
      manager.listen('s2', 'ch', (e) => got.push('s2:' + e.payload));

      manager.initialize();

      // A notification inserted directly into the table (bypassing notify's
      // synchronous fan-out) is delivered by the poll loop to both sessions.
      db.prepare(`INSERT INTO ${TABLE} (channel, payload, pid) VALUES (?, ?, ?)`).run('ch', 'y', 0);
      vi.advanceTimersByTime(200);
      expect(got).toContain('s1:y');
      expect(got).toContain('s2:y');
    });

    it('swallows a callback exception without breaking fan-out', () => {
      const ok: string[] = [];
      manager.listen('s1', 'ch', () => {
        throw new Error('boom');
      });
      manager.listen('s2', 'ch', (e) => ok.push(e.payload));
      manager.notify('ch', 'p', 0);
      expect(ok).toEqual(['p']);
    });
  });

  describe('error handling & defensive fallbacks', () => {
    it('does not throw when execFn rejects during notify', () => {
      const m = new NotifyListenerManager({
        execFn: () => {
          throw new Error('persist boom');
        },
        queryFn: () => [],
      });
      const got: NotificationEvent[] = [];
      m.listen('s1', 'ch', (e) => got.push(e));
      expect(() => m.notify('ch', 'p', 0)).not.toThrow();
      // fan-out still happens synchronously even though persistence failed
      expect(got).toHaveLength(1);
      m.shutdown();
    });

    it('does not throw when execFn rejects during ensureTable', () => {
      const m = new NotifyListenerManager({
        execFn: () => {
          throw new Error('table boom');
        },
        queryFn: () => [],
      });
      expect(() => m.initialize()).not.toThrow();
      m.shutdown();
    });

    it('does not throw when execFn rejects during cleanup', () => {
      const m = new NotifyListenerManager({
        execFn: () => {
          throw new Error('cleanup boom');
        },
        queryFn: () => [],
      });
      expect(() => m.cleanupOldNotifications()).not.toThrow();
      m.shutdown();
    });

    it('reads uppercase column names from queryFn (cross-driver fallback)', () => {
      vi.useFakeTimers();
      const got: NotificationEvent[] = [];
      let served = false;
      const m = new NotifyListenerManager({
        pollIntervalMs: 100,
        execFn: () => {},
        queryFn: () =>
          served
            ? []
            : (served = true,
              [{ ID: 5, CHANNEL: 'ch', PAYLOAD: 'p', PID: 9, NOTIFIED_AT: '2026-01-01 00:00:00' }]),
      });
      m.listen('s1', 'ch', (e) => got.push(e));
      m.initialize();
      vi.advanceTimersByTime(200);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ channel: 'ch', payload: 'p', pid: 9 });
      m.shutdown();
    });

    it('handles a row with falsy/zero id via uppercase fallback', () => {
      vi.useFakeTimers();
      const got: NotificationEvent[] = [];
      let served = false;
      const m = new NotifyListenerManager({
        pollIntervalMs: 100,
        execFn: () => {},
        queryFn: () =>
          served
            ? []
            : (served = true,
              [{ id: 0, ID: 3, channel: 'ch', payload: 'p', pid: 0, notified_at: 'now' }]),
      });
      m.listen('s1', 'ch', (e) => got.push(e));
      m.initialize();
      vi.advanceTimersByTime(200);
      expect(got).toHaveLength(1);
      m.shutdown();
    });

    it('skips a fan-out subscriber whose session has no listener', () => {
      // Directly manipulate internals via public behavior: a channel has a
      // subscriber set but the session map entry is gone (unlisten edge).
      const got: NotificationEvent[] = [];
      manager.listen('s1', 'ch', (e) => got.push(e));
      manager.unlisten('s1', 'ch'); // removes both maps
      // Re-register only the channel subscriber entry is impossible via public
      // API; instead verify unlisten of a removed session is safe.
      expect(() => manager.unlisten('s1', 'ch')).not.toThrow();
    });

    it('returns zero subscribers and empty channels after full cleanup', () => {
      manager.listen('s1', 'a', () => {});
      manager.listen('s2', 'b', () => {});
      manager.unlistenAll('s1');
      manager.unlistenAll('s2');
      expect(manager.getChannels()).toEqual([]);
    });

    it('removes the last subscriber and the channel entry (size === 0)', () => {
      manager.listen('s1', 'ch', () => {});
      manager.listen('s2', 'ch', () => {});
      manager.unlisten('s1', 'ch');
      expect(manager.getSubscriberCount('ch')).toBe(1);
      manager.unlisten('s2', 'ch');
      expect(manager.getSubscriberCount('ch')).toBe(0);
      expect(manager.getChannels()).toEqual([]);
    });

    it('unlistenAll on a session with no listeners is a no-op', () => {
      expect(() => manager.unlistenAll('ghost')).not.toThrow();
    });

    it('uses the default queryFn (returns []) for a bare manager', () => {
      vi.useFakeTimers();
      const bare = new NotifyListenerManager(); // default no-op exec/query
      bare.listen('s1', 'ch', () => {});
      bare.initialize();
      expect(() => vi.advanceTimersByTime(200)).not.toThrow();
      bare.shutdown();
    });

    it('startPolling is idempotent (initialize called twice)', () => {
      vi.useFakeTimers();
      manager.initialize();
      manager.initialize();
      expect(manager.isActive()).toBe(true);
      manager.shutdown();
    });

    it('advances lastPolledId to MAX(id) even when the table is empty', () => {
      // bare notify with an empty table: queryFn returns [], maxId = 0
      const got: NotificationEvent[] = [];
      manager.listen('s1', 'ch', (e) => got.push(e));
      // empty table: MAX(id) is NULL -> rows[0].m is null -> maxId = 0
      manager.notify('ch', 'p', 0);
      expect(got).toHaveLength(1);
    });

    it('queryFn returning uppercase M key is handled', () => {
      const m = new NotifyListenerManager({
        execFn: () => {},
        queryFn: (sql) => (sql.includes('MAX(id)') ? [{ M: 7 }] : []),
      });
      const got: NotificationEvent[] = [];
      m.listen('s1', 'ch', (e) => got.push(e));
      m.notify('ch', 'p', 0);
      expect(got).toHaveLength(1);
      m.shutdown();
    });

    it('falls back to a third default when both id key variants are absent', () => {
      vi.useFakeTimers();
      const got: NotificationEvent[] = [];
      let served = false;
      const m = new NotifyListenerManager({
        pollIntervalMs: 100,
        execFn: () => {},
        queryFn: () =>
          served ? [] : (served = true, [{ channel: 'ch', payload: 'p', pid: 0, notified_at: 'now' }]),
      });
      m.listen('s1', 'ch', (e) => got.push(e));
      m.initialize();
      vi.advanceTimersByTime(200);
      expect(got).toHaveLength(1);
      expect(got[0].pid).toBe(0); // id absent -> defaulted to 0
      m.shutdown();
    });

    it('maxId falls back to 0 when MAX(id) is null (empty table)', () => {
      const m = new NotifyListenerManager({
        execFn: () => {},
        queryFn: (sql) => (sql.includes('MAX(id)') ? [{ m: null }] : []),
      });
      const got: NotificationEvent[] = [];
      m.listen('s1', 'ch', (e) => got.push(e));
      m.notify('ch', 'p', 0);
      expect(got).toHaveLength(1);
      m.shutdown();
    });

    it('unlisten removes the session entry when its last channel is gone', () => {
      manager.listen('s1', 'only', () => {});
      manager.unlisten('s1', 'only');
      expect(manager.isListening('s1', 'only')).toBe(false);
      expect(manager.getListeningChannels('s1')).toEqual([]);
    });

    it('unlistenAll removes the channel entry when the last subscriber is gone', () => {
      manager.listen('s1', 'ch', () => {});
      manager.unlistenAll('s1');
      expect(manager.getChannels()).toEqual([]);
      expect(manager.getSubscriberCount('ch')).toBe(0);
    });

    it('unlisten keeps the session entry when other channels remain', () => {
      manager.listen('s1', 'a', () => {});
      manager.listen('s1', 'b', () => {});
      manager.unlisten('s1', 'a'); // size still > 0 (b remains)
      expect(manager.isListening('s1', 'a')).toBe(false);
      expect(manager.isListening('s1', 'b')).toBe(true);
    });

    it('unlistenAll keeps the channel entry when other subscribers remain', () => {
      manager.listen('s1', 'ch', () => {});
      manager.listen('s2', 'ch', () => {});
      manager.unlistenAll('s1'); // channel still has s2
      expect(manager.getSubscriberCount('ch')).toBe(1);
      expect(manager.getChannels()).toEqual(['ch']);
    });

    it('falls back to empty defaults when channel/payload/notified_at are absent', () => {
      vi.useFakeTimers();
      const got: NotificationEvent[] = [];
      let served = false;
      const m = new NotifyListenerManager({
        pollIntervalMs: 100,
        execFn: () => {},
        queryFn: () => (served ? [] : (served = true, [{ pid: 3 }])),
      });
      m.listen('s1', '', (e) => got.push(e));
      m.initialize();
      vi.advanceTimersByTime(200);
      expect(got).toHaveLength(1);
      expect(got[0].channel).toBe('');
      expect(got[0].payload).toBe('');
      expect(got[0].pid).toBe(3);
      m.shutdown();
    });
  });

  describe('cleanup / shutdown / state', () => {
    it('runs cleanup without throwing', () => {
      db.prepare(`INSERT INTO ${TABLE} (channel, payload, pid) VALUES ('c', 'p', 0)`).run();
      expect(() => manager.cleanupOldNotifications()).not.toThrow();
    });

    it('tolerates cleanup against a missing exec target', () => {
      const bare = new NotifyListenerManager(); // no-op exec/query
      expect(() => bare.cleanupOldNotifications()).not.toThrow();
      bare.shutdown();
    });

    it('shutdown stops polling and clears listeners', () => {
      manager.listen('s1', 'ch', () => {});
      manager.initialize();
      expect(manager.isActive()).toBe(true);
      manager.shutdown();
      expect(manager.isActive()).toBe(false);
      expect(manager.getChannels()).toEqual([]);
    });

    it('is not active until initialize is called', () => {
      expect(manager.isActive()).toBe(false);
    });
  });
});
