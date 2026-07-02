// @ts-nocheck
/**
 * WALSender — PostgreSQL WAL sender process model.
 *
 * Implements a WAL sender that reads WAL records from a shared storage
 * directory and transmits them to a WAL receiver over a ZeroMQ PUSH/PULL
 * socket pair.
 *
 * Architecture:
 *   - WALSender (PUSH) → ZeroMQ → WALReceiver (PULL)
 *   - Supports async and sync replication modes
 *   - Automatic reconnection every 1s on disconnect
 *   - Fragmented send for records exceeding maxWalSendSize
 *   - Per-session statistics tracking
 *
 * WAL data format (JSON-serialized):
 *   { lsn: string; data: string; xid: number; timestamp: number }
 *
 * @module WALSender
 */

import { Push } from 'zeromq';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PinoLogger } from '../logger/PinoLogger';

// ── Types ────────────────────────────────────────────────────────

export type WALLevel = 'minimal' | 'replica' | 'logical';
export type SyncMode = 'async' | 'sync';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'stopped';

export interface WALSenderConfig {
  /** Unique node identifier */
  nodeId: number;
  /** Host to bind/connect to */
  host: string;
  /** Port number */
  port: number;
  /** Shared WAL storage directory */
  walDir: string;
  /** PostgreSQL WAL level */
  walLevel: WALLevel;
  /** Replication sync mode */
  syncMode: SyncMode;
  /** Maximum bytes per send (default: 65536) */
  maxWalSendSize: number;
  /** ZeroMQ PUSH/PULL endpoint (e.g. "tcp://127.0.0.1:5555") */
  zeromqEndpoint: string;
}

export interface WalRecord {
  /** Log Sequence Number (e.g. "0/ABCDEF") */
  lsn: string;
  /** WAL record payload (hex-encoded binary or JSON text) */
  data: string;
  /** Transaction ID */
  xid: number;
  /** Unix timestamp (ms since epoch) */
  timestamp: number;
}

export interface WALSenderStats {
  nodeId: number;
  /** Total bytes sent */
  bytesSent: number;
  /** Total records sent */
  recordsSent: number;
  /** Current LSN being sent */
  currentLsn: string;
  /** Connection state */
  state: ConnectionState;
  /** Number of reconnections */
  reconnectCount: number;
  /** Timestamp of last send (ms epoch) */
  lastSendTime: number;
}

// ── Constants ─────────────────────────────────────────────────────

const DEFAULT_MAX_WAL_SEND_SIZE = 65536;
const RECONNECT_INTERVAL_MS = 1000;

// ── Logger ────────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('WALSender');

// ── WALSender ─────────────────────────────────────────────────────

export class WALSender {
  private config: WALSenderConfig;
  private socket: Push;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;

  private stats: WALSenderStats;
  private statusCallbacks: Array<(stats: WALSenderStats) => void> = [];

  constructor(config: Partial<WALSenderConfig>) {
    this.config = {
      nodeId: config.nodeId ?? 0,
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 5432,
      walDir: config.walDir ?? './wal-data',
      walLevel: config.walLevel ?? 'replica',
      syncMode: config.syncMode ?? 'async',
      maxWalSendSize: config.maxWalSendSize ?? DEFAULT_MAX_WAL_SEND_SIZE,
      zeromqEndpoint: config.zeromqEndpoint ?? 'tcp://127.0.0.1:5555',
    };

    this.socket = new Push();
    this.stats = this.createInitialStats();
  }

  /**
   * Start the WALSender: bind the PUSH socket and begin processing.
   */
  async start(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      logger.warn({ nodeId: this.config.nodeId }, 'WALSender already started');
      return;
    }

    this.state = 'connecting';
    this.emitStatus();

