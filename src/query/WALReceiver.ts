/**
 * WALReceiver — PostgreSQL WAL receiver process model.
 *
 * Implements a WAL receiver that listens on a ZeroMQ PULL socket for incoming
 * WAL records transmitted by a WALSender, and writes them to local storage.
 *
 * Architecture:
 *   - WALSender (PUSH) → ZeroMQ → WALReceiver (PULL)
 *   - Records are received and written to a local WAL file
 *   - Supports fragment reassembly for records split across multiple messages
 *   - Optional per-record callback for stream processing
 *
 * WAL data format (JSON-serialized):
 *   { lsn: string; data: string; xid: number; timestamp: number }
 *
 * For fragmented records:
 *   { ..., fragmentIndex: number, fragmentTotal: number }
 *
 * @module WALReceiver
 */

import { Pull } from 'zeromq';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PinoLogger } from '../logger/PinoLogger';
import { WalRecord } from './WALSender';

// ── Types ────────────────────────────────────────────────────────

export type WALReceiverState = 'idle' | 'running' | 'stopped';

export interface WALReceiverConfig {
  /** Unique node identifier */
  nodeId: number;
  /** ZeroMQ PULL endpoint to bind to (e.g. "tcp://*:5555") */
  zeromqEndpoint: string;
  /** Directory to write received WAL files */
  walDir: string;
  /** Name of the output WAL file (default: "received_wal.log") */
  walFileName?: string;
}

export interface WALReceiverStats {
  nodeId: number;
  /** Total bytes received */
  bytesReceived: number;
  /** Total records received */
  recordsReceived: number;
  /** Last received LSN */
  lastLsn: string;
  /** Current receiver state */
  state: WALReceiverState;
  /** Number of fragments reassembled */
  fragmentsReassembled: number;
  /** Timestamp of last receive (ms epoch) */
  lastReceiveTime: number;
}

// ── Fragment buffer types ────────────────────────────────────────

interface FragmentBufferEntry {
  fragments: Map<number, string>;
  fragmentTotal: number;
  lsn: string;
  xid: number;
  timestamp: number;
  receivedAt: number;
}

// ── Logger ────────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('WALReceiver');

// ── WALReceiver ───────────────────────────────────────────────────

export class WALReceiver {
  private config: WALReceiverConfig;
  private socket: Pull;
  private state: WALReceiverState = 'idle';
  private running = false;

  private stats: WALReceiverStats;
  private walCallbacks: Array<(record: WalRecord) => void> = [];

  /** Buffer for incomplete fragmented records, keyed by LSN */
  private fragmentBuffer: Map<string, FragmentBufferEntry> = new Map();

  /**
   * Timeout for stale fragments (default: 30s).
   * Fragments not completed within this window are discarded.
   */
  private fragmentTimeoutMs: number;

  constructor(config: Partial<WALReceiverConfig>) {
    this.config = {
      nodeId: config.nodeId ?? 1,
      zeromqEndpoint: config.zeromqEndpoint ?? 'tcp://*:5555',
      walDir: config.walDir ?? './wal-data',
      walFileName: config.walFileName ?? 'received_wal.log',
    };

    this.socket = new Pull();
    this.stats = this.createInitialStats();
    this.fragmentTimeoutMs = 30_000;
  }

  /**
   * Start the WALReceiver: bind the PULL socket and begin listening.
   */
  async start(): Promise<void> {
    if (this.state === 'running') {
      logger.warn({ nodeId: this.config.nodeId }, 'WALReceiver already running');
      return;
    }

    this.state = 'running';
    this.running = true;
    this.emitStatus();

    try {
      await this.socket.bind(this.config.zeromqEndpoint);
      logger.info(
        { nodeId: this.config.nodeId, endpoint: this.config.zeromqEndpoint },
        'WALReceiver bound and listening',
      );
    } catch (err: any) {
      this.state = 'stopped';
      this.running = false;
      this.emitStatus();
      logger.error(
        { err, endpoint: this.config.zeromqEndpoint },
        'WALReceiver: failed to bind socket',
      );
      throw err;
    }
  }

