/**
 * PgRewindShim — 类 pg_rewind 脑裂恢复工具
 *
 * Raft 集群有防脑裂机制（CheckQuorum），但缺少类似 pg_rewind 的工具
 * 在新主库写入后恢复老主库。
 *
 * 本 shim 模拟 pg_rewind 的核心流程：
 *   1. detectDivergence()  — 检测分歧点
 *   2. calculateChanges()  — 计算回滚/前滚量
 *   3. rollback()          — 删除分歧后条目
 *   4. rollForward()       — 从权威节点同步缺失条目
 *   5. execute()           — 完整流程
 *   6. getStats()          — 操作统计
 *
 * 使用纯内存条目模拟 raft 日志，不依赖 WASM 层，方便测试。
 */

/** 一条 Raft 日志条目 */
export interface LogEntry {
  index: number;
  term: number;
  data: string;
}

/** Rewind 配置 */
export interface RewindConfig {
  divergedNodeId: number;
  canonicalNodeId: number;
  dataDir: string;
  walDir: string;
}

/** 分歧点信息 */
export interface DivergencePoint {
  index: number;
  term: number;
  diverged: boolean;
}

/** Rewind 执行结果 */
export interface RewindResult {
  success: boolean;
  entriesRolledBack: number;
  entriesApplied: number;
  newLogStartIndex: number;
  newLogEndIndex: number;
}

/** Rewind 操作统计 */
export interface RewindStats {
  totalEntriesBefore: number;
  totalEntriesAfter: number;
  divergedEntries: number;
  missingEntries: number;
  rolledBack: number;
  rolledForward: number;
  divergencePoint: DivergencePoint | null;
  durationMs: number;
}

/** 内部标记：条目状态 */
type EntryStatus = 'active' | 'tombstone';

interface LogEntryInternal {
  entry: LogEntry;
  status: EntryStatus;
}

export class PgRewindShim {
  private divergedLog: LogEntryInternal[];
  private canonicalLog: LogEntryInternal[];
  private config: RewindConfig;
  private divergencePoint: DivergencePoint | null = null;
  /** 最后一个匹配条目的 index（0-indexed in divergedLog） */
  private lastMatchIdx: number = -1;
  /** 最后一个匹配条目的 index（0-indexed in canonicalLog） */
  private lastMatchCIdx: number = -1;
  private stats!: RewindStats;

  constructor(
    config: RewindConfig,
    divergedLog?: LogEntry[],
    canonicalLog?: LogEntry[],
  ) {
    this.config = config;
    this.divergedLog = (divergedLog ?? []).map(e => ({ entry: e, status: 'active' as EntryStatus }));
    this.canonicalLog = (canonicalLog ?? []).map(e => ({ entry: e, status: 'active' as EntryStatus }));
    this.resetStats();
  }

  // ──────────────────── 公共 API ────────────────────

  /**
   * 检测分歧点。
   *
   * 采用前向扫描法：逐对比较两个日志的条目（index + term），
   * 找到第一个不一致的位置。之前的位置即为日志共同前缀。
   * 适合顺序写入的 raft 日志场景。
   */
  detectDivergence(): DivergencePoint {
    const dLen = this.divergedLog.length;
    const cLen = this.canonicalLog.length;
    const minLen = Math.min(dLen, cLen);

    let k = 0;
    while (k < minLen) {
      const d = this.divergedLog[k].entry;
      const c = this.canonicalLog[k].entry;
      if (d.index === c.index && d.term === c.term) {
        k++;
      } else {
        break;
      }
    }

    // k = 共同前缀的长度（第一个分歧位置 / 日志较短方的末尾 + 1）
    this.lastMatchIdx = k - 1;
    this.lastMatchCIdx = k - 1;

    const hasDivergence = k < dLen || k < cLen;

    if (!hasDivergence) {
      this.divergencePoint = {
        index: k > 0 ? this.divergedLog[k - 1].entry.index : 0,
        term: k > 0 ? this.divergedLog[k - 1].entry.term : 0,
        diverged: false,
      };
      return this.divergencePoint;
    }

    // 分歧点在第一个不一致的 index 处
    const dpIndex = k < dLen
      ? this.divergedLog[k].entry.index
      : (k > 0 ? this.divergedLog[k - 1].entry.index + 1 : 0);

    const dpTerm = k < dLen
      ? this.divergedLog[k].entry.term
      : (k > 0 ? this.canonicalLog[k].entry.term : 0);

    this.divergencePoint = {
      index: dpIndex,
      term: dpTerm,
      diverged: true,
    };

    return this.divergencePoint;
  }

