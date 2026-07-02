/**
 * NotifyListener — PostgreSQL NOTIFY/LISTEN persistence layer.
 *
 * PostgreSQL's NOTIFY/LISTEN provides asynchronous channel-based
 * messaging between sessions. This module extends that with persistence:
 *
 * Features:
 *   - _sqlvec_notifications table for persistent notification storage
 *   - NOTIFY channel, payload → writes to table + triggers EventBus
 *   - LISTEN channel → registers session-level callback
 *   - UNLISTEN channel → removes callback registration
 *   - Background polling of _sqlvec_notifications (every 100ms)
 *   - Notification fan-out to all listening sessions
 *
 * Schema:
 *   _sqlvec_notifications (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     channel TEXT NOT NULL,
 *     payload TEXT,
 *     pid INTEGER,
 *     notified_at TEXT NOT NULL DEFAULT (datetime('now'))
 *   )
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('NotifyListener');

// ── Constants ────────────────────────────────────────────────────

/** System table for persistent notifications */
const NOTIFICATIONS_TABLE = '_sqlvec_notifications';

/** Polling interval in ms */
const POLL_INTERVAL_MS = 100;

/** Maximum age of notifications to keep (in seconds) */
const NOTIFICATION_TTL_SECONDS = 86400; // 24 hours

// ── Types ────────────────────────────────────────────────────────

export interface NotificationEvent {
  channel: string;
  payload: string;
  pid: number;
  notifiedAt: Date;
}

export interface ListenCallback {
  sessionId: string;
  channel: string;
  callback: (event: NotificationEvent) => void;
}

export interface NotifyListenerOptions {
  /** Polling interval in ms (default: 100) */
  pollIntervalMs?: number;
  /** Execute function (for persistence to SQLite) */
  execFn?: (sql: string) => void;
  /** Query function for polling */
  queryFn?: (sql: string) => any[];
}

// ── NotifyListenerManager ────────────────────────────────────────

export class NotifyListenerManager {
  private execFn: (sql: string) => void;
  private queryFn: (sql: string) => any[];
  private pollIntervalMs: number;

  /** Registered listeners: sessionId -> { channel -> callback } */
  private listeners: Map<string, Map<string, (event: NotificationEvent) => void>> = new Map();
  /** channel -> Set<sessionId> for fast fan-out */
  private channelSubscribers: Map<string, Set<string>> = new Map();

  /** Polling state */
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPolledId: number = 0;
  private isRunning: boolean = false;

  constructor(opts?: NotifyListenerOptions) {
    this.execFn = opts?.execFn || ((sql: string) => { /* no-op */ });
    this.queryFn = opts?.queryFn || (() => []);
    this.pollIntervalMs = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;

    // Ensure the notifications table exists
    this.ensureTable();
  }

  /**
   * Initialize the notifications table and start polling.
   */
  initialize(): void {
    this.ensureTable();
    this.startPolling();
    this.isRunning = true;
    logger.info({ pollIntervalMs: this.pollIntervalMs }, 'NotifyListenerManager initialized with polling');
  }