  /**
   * Stop the WALReceiver: close socket and flush any pending data.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.state = 'stopped';
    this.emitStatus();

    // Flush stale fragments
    this.fragmentBuffer.clear();

    try {
      await this.socket.close();
    } catch {
      // Socket may already be closed
    }

    logger.info({ nodeId: this.config.nodeId }, 'WALReceiver stopped');
  }

  /**
   * Receive WAL records from the PULL socket and write them to the local WAL file.
   *
   * This method blocks until `stop()` is called. It:
   *  1. Reads a message from the ZeroMQ PULL socket
   *  2. Parses it as a WalRecord (or fragment)
   *  3. Reassembles fragments if necessary
   *  4. Writes complete records to the local WAL file
   *  5. Invokes registered callbacks
   *
   * Designed to run in its own async context (e.g. spawned as a Promise).
   */
  async receiveAndWrite(): Promise<void> {
    logger.info(
      { nodeId: this.config.nodeId },
      'WALReceiver: receiveAndWrite loop started',
    );

    while (this.running) {
      try {
        const [message] = await this.socket.receive();
        const raw = message.toString('utf-8');
        const parsed = JSON.parse(raw);

        // Check if this is a fragment
        if (parsed.fragmentIndex !== undefined && parsed.fragmentTotal !== undefined) {
          await this.handleFragment(parsed);
        } else {
          // Single (non-fragmented) record
          const record: WalRecord = {
            lsn: parsed.lsn,
            data: parsed.data,
            xid: parsed.xid,
            timestamp: parsed.timestamp,
          };
          await this.processRecord(record);
        }
      } catch (err: any) {
        if (!this.running) break;

        // If receive timeout (not a real error), just loop
        if (err.code === 'EAGAIN' || err.message?.includes('timeout')) {
          this.cleanStaleFragments();
          continue;
        }

        logger.error({ err, nodeId: this.config.nodeId }, 'WALReceiver: receive error');
        // Brief backoff before retry
        await this.sleep(100);
      }
    }

    logger.info(
      { nodeId: this.config.nodeId },
      'WALReceiver: receiveAndWrite loop ended',
    );
  }

  /**
   * Get current receive statistics.
   */
  getStats(): WALReceiverStats {
    return { ...this.stats };
  }

  /**
   * Register a callback invoked when a complete WAL record is received.
   */
  onWalRecord(cb: (record: WalRecord) => void): void {
    this.walCallbacks.push(cb);
  }

  /**
   * Set the timeout for stale fragment cleanup.
   */
  setFragmentTimeout(ms: number): void {
    this.fragmentTimeoutMs = ms;
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Handle a fragmented WAL record — accumulate parts and reassemble
   * when all fragments are received.
   */
  private async handleFragment(parsed: any): Promise<void> {
    const { lsn, fragmentIndex, fragmentTotal, xid, timestamp, data } = parsed;

    // Look up or create a fragment buffer entry
    let entry = this.fragmentBuffer.get(lsn);
    if (!entry) {
      entry = {
        fragments: new Map(),
        fragmentTotal,
        lsn,
        xid,
        timestamp,
        receivedAt: Date.now(),
      };
      this.fragmentBuffer.set(lsn, entry);
    }

    entry.fragments.set(fragmentIndex, data);

    // Check if all fragments received
    if (entry.fragments.size === entry.fragmentTotal) {
      // Reassemble
      const sortedIndices = Array.from(entry.fragments.keys()).sort((a, b) => a - b);
      const fullData = sortedIndices.map(idx => entry!.fragments.get(idx)).join('');

      const record: WalRecord = {
        lsn,
        data: fullData,
        xid,
        timestamp,
      };

      this.fragmentBuffer.delete(lsn);
      this.stats.fragmentsReassembled++;
      await this.processRecord(record);
    }
  }

  /**
   * Process a complete WAL record: write to local file and invoke callbacks.
   */
  private async processRecord(record: WalRecord): Promise<void> {
    // Write to local WAL file
    await this.appendToWalFile(record);

    // Update stats
    this.stats.bytesReceived += Buffer.byteLength(record.data, 'utf-8') + record.lsn.length + 8;
    this.stats.recordsReceived++;
    this.stats.lastLsn = record.lsn;
    this.stats.lastReceiveTime = Date.now();
    this.emitStatus();

    // Invoke callbacks
    for (const cb of this.walCallbacks) {
      try {
        cb(record);
      } catch {
        // Swallow callback errors
      }
    }

    logger.debug(
      { lsn: record.lsn, xid: record.xid },
      'WALReceiver: record processed',
    );
  }

  /**
   * Append a WAL record to the local WAL file as a JSON line.
   */
  private async appendToWalFile(record: WalRecord): Promise<void> {
    const walFilePath = path.join(this.config.walDir, this.config.walFileName!);

    // Ensure directory exists
    const dir = path.dirname(walFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(walFilePath, line, 'utf-8');
  }

  /**
   * Clean up stale fragment buffer entries that have exceeded the timeout.
   */
  private cleanStaleFragments(): void {
    const now = Date.now();
    for (const [lsn, entry] of this.fragmentBuffer.entries()) {
      if (now - entry.receivedAt > this.fragmentTimeoutMs) {
        logger.warn({ lsn, fragments: entry.fragments.size, total: entry.fragmentTotal },
          'WALReceiver: discarding stale fragment group');
        this.fragmentBuffer.delete(lsn);
      }
    }
  }

  /**
   * Create initial zeroed-out stats.
   */
  private createInitialStats(): WALReceiverStats {
    return {
      nodeId: this.config.nodeId,
      bytesReceived: 0,
      recordsReceived: 0,
      lastLsn: '0/0',
      state: 'idle',
      fragmentsReassembled: 0,
      lastReceiveTime: 0,
    };
  }

  /**
   * Emit current stats to registered status callbacks.
   */
  private emitStatus(): void {
    this.stats.state = this.state;
  }

  /**
   * Helper: sleep for a given number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