  /**
   * 计算需要回滚和前滚的条目数量。
   * 必须先调用 detectDivergence()。
   */
  calculateChanges(): { toRollBack: number; toRollForward: number } {
    if (this.lastMatchIdx < 0 && this.lastMatchCIdx < 0 && this.divergedLog.length > 0 && this.canonicalLog.length > 0) {
      this.detectDivergence();
    }
    if (!this.divergencePoint || !this.divergencePoint.diverged) {
      // 可能一个日志为空
      if (this.divergedLog.length === 0 && this.canonicalLog.length === 0) {
        return { toRollBack: 0, toRollForward: 0 };
      }
      if (this.divergedLog.length === 0) {
        return { toRollBack: 0, toRollForward: this.canonicalLog.length };
      }
      if (this.canonicalLog.length === 0) {
        return { toRollBack: this.divergedLog.length, toRollForward: 0 };
      }
      return { toRollBack: 0, toRollForward: 0 };
    }

    const matchEnd = this.lastMatchIdx + 1; // 第一个分歧位置
    const matchCEnd = this.lastMatchCIdx + 1;

    const toRollBack = this.divergedLog.length - matchEnd;
    const toRollForward = this.canonicalLog.length - matchCEnd;

    return { toRollBack, toRollForward };
  }

  /**
   * 删除分歧点之后的条目（标记为 tombstone）。
   * 必须先调用 detectDivergence()。
   */
  rollback(): number {
    if (this.divergedLog.length === 0) return 0;

    if (this.lastMatchIdx < 0) {
      this.detectDivergence();
    }

    if (!this.divergencePoint || !this.divergencePoint.diverged) {
      return 0;
    }

    const startIdx = this.lastMatchIdx + 1; // 第一个分歧的 index
    let rolledBack = 0;

    for (let k = startIdx; k < this.divergedLog.length; k++) {
      if (this.divergedLog[k].status === 'active') {
        this.divergedLog[k].status = 'tombstone';
        rolledBack++;
      }
    }

    this.stats.rolledBack = rolledBack;
    return rolledBack;
  }

  /**
   * 从权威节点同步缺失条目到分歧节点。
   * 必须先调用 detectDivergence()。
   */
  rollForward(): number {
    if (this.canonicalLog.length === 0) return 0;

    if (this.lastMatchCIdx < 0 && this.lastMatchIdx < 0) {
      this.detectDivergence();
    }

    // 清除 tombstone 条目
    this.divergedLog = this.divergedLog.filter(e => e.status === 'active');

    // 如果一个为空一个不为空，重新校准
    if (!this.divergencePoint || !this.divergencePoint.diverged) {
      this.detectDivergence();
    }

    // 对于 canonical 非空 + diverged 为空的情况
    if (this.divergedLog.length === 0 && this.canonicalLog.length > 0) {
      const count = this.canonicalLog.length;
      for (let k = 0; k < count; k++) {
        this.divergedLog.push({
          entry: { ...this.canonicalLog[k].entry },
          status: 'active',
        });
      }
      this.stats.rolledForward = count;
      return count;
    }

    if (!this.divergencePoint || !this.divergencePoint.diverged) {
      return 0;
    }

    const startCIdx = this.lastMatchCIdx + 1;
    let rolledForward = 0;

    for (let k = startCIdx; k < this.canonicalLog.length; k++) {
      this.divergedLog.push({
        entry: { ...this.canonicalLog[k].entry },
        status: 'active',
      });
      rolledForward++;
    }

    this.stats.rolledForward = rolledForward;
    return rolledForward;
  }

