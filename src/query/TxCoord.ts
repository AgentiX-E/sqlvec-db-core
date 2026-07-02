/**
 * TxCoord — Transaction Coordinator for SqlVec.
 *
 * Manages per-session transaction state:
 *  - TransactionContext (pending changes, savepoint stack)
 *  - BEGIN / SAVEPOINT / ROLLBACK TO SAVEPOINT / RELEASE SAVEPOINT
 *  - COMMIT (returns pending changes for external execution)
 *  - ROLLBACK (discards pending changes)
 *  - Idle-in-transaction timeout management
 *  - Hook callbacks for MVCC, deferred constraints, logging
 *
 * The actual execution of committed changes (shard targeting, raft proposal,
 * MVCC rewrite, WAL flush) remains in QueryRouter via callbacks.
 * TxCoord only owns the *what* (pending changes), not the *how* (execution).
 *
 * Implements TransactionCoordinator interface for Pipeline integration.
 */

import type { TransactionStatement } from './SqlParser';
import { PinoLogger } from '../monitoring/PinoLogger';
import { IdleTxnTimeoutManager, DEFAULT_IDLE_TXN_TIMEOUT_MS } from '../protocol/IdleTxnTimeout';
import type { TransactionCoordinator } from '../pipeline/types';

const logger = PinoLogger.forComponent('TxCoord');

// ── Transaction State ──

export interface PendingChange {
  sql: string;
  params?: any[];
}

export interface TransactionContext {
  sessionId: string;
  pendingChanges: PendingChange[];
  startedAt: number;
  savepointStack: string[];
  savepointIndexMap: Map<string, number>;
}

// ── Options / Hooks ──

export interface TxCoordHooks {
  /** Called when a transaction begins (for MVCC.begin, etc.) */
  onBegin?: (sessionId: string, isolationLevel?: string) => void;
  /** Called when a transaction commits, before pending changes are executed */
  onBeforeCommit?: (sessionId: string, pendingCount: number) => void;
  /** Called when transaction state is cleaned up post-commit */
  onCommitCleanup?: (sessionId: string) => void;
  /** Called when a transaction is rolled back (for MVCC.rollback, deferred reset) */
  onRollback?: (sessionId: string) => void;
  /** Called when idle-in-transaction timeout fires */
  onTimeout?: (sessionId: string) => void;
}

// ── TxCoord ──

export class TxCoord implements TransactionCoordinator {
  private transactions = new Map<string, TransactionContext>();
  private idleTxnTimeout?: IdleTxnTimeoutManager;
  private hooks: TxCoordHooks;

  constructor(hooks: TxCoordHooks = {}) {
    this.hooks = hooks;
  }

  /**
   * Initialize the idle-in-transaction timeout manager.
   * Must be called after construction to enable timeout tracking.
   */
  initIdleTimeout(timeoutMs: number = DEFAULT_IDLE_TXN_TIMEOUT_MS): void {
    if (this.idleTxnTimeout) {
      for (const sid of this.transactions.keys()) {
        this.idleTxnTimeout.cancelTimer(sid);
      }
    }
    this.idleTxnTimeout = new IdleTxnTimeoutManager(timeoutMs);
  }

  // ── Query methods ──

  hasTransaction(sessionId: string): boolean {
    return this.transactions.has(sessionId);
  }

  getTransaction(sessionId: string): TransactionContext | undefined {
    return this.transactions.get(sessionId);
  }

  getPendingChanges(sessionId: string): PendingChange[] | undefined {
    return this.transactions.get(sessionId)?.pendingChanges;
  }

  pendingChangeCount(sessionId: string): number {
    return this.transactions.get(sessionId)?.pendingChanges.length ?? 0;
  }

  get transactionCount(): number {
    return this.transactions.size;
  }

  /** Return all active session IDs for monitoring/debugging. */
  get activeSessionIds(): string[] {
    return [...this.transactions.keys()];
  }

  // ── Mutations ──

  /**
   * Begin a transaction. If already in one, it's a no-op (PG nested BEGIN).
   * Returns the command response.
   */
  _begin(sessionId: string, stmt?: TransactionStatement): BeginResult {
    const sid = sessionId || 'default';

    if (this.transactions.has(sid)) {
      return { message: 'BEGIN (already in transaction)', alreadyInTxn: true };
    }

    this.transactions.set(sid, {
      sessionId: sid,
      pendingChanges: [],
      startedAt: Date.now(),
      savepointStack: [],
      savepointIndexMap: new Map(),
    });

    this.hooks.onBegin?.(sid, (stmt as any)?.isolationLevel);

    // Start idle-in-transaction timeout
    if (this.idleTxnTimeout) {
      this.idleTxnTimeout.startTimer(sid, undefined, (timedOutSid) => {
        this.transactions.delete(timedOutSid);
        logger.warn({ sessionId: timedOutSid }, '[TxCoord] idle-in-transaction timeout — auto rollback');
        this.hooks.onTimeout?.(timedOutSid);
      });
    }

    return { message: 'BEGIN' };
  }

  /**
   * Savepoint: push a named savepoint onto the stack.
   */
  _savepoint(sessionId: string, name: string): void {
    const txn = this.transactions.get(sessionId);
    if (!txn) return;

    txn.savepointStack.push(name);
    txn.savepointIndexMap.set(name, txn.pendingChanges.length);
  }