  /**
   * Create the _sqlvec_notifications table if it doesn't exist.
   */
  private ensureTable(): void {
    try {
      this.execFn(`
        CREATE TABLE IF NOT EXISTS ${NOTIFICATIONS_TABLE} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          payload TEXT DEFAULT '',
          pid INTEGER DEFAULT 0,
          notified_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      logger.debug('Notifications table ensured');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to create notifications table');
    }
  }

  /**
   * Start background polling loop.
   */
  private startPolling(): void {
    if (this.pollingTimer) return;

    this.pollingTimer = setInterval(() => {
      this.pollNotifications();
    }, this.pollIntervalMs);

    logger.debug('Notification polling started');
  }

  /**
   * Stop background polling.
   */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.isRunning = false;
    logger.debug('Notification polling stopped');
  }

  /**
   * Poll for new notifications and fan-out to listeners.
   */
  private pollNotifications(): void {
    try {
      const rows = this.queryFn(
        `SELECT id, channel, payload, pid, notified_at FROM ${NOTIFICATIONS_TABLE} WHERE id > ${this.lastPolledId} ORDER BY id ASC`,
      );

      for (const row of rows) {
        const id = Number(row.id || row.ID || 0);
        const event: NotificationEvent = {
          channel: String(row.channel || row.CHANNEL || ''),
          payload: String(row.payload || row.PAYLOAD || ''),
          pid: Number(row.pid || row.PID || 0),
          notifiedAt: new Date(String(row.notified_at || row.NOTIFIED_AT || Date.now())),
        };

        this.lastPolledId = Math.max(this.lastPolledId, id);
        this.fanOut(event);
      }
    } catch (err: any) {
      // Silently ignore polling errors (table may not exist yet)
    }
  }

  /**
   * Fan-out a notification event to all subscribers of the channel.
   */
  private fanOut(event: NotificationEvent): void {
    const subscribers = this.channelSubscribers.get(event.channel);
    if (!subscribers) return;

    for (const sessionId of subscribers) {
      const sessionListeners = this.listeners.get(sessionId);
      if (!sessionListeners) continue;

      const callback = sessionListeners.get(event.channel);
      if (callback) {
        try {
          callback(event);
        } catch (err: any) {
          logger.error({ err: err.message, sessionId, channel: event.channel }, 'Notification callback error');
        }
      }
    }
  }

  // ── LISTEN/UNLISTEN API ──────────────────────

  /**
   * Register a listener on a channel.
   * Corresponds to `LISTEN channel`.
   *
   * @param sessionId - The session/connection ID
   * @param channel - Channel name
   * @param callback - Function to call when notification arrives
   */
  listen(
    sessionId: string,
    channel: string,
    callback: (event: NotificationEvent) => void,
  ): void {
    // Register session-level listener
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Map());
    }
    this.listeners.get(sessionId)!.set(channel, callback);

    // Register channel subscription
    if (!this.channelSubscribers.has(channel)) {
      this.channelSubscribers.set(channel, new Set());
    }
    this.channelSubscribers.get(channel)!.add(sessionId);

    logger.debug({ sessionId, channel }, 'LISTEN registered');
  }

  /**
   * Unregister a listener from a channel.
   * Corresponds to `UNLISTEN channel`.
   */
  unlisten(sessionId: string, channel: string): void {
    const sessionListeners = this.listeners.get(sessionId);
    if (sessionListeners) {
      sessionListeners.delete(channel);
      if (sessionListeners.size === 0) {
        this.listeners.delete(sessionId);
      }
    }

    const subscribers = this.channelSubscribers.get(channel);
    if (subscribers) {
      subscribers.delete(sessionId);
      if (subscribers.size === 0) {
        this.channelSubscribers.delete(channel);
      }
    }

    logger.debug({ sessionId, channel }, 'UNLISTEN completed');
  }

  /**
   * Unregister all listeners for a session.
   * Called when a connection is closed.
   */
  unlistenAll(sessionId: string): void {
    const sessionListeners = this.listeners.get(sessionId);
    if (sessionListeners) {
      for (const channel of sessionListeners.keys()) {
        const subscribers = this.channelSubscribers.get(channel);
        if (subscribers) {
          subscribers.delete(sessionId);
          if (subscribers.size === 0) {
            this.channelSubscribers.delete(channel);
          }
        }
      }
      this.listeners.delete(sessionId);
    }
    logger.debug({ sessionId }, 'All LISTEN registrations cleared');
  }

  // ── NOTIFY API ────────────────────────────────

  /**
   * Send a notification on a channel.
   * Corresponds to `NOTIFY channel, payload`.
   *
   * Writes to the persistent _sqlvec_notifications table and immediately
   * fans out to all listening sessions.
   *
   * @param channel - Channel name
   * @param payload - Notification payload (empty string if none)
   * @param pid - Source PID (0 if unknown)
   */
  notify(channel: string, payload: string = '', pid: number = 0): void {
    // Persist to table
    const escapedChannel = channel.replace(/'/g, "''");
    const escapedPayload = payload.replace(/'/g, "''");
    const sql = `INSERT INTO ${NOTIFICATIONS_TABLE} (channel, payload, pid) VALUES ('${escapedChannel}', '${escapedPayload}', ${pid})`;

    try {
      this.execFn(sql);
      logger.debug({ channel, payload, pid }, 'NOTIFY persisted');
    } catch (err: any) {
      logger.error({ err: err.message, channel }, 'NOTIFY persistence failed');
    }

    // Create in-memory event and fan-out immediately
    const event: NotificationEvent = {
      channel,
      payload,
      pid,
      notifiedAt: new Date(),
    };
    this.fanOut(event);
  }

  // ── Utility ───────────────────────────────────

  /**
   * Check if a session is listening on a channel.
   */
  isListening(sessionId: string, channel: string): boolean {
    const sessionListeners = this.listeners.get(sessionId);
    return sessionListeners ? sessionListeners.has(channel) : false;
  }

  /**
   * Get all channels a session is listening on.
   */
  getListeningChannels(sessionId: string): string[] {
    const sessionListeners = this.listeners.get(sessionId);
    return sessionListeners ? Array.from(sessionListeners.keys()) : [];
  }

  /**
   * Get the number of subscribers for a channel.
   */
  getSubscriberCount(channel: string): number {
    const subscribers = this.channelSubscribers.get(channel);
    return subscribers ? subscribers.size : 0;
  }

  /**
   * Get all registered channels.
   */
  getChannels(): string[] {
    return Array.from(this.channelSubscribers.keys());
  }

  /**
   * Clean up old notifications (TTL-based).
   */
  cleanupOldNotifications(): number {
    try {
      this.execFn(
        `DELETE FROM ${NOTIFICATIONS_TABLE} WHERE notified_at < datetime('now', '-${NOTIFICATION_TTL_SECONDS} seconds')`,
      );
      logger.debug('Old notifications cleaned up');
      return 0;
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to clean up old notifications');
      return 0;
    }
  }

  /**
   * Shutdown — stop polling and clear listeners.
   */
  shutdown(): void {
    this.stopPolling();
    this.listeners.clear();
    this.channelSubscribers.clear();
    this.isRunning = false;
    logger.info('NotifyListenerManager shut down');
  }

  /**
   * Check if polling is running.
   */
  isActive(): boolean {
    return this.isRunning;
  }
}