  /**
   * 完整 rewind 流程。
   */
  execute(): RewindResult {
    const start = Date.now();
    this.resetStats();
    this.stats.totalEntriesBefore = this.divergedLog.length;

    this.detectDivergence();

    // 处理一个为空一个不为空的特殊 case
    const isEmptyDiverged = this.divergedLog.length === 0;
    const isEmptyCanonical = this.canonicalLog.length === 0;

    if (isEmptyDiverged && isEmptyCanonical) {
      this.stats.totalEntriesAfter = 0;
      this.stats.durationMs = Date.now() - start;
      return {
        success: true,
        entriesRolledBack: 0,
        entriesApplied: 0,
        newLogStartIndex: 0,
        newLogEndIndex: 0,
      };
    }

    if (isEmptyDiverged && !isEmptyCanonical) {
      // 全量前滚
      this.rollForward();
      this.stats.totalEntriesAfter = this.divergedLog.length;
      this.stats.durationMs = Date.now() - start;
      return {
        success: true,
        entriesRolledBack: 0,
        entriesApplied: this.canonicalLog.length,
        newLogStartIndex: this.divergedLog[0].entry.index,
        newLogEndIndex: this.divergedLog[this.divergedLog.length - 1].entry.index,
      };
    }

    if (!isEmptyDiverged && isEmptyCanonical) {
      // 全量回滚（标记所有为 tombstone）
      let rolledBack = 0;
      for (let k = 0; k < this.divergedLog.length; k++) {
        this.divergedLog[k].status = 'tombstone';
        rolledBack++;
      }
      this.stats.rolledBack = rolledBack;
      this.stats.totalEntriesAfter = 0;
      this.stats.durationMs = Date.now() - start;
      return {
        success: true,
        entriesRolledBack: rolledBack,
        entriesApplied: 0,
        newLogStartIndex: 0,
        newLogEndIndex: 0,
      };
    }

    // 正常分歧检测
    if (!this.divergencePoint || !this.divergencePoint.diverged) {
      this.stats.totalEntriesAfter = this.divergedLog.length;
      this.stats.durationMs = Date.now() - start;
      return {
        success: true,
        entriesRolledBack: 0,
        entriesApplied: 0,
        newLogStartIndex: this.divergedLog[0].entry.index,
        newLogEndIndex: this.divergedLog[this.divergedLog.length - 1].entry.index,
      };
    }

    const { toRollBack, toRollForward } = this.calculateChanges();
    this.stats.divergedEntries = toRollBack;
    this.stats.missingEntries = toRollForward;

    this.rollback();
    this.rollForward();

    this.stats.totalEntriesAfter = this.divergedLog.length;
    this.stats.durationMs = Date.now() - start;

    const activeLog = this.getDivergedLog();

    return {
      success: true,
      entriesRolledBack: toRollBack,
      entriesApplied: toRollForward,
      // activeLog is never empty here: rollForward always appends the
      // canonical divergent suffix (toRollForward > 0 in this branch), so
      // the `: 0` fallbacks below are unreachable dead code.
      /* c8 ignore next */
      newLogStartIndex: activeLog.length > 0 ? activeLog[0].index : 0,
      /* c8 ignore next */
      newLogEndIndex: activeLog.length > 0 ? activeLog[activeLog.length - 1].index : 0,
    };
  }

  /** 返回操作统计 */
  getStats(): RewindStats {
    return {
      ...this.stats,
      divergencePoint: this.divergencePoint ? { ...this.divergencePoint } : null,
    };
  }

  /** 获取当前分歧节点日志（仅 active 条目） */
  getDivergedLog(): LogEntry[] {
    return this.divergedLog
      .filter(e => e.status === 'active')
      .map(e => ({ ...e.entry }));
  }

  /** 获取当前权威节点日志（仅 active 条目，权威侧全 active） */
  getCanonicalLog(): LogEntry[] {
    return this.canonicalLog.map(e => ({ ...e.entry }));
  }

  /** 检查分歧节点日志与权威节点日志是否一致 */
  isConsistent(): boolean {
    const dActive = this.getDivergedLog();
    const cActive = this.getCanonicalLog();

    if (dActive.length !== cActive.length) return false;

    for (let i = 0; i < dActive.length; i++) {
      if (dActive[i].index !== cActive[i].index || dActive[i].term !== cActive[i].term) {
        return false;
      }
    }

    return true;
  }

  // ──────────────────── 内部帮助方法 ────────────────────

  private resetStats(): void {
    this.stats = {
      totalEntriesBefore: 0,
      totalEntriesAfter: 0,
      divergedEntries: 0,
      missingEntries: 0,
      rolledBack: 0,
      rolledForward: 0,
      divergencePoint: null,
      durationMs: 0,
    };
  }
}