  /**
   * Rollback to a named savepoint. Truncates pending changes added after it.
   * Returns the number of pending changes discarded.
   */
  _rollbackToSavepoint(sessionId: string, name: string): number {
    const txn = this.transactions.get(sessionId);
    if (!txn) return 0;

    const idx = txn.savepointIndexMap.get(name);
    if (idx === undefined) {
      logger.warn({ sessionId, savepoint: name }, '[TxCoord] savepoint not found');
      return 0;
    }

    const discarded = txn.pendingChanges.length - idx;
    txn.pendingChanges.length = idx;

    // Clean savepoints after this one
    this._pruneSavepointsAfter(txn, name);
    return discarded;
  }

  /**
   * Release a savepoint (remove from stack without discarding changes).
   */
  _releaseSavepoint(sessionId: string, name: string): boolean {
    const txn = this.transactions.get(sessionId);
    if (!txn) return false;

    const existed = txn.savepointIndexMap.has(name);
    this._pruneSavepointsAfter(txn, name);
    return existed;
  }

  /**
   * Add a pending change (DML buffer) to the current transaction.
   */
  addPendingChange(sessionId: string, sql: string, params?: any[]): void {
    const txn = this.transactions.get(sessionId);
    if (!txn) return;
    txn.pendingChanges.push({ sql, params });
  }

  /**
   * Commit the transaction. Returns the pending changes to be executed.
   * The caller is responsible for executing these changes (shard/raft/MVCC-rewrite).
   * After execution, call cleanupCommit() to finalize.
   */
  prepareCommit(sessionId: string): CommitPrep | null {
    const txn = this.transactions.get(sessionId);
    if (!txn) return null;

    this.hooks.onBeforeCommit?.(sessionId, txn.pendingChanges.length);
    return {
      pendingChanges: txn.pendingChanges,
      startedAt: txn.startedAt,
    };
  }

  /**
   * Clean up transaction state after commit execution completes.
   * MUST be called after prepareCommit() + external execution.
   */
  cleanupCommit(sessionId: string): number {
    const txn = this.transactions.get(sessionId);
    if (!txn) return 0;
    const count = txn.pendingChanges.length;
    this.transactions.delete(sessionId);
    this.idleTxnTimeout?.cancelTimer(sessionId);
    this.hooks.onCommitCleanup?.(sessionId);
    return count;
  }

  /**
   * Roll back the current transaction. Discards all pending changes.
   * Returns the number of discarded changes.
   */
  _rollback(sessionId: string): number {
    const txn = this.transactions.get(sessionId);
    if (!txn) return 0;

    const discarded = txn.pendingChanges.length;
    this.transactions.delete(sessionId);
    this.idleTxnTimeout?.cancelTimer(sessionId);
    this.hooks.onRollback?.(sessionId);
    return discarded;
  }

  /**
   * Clean up all transactions for a session (used on disconnect).
   */
  cleanupSession(sessionId: string): void {
    if (this.transactions.has(sessionId)) {
      this._rollback(sessionId);
    }
  }

  /**
   * Clear all transactions (used in shutdown/testing).
   */
  clearAll(): void {
    for (const sid of this.transactions.keys()) {
      this.idleTxnTimeout?.cancelTimer(sid);
      this.hooks.onRollback?.(sid);
    }
    this.transactions.clear();
  }

  /** Stop the idle-in-transaction timeout manager. */
  shutdown(): void {
    for (const sid of this.transactions.keys()) {
      this.idleTxnTimeout?.cancelTimer(sid);
    }
    this.transactions.clear();
  }

  // ── TransactionCoordinator 接口实现 ─────────────────────

  /** 获取事务状态 */
  getStatus(sessionId: string): 'idle' | 'in_transaction' | 'failed' {
    if (!this.transactions.has(sessionId)) return 'idle';
    return 'in_transaction';
  }

  /** 开始事务 */
  async begin(sessionId: string): Promise<void> {
    this._begin(sessionId);
  }

  /**
   * 提交事务：返回 pending changes，由调用方执行后调用 cleanupCommit。
   */
  async commit(sessionId: string): Promise<void> {
    const prep = this.prepareCommit(sessionId);
    if (!prep) return;
    this.cleanupCommit(sessionId);
  }

  /**
   * 回滚事务 — 接口实现
   */
  async rollback(sessionId: string): Promise<void> {
    this._rollback(sessionId);
  }

  /**
   * 创建 savepoint — 接口签名 (name, sessionId)
   */
  savepoint(name: string, sessionId: string): Promise<void> {
    this._savepoint(sessionId, name);
    return Promise.resolve();
  }

  /**
   * Rollback to savepoint — 接口签名 (name, sessionId)
   */
  rollbackToSavepoint(name: string, sessionId: string): Promise<void> {
    this._rollbackToSavepoint(sessionId, name);
    return Promise.resolve();
  }

  /**
   * Release savepoint — 接口签名 (name, sessionId)
   */
  releaseSavepoint(name: string, sessionId: string): Promise<void> {
    this._releaseSavepoint(sessionId, name);
    return Promise.resolve();
  }

  // ── Internals ──

  private _pruneSavepointsAfter(txn: TransactionContext, name: string): void {
    const idx = txn.savepointStack.indexOf(name);
    if (idx >= 0) {
      // Remove all savepoints from this point forward
      const toRemove = txn.savepointStack.splice(idx + 1);
      // Also remove from index map
      for (const s of toRemove) {
        txn.savepointIndexMap.delete(s);
      }
      // Keep the target savepoint but remove from stack (it's been released)
      txn.savepointStack.splice(idx, 1);
      txn.savepointIndexMap.delete(name);
    }
  }
}

// ── Types ──

export interface BeginResult {
  message: string;
  alreadyInTxn?: boolean;
}

export interface CommitPrep {
  pendingChanges: PendingChange[];
  startedAt: number;
}