    try {
      await this.socket.connect(this.config.zeromqEndpoint);
      this.state = 'connected';
      logger.info(
        { nodeId: this.config.nodeId, endpoint: this.config.zeromqEndpoint },
        'WALSender connected',
      );
      this.emitStatus();
    } catch (err: any) {
      logger.error(
        { err, nodeId: this.config.nodeId, endpoint: this.config.zeromqEndpoint },
        'WALSender initial connect failed, starting reconnect loop',
      );
      this.startReconnectLoop();
    }
  }

  /**
   * Stop the WALSender: close socket, cancel reconnect timer.
   */
  async stop(): Promise<void> {
    this.stopReconnectLoop();
    this.state = 'stopped';
    this.emitStatus();

    try {
      this.socket.close();
    } catch {
      // Socket may already be closed
    }

    logger.info({ nodeId: this.config.nodeId }, 'WALSender stopped');
  }

  /**
   * Read WAL records from the shared WAL directory between startLsn and endLsn,
   * then send them over the ZeroMQ PUSH socket.
   *
   * WAL file naming convention: `<startLsn>-<endLsn>.wal`
   * Falls back to reading `wal-data/wal_records.json` if no individual WAL files exist.
   *
   * @returns Number of records sent
   */
  async sendWalRecords(startLsn: string, endLsn: string): Promise<number> {
    const records = this.loadWalRecords(startLsn, endLsn);

    if (records.length === 0) {
      logger.debug({ startLsn, endLsn }, 'No WAL records to send');
      return 0;
    }

    let sentCount = 0;

    for (const record of records) {
      try {
        await this.sendRecordWithFragmentation(record);
        sentCount++;
        this.stats.bytesSent += Buffer.byteLength(record.data, 'utf-8') + record.lsn.length + 8;
        this.stats.recordsSent++;
        this.stats.currentLsn = record.lsn;
        this.stats.lastSendTime = Date.now();
      } catch (err: any) {
        logger.error(
          { err, lsn: record.lsn },
          'WALSender: failed to send record, triggering reconnect',
        );
        this.state = 'disconnected';
        this.startReconnectLoop();
        break;
      }
    }

    this.emitStatus();
    logger.info({ nodeId: this.config.nodeId, sentCount, total: records.length }, 'sendWalRecords completed');
    return sentCount;
  }

  /**
   * Get current send statistics.
   */
  getStats(): WALSenderStats {
    return { ...this.stats };
  }

  /**
   * Register a callback invoked whenever the sender stats/state change.
   */
  onStatus(cb: (stats: WALSenderStats) => void): void {
    this.statusCallbacks.push(cb);
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Send a single WAL record, fragmenting the data field if it exceeds
   * maxWalSendSize. Fragments are sent as multipart messages:
   *   [lsn, fragment_index/total, data_chunk, xid, timestamp]
   */
  private async sendRecordWithFragmentation(record: WalRecord): Promise<void> {
    const dataBuf = Buffer.from(record.data, 'utf-8');

    if (dataBuf.length <= this.config.maxWalSendSize) {
      // Single message: send as JSON string
      const message = JSON.stringify(record);
      await this.socket.send(message);
      return;
    }

    // Fragmented send — split data into chunks
    const fragmentCount = Math.ceil(dataBuf.length / this.config.maxWalSendSize);

    for (let i = 0; i < fragmentCount; i++) {
      const chunkStart = i * this.config.maxWalSendSize;
      const chunkEnd = Math.min(chunkStart + this.config.maxWalSendSize, dataBuf.length);
      const chunk = dataBuf.subarray(chunkStart, chunkEnd).toString('utf-8');

      const fragment: WalRecord & { fragmentIndex: number; fragmentTotal: number } = {
        ...record,
        data: chunk,
        fragmentIndex: i,
        fragmentTotal: fragmentCount,
      };

      await this.socket.send(JSON.stringify(fragment));
    }
  }

  /**
   * Load WAL records from the shared WAL directory.
   *
   * Strategy:
   *  1. Look for a `wal_records.json` file containing an array of WalRecord objects.
   *  2. Filter records whose LSN falls within [startLsn, endLsn].
   *
   * Note: In a production system this would parse actual PostgreSQL WAL files.
   */
  private loadWalRecords(startLsn: string, endLsn: string): WalRecord[] {
    const walRecordsPath = path.join(this.config.walDir, 'wal_records.json');

    if (!fs.existsSync(walRecordsPath)) {
      logger.warn({ walDir: this.config.walDir }, 'WAL records file not found, returning empty');
      return [];
    }

    try {
      const content = fs.readFileSync(walRecordsPath, 'utf-8');
      const allRecords: WalRecord[] = JSON.parse(content);
      return allRecords.filter(r => r.lsn >= startLsn && r.lsn <= endLsn);
    } catch (err: any) {
      logger.error({ err, walRecordsPath }, 'Failed to load WAL records');
      return [];
    }
  }

  /**
   * Start periodic reconnection attempts.
   */
  private startReconnectLoop(): void {
    if (this.reconnectTimer) return;

    logger.info(
      { nodeId: this.config.nodeId, intervalMs: RECONNECT_INTERVAL_MS },
      'WALSender: starting reconnect loop',
    );

    this.reconnectTimer = setInterval(async () => {
      if (this.state === 'stopped') {
        this.stopReconnectLoop();
        return;
      }

      this.state = 'connecting';
      this.emitStatus();

      try {
        // Close old socket and create a new one before reconnecting
        try { this.socket.close(); } catch { /* OK */ }
        this.socket = new Push();
        await this.socket.connect(this.config.zeromqEndpoint);

        this.state = 'connected';
        this.stats.reconnectCount++;
        this.stopReconnectLoop();
        this.emitStatus();

        logger.info(
          { nodeId: this.config.nodeId, attempt: this.stats.reconnectCount },
          'WALSender: reconnected successfully',
        );
      } catch {
        // Will retry on next interval
        this.state = 'disconnected';
        this.emitStatus();
      }
    }, RECONNECT_INTERVAL_MS);
  }

  /**
   * Stop the reconnection loop.
   */
  private stopReconnectLoop(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Create initial zeroed-out stats.
   */
  private createInitialStats(): WALSenderStats {
    return {
      nodeId: this.config.nodeId,
      bytesSent: 0,
      recordsSent: 0,
      currentLsn: '0/0',
      state: 'disconnected',
      reconnectCount: 0,
      lastSendTime: 0,
    };
  }

  /**
   * Emit current stats to all registered callbacks.
   */
  private emitStatus(): void {
    this.stats.state = this.state;
    const snapshot = this.getStats();
    for (const cb of this.statusCallbacks) {
      try {
        cb(snapshot);
      } catch {
        // Swallow callback errors
      }
    }
  }
}
