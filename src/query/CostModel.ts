/**
 * CostModel — PostgreSQL 风格的代价模型
 *
 * 模拟 PostgreSQL 的基于代价的优化器（GUC 可配置代价因子），
 * 为扫描、连接、排序、聚合等操作提供代价估算。
 *
 * 设计参考：
 *   - PostgreSQL 代价因子（seq_page_cost, random_page_cost, cpu_tuple_cost 等）
 *   - 代价单位：任意单位（通常表示为磁盘页读取的抽象成本）
 *   - startupCost: 输出第一行前的固定开销
 *   - totalCost: 处理完所有行后的总开销
 */

// ── 类型定义 ──

import { GucSystem } from '../core/GucSystem';

export interface CostFactors {
  /** 顺序页读取代价（默认 1.0） */
  seqPageCost: number;
  /** 随机页读取代价（默认 4.0） */
  randomPageCost: number;
  /** 处理一行元组的 CPU 代价（默认 0.01） */
  cpuTupleCost: number;
  /** 通过索引处理一行元组的 CPU 代价（默认 0.005） */
  cpuIndexTupleCost: number;
  /** 执行一次算子的 CPU 代价（默认 0.0025） */
  cpuOperatorCost: number;
  /** 并行场景下处理一行元组的额外代价（默认 0.1） */
  parallelTupleCost: number;
  /** Bitmap 扫描中每页访问的代价（默认 4.0，通常等于 randomPageCost） */
  bitmapPageCost: number;
  /** 可见性映射表（Visibility Map）缩减因子，控制 Index Only Scan 仅访问 VM 标记的干净页（默认 0.1，表示仅 10% 的页需要随机 IO） */
  visibilityMapFraction: number;
}

export interface TableStats {
  /** 表行数估计 */
  reltuples: number;
  /** 表页数估计 */
  relpages: number;
  /** 列去重数（column name → distinct count） */
  nDistinct: Map<string, number>;
  /** 列物理排序相关性（column name → -1..1） */
  correlation: Map<string, number>;
}

export interface ScanCost {
  /** 启动代价（输出第一行前的开销） */
  startupCost: number;
  /** 总代价（处理完所有数据的开销） */
  totalCost: number;
  /** 输出行数估计 */
  rows: number;
  /** 行宽度估计（字节） */
  width: number;
}

export type CostFactorName = keyof CostFactors;

// ── PostgreSQL 默认值 ──

const DEFAULT_COST_FACTORS: CostFactors = {
  seqPageCost: 1.0,
  randomPageCost: 4.0,
  cpuTupleCost: 0.01,
  cpuIndexTupleCost: 0.005,
  cpuOperatorCost: 0.0025,
  parallelTupleCost: 0.1,
  bitmapPageCost: 4.0,
  visibilityMapFraction: 0.1,
};

// ── CostModel 类 ──

export class CostModel {
  private factors: CostFactors;

  constructor(factors?: Partial<CostFactors>, loadFromGuc: boolean = false) {
    this.factors = { ...DEFAULT_COST_FACTORS, ...factors };
    if (loadFromGuc) {
      this.loadCostFactorsFromGuc();
    }
  }

  // ── GUC-backed cost factors ──

  /**
   * Load cost factor overrides from GUC system.
   * Reads PG 16-compatible GUC names:
   *   - random_page_cost, seq_page_cost, cpu_tuple_cost,
   *     cpu_operator_cost, cpu_index_tuple_cost, effective_cache_size
   *
   * Defaults match PG 16 defaults.
   */
  static loadFromGucSystem(): Partial<CostFactors> {
    const overrides: Partial<CostFactors> = {};
    try {
      const guc = GucSystem.getInstance();

      // Reads a runtime GUC as a float, or undefined when unset.
      const readFloat = (name: string): number | undefined => {
        const v = guc.get(name).value;
        if (v === undefined) return undefined;
        const n = parseFloat(v);
        return Number.isNaN(n) ? undefined : n;
      };
      // Reads a runtime GUC as an integer, or undefined when unset.
      const readInt = (name: string): number | undefined => {
        const v = guc.get(name).value;
        if (v === undefined) return undefined;
        const n = parseInt(v, 10);
        return Number.isNaN(n) ? undefined : n;
      };

      const spc = readFloat('seq_page_cost');
      if (spc !== undefined) overrides.seqPageCost = spc;

      const rpc = readFloat('random_page_cost');
      if (rpc !== undefined) overrides.randomPageCost = rpc;

      const ctc = readFloat('cpu_tuple_cost');
      if (ctc !== undefined) overrides.cpuTupleCost = ctc;

      const citc = readFloat('cpu_index_tuple_cost');
      if (citc !== undefined) overrides.cpuIndexTupleCost = citc;

      const coc = readFloat('cpu_operator_cost');
      if (coc !== undefined) overrides.cpuOperatorCost = coc;

      // effective_cache_size influences cost heuristics
      const ecs = readInt('effective_cache_size');
      if (ecs !== undefined) {
        // Not directly a CostFactor, but used for cache-aware costing
        // Stored as 8KB pages (PG convention)
        const cacheBytes = ecs * 8192;
        // Estimate bitmapPageCost as inverse of cache ratio
        const cacheRatio = Math.min(1, cacheBytes / (4 * 1024 * 1024 * 1024)); // ratio vs 4GB
        overrides.bitmapPageCost = Math.max(1.0, 4.0 - cacheRatio * 3.0);
      }
    } catch {
      // GUC system unavailable — keep defaults
    }
    return overrides;
  }

  /**
   * Apply GUC-loaded cost factors to the current instance.
   */
  loadCostFactorsFromGuc(): void {
    const gucFactors = CostModel.loadFromGucSystem();
    this.setCostFactors(gucFactors);
  }

  // ── GUC 调整 ──

  /**
   * 动态调整代价因子。
   * @param name 因子名称
   * @param value 新值
   */
  setCostFactor(name: CostFactorName, value: number): void {
    if (!(name in this.factors)) {
      throw new Error(`Unknown cost factor: ${name}`);
    }
    if (value < 0) {
      throw new Error(`Cost factor must be non-negative: ${name}=${value}`);
    }
    (this.factors as unknown as Record<string, number>)[name] = value;
  }

  /**
   * 批量设置代价因子。
   */
  setCostFactors(overrides: Partial<CostFactors>): void {
    for (const [key, value] of Object.entries(overrides)) {
      this.setCostFactor(key as CostFactorName, value);
    }
  }

  /**
   * 获取当前代价因子的副本。
   */
  getCostFactors(): CostFactors {
    return { ...this.factors };
  }

  /**
   * 重置为 PostgreSQL 默认值。
   */
  resetCostFactors(): void {
    this.factors = { ...DEFAULT_COST_FACTORS };
  }

  // ── 扫描代价 ──

  /**
   * 全表扫描（顺序扫描）代价。
   * 公式：startupCost = 0, totalCost = seqPageCost × pages + cpuTupleCost × tuples
   */
  seqScanCost(stats: TableStats): ScanCost {
    const startupCost = 0;
    const totalCost =
      this.factors.seqPageCost * stats.relpages +
      this.factors.cpuTupleCost * stats.reltuples;
    return {
      startupCost,
      totalCost,
      rows: stats.reltuples,
      width: 0, // 调用方可根据需要设置
    };
  }

  /**
   * 索引扫描代价。
   * 公式：
   *   startupCost = cpuOperatorCost
   *   totalCost = startupCost
   *     + randomPageCost × pages_read
   *     + cpuIndexTupleCost × index_tuples
   *     + cpuTupleCost × table_tuples
   *   其中 pages_read = selectivity × relpages
   *        index_tuples = selectivity × reltuples
   *        table_tuples = selectivity × reltuples
   */
  indexScanCost(stats: TableStats, selectivity: number): ScanCost {
    const clampedSel = Math.max(0, Math.min(1, selectivity));
    const pagesRead = clampedSel * stats.relpages;
    const indexTuples = clampedSel * stats.reltuples;
    const tableTuples = clampedSel * stats.reltuples;

    const startupCost = this.factors.cpuOperatorCost;
    const totalCost =
      startupCost +
      this.factors.randomPageCost * pagesRead +
      this.factors.cpuIndexTupleCost * indexTuples +
      this.factors.cpuTupleCost * tableTuples;
    return {
      startupCost,
      totalCost,
      rows: indexTuples,
      width: 0,
    };
  }

  // ── 并行扫描代价 ──

  /**
   * 并行扫描代价。
   * 公式：
   *   startupCost = cpuOperatorCost
   *   totalCost = startupCost
   *     + (seqPageCost × pages + cpuTupleCost × tuples + parallelTupleCost × tuples)
   *       / nWorkers
   */
  parallelScanCost(stats: TableStats, nWorkers: number): ScanCost {
    const workers = Math.max(1, Math.floor(nWorkers));
    const startupCost = this.factors.cpuOperatorCost;
    const seqCost = this.factors.seqPageCost * stats.relpages;
    const cpuCost = this.factors.cpuTupleCost * stats.reltuples;
    const parallelOverhead = this.factors.parallelTupleCost * stats.reltuples;
    const totalCost =
      startupCost + (seqCost + cpuCost + parallelOverhead) / workers;
    return {
      startupCost,
      totalCost,
      rows: stats.reltuples,
      width: 0,
    };
  }

  /**
   * Bitmap 扫描代价。
   *
   * PG 公式：
   *   Bitmap Scan 包含两个阶段：
   *   (1) 扫描索引并创建 Bitmap（等同于 indexScan 的开销）
   *   (2) 根据 Bitmap 按序获取堆页（随机 IO，但每个页最多访问一次）
   *
   *   startupCost = cpuOperatorCost（Bitmap 创建头开销）
   *   bitmapPages = selectivity × relpages（Bitmap 命中的页数估计）
   *   bitmapTuples = selectivity × reltuples（Bitmap 命中的元组数估计）
   *   totalCost = indexScanCost.totalCost
   *               + bitmapPageCost × bitmapPages
   *               + cpuTupleCost × bitmapTuples
   *
   * 注意：Bitmap Scan 的 totalCost 以 indexScanCost.totalCost 为基础（索引扫描 + Bitmap 构建阶段），
   * 再叠加上第二阶段（扫描 Bitmap 获取堆页）的随机 IO 和元组处理开销。
   *
   * @param stats 表统计信息
   * @param selectivity 选择性 (0..1)，选中的行比例
   * @returns ScanCost 对象
   */
  bitmapScanCost(stats: TableStats, selectivity: number): ScanCost {
    const clampedSel = Math.max(0, Math.min(1, selectivity));
    const bitmapPages = clampedSel * stats.relpages;
    const bitmapTuples = clampedSel * stats.reltuples;
    const indexScanTotal = this.indexScanCost(stats, clampedSel).totalCost;

    const startupCost = this.factors.cpuOperatorCost;
    const totalCost =
      indexScanTotal +
      this.factors.bitmapPageCost * bitmapPages +
      this.factors.cpuTupleCost * bitmapTuples;
    return {
      startupCost,
      totalCost,
      rows: clampedSel * stats.reltuples,
      width: 0,
    };
  }

  /**
   * Index Only 扫描代价（覆盖索引扫描，避免堆表访问）。
   *
   * PG 公式：
   *   Index Only Scan 使用可见性映射表（Visibility Map）来避免访问
   *   已全部可见的堆页，大幅降低随机 IO。只有 VM 标记为"不全可见"的页
   *   才需要实际访问堆。
   *
   *   startupCost = cpuOperatorCost
   *   totalCost = startupCost
   *               + randomPageCost × (selectivity × relpages × visibilityMapFraction)
   *               + cpuIndexTupleCost × (selectivity × reltuples)
   *
   * 其中 visibilityMapFraction 控制 VM 不全可见页的比例（默认 0.1 = 10%）。
   *
   * 与普通 indexScanCost 相比，Index Only Scan 的 totalCost 显著更低，
   * 因为它省去了大部分堆表随机 IO（cpuTupleCost 部分）。
   *
   * @param stats 表统计信息
   * @param selectivity 选择性 (0..1)，选中的行比例
   * @returns ScanCost 对象
   */
  indexOnlyScanCost(stats: TableStats, selectivity: number): ScanCost {
    const clampedSel = Math.max(0, Math.min(1, selectivity));
    const startupCost = this.factors.cpuOperatorCost;
    const vmPages = clampedSel * stats.relpages * this.factors.visibilityMapFraction;
    const indexTuples = clampedSel * stats.reltuples;

    const totalCost =
      startupCost +
      this.factors.randomPageCost * vmPages +
      this.factors.cpuIndexTupleCost * indexTuples;
    return {
      startupCost,
      totalCost,
      rows: indexTuples,
      width: 0,
    };
  }

  // ── 连接代价 ──

  /**
   * 嵌套循环连接代价。
   * 公式：
   *   startupCost = outer.startupCost + inner.startupCost
   *   totalCost = outer.totalCost + outer.rows × inner.totalCost
   *   rows ≈ outer.rows × inner.rows × selectivity
   */
  nestedLoopCost(
    outer: ScanCost,
    inner: ScanCost,
    selectivity: number = 1,
  ): ScanCost {
    const clampedSel = Math.max(0, Math.min(1, selectivity));
    const startupCost = outer.startupCost + inner.startupCost;
    const totalCost = outer.totalCost + outer.rows * inner.totalCost;
    const rows = outer.rows * inner.rows * clampedSel;
    return {
      startupCost,
      totalCost,
      rows,
      width: outer.width + inner.width,
    };
  }

  /**
   * 哈希连接代价。
   * 公式：
   *   startupCost = outer.startupCost + inner.startupCost + cpuOperatorCost
   *   totalCost = startupCost + outer.totalCost + inner.totalCost
   *   rows ≈ outer.rows × inner.rows × selectivity
   */
  hashJoinCost(
    outer: ScanCost,
    inner: ScanCost,
    selectivity: number = 1,
  ): ScanCost {
    const clampedSel = Math.max(0, Math.min(1, selectivity));
    const startupCost =
      outer.startupCost + inner.startupCost + this.factors.cpuOperatorCost;
    const totalCost = startupCost + outer.totalCost + inner.totalCost;
    const rows = outer.rows * inner.rows * clampedSel;
    return {
      startupCost,
      totalCost,
      rows,
      width: outer.width + inner.width,
    };
  }

  /**
   * 归并连接代价。
   * 公式：
   *   startupCost = outer.startupCost + inner.startupCost + sortCosts
   *   totalCost = startupCost + outer.totalCost + inner.totalCost
   *   rows ≈ outer.rows × inner.rows × selectivity
   */
  mergeJoinCost(
    outer: ScanCost,
    inner: ScanCost,
    sortCosts: { outerSort: number; innerSort: number },
    selectivity: number = 1,
  ): ScanCost {
    const clampedSel = Math.max(0, Math.min(1, selectivity));
    const startupCost =
      outer.startupCost +
      inner.startupCost +
      sortCosts.outerSort +
      sortCosts.innerSort;
    const totalCost = startupCost + outer.totalCost + inner.totalCost;
    const rows = outer.rows * inner.rows * clampedSel;
    return {
      startupCost,
      totalCost,
      rows,
      width: outer.width + inner.width,
    };
  }

  // ── 排序代价 ──

  /**
   * 排序代价（内存排序，假设可以全部装入内存）。
   * 公式：
   *   startupCost = cpuOperatorCost
   *   totalCost = startupCost + cpuOperatorCost × tuples × log₂(tuples)
   */
  sortCost(stats: TableStats): ScanCost {
    const n = Math.max(1, stats.reltuples);
    const startupCost = this.factors.cpuOperatorCost;
    const compareCost = this.factors.cpuOperatorCost * n * Math.log2(n);
    const totalCost = startupCost + compareCost;
    return {
      startupCost,
      totalCost,
      rows: stats.reltuples,
      width: 0,
    };
  }

  // ── 聚合代价 ──

  /**
   * 聚合代价（GROUP BY 或简单聚合）。
   * 公式：
   *   startupCost = cpuOperatorCost
   *   totalCost = startupCost + cpuOperatorCost × tuples + cpuTupleCost × group_size
   *   其中 group_size = tuples / nDistinct (如果指定了 group 列)
   */
  aggregateCost(stats: TableStats, groupClauses?: string[]): ScanCost {
    const n = Math.max(1, stats.reltuples);
    const startupCost = this.factors.cpuOperatorCost;

    let groupSize = 1;
    if (groupClauses && groupClauses.length > 0) {
      // 使用 GROUP BY 列的去重数来估计分组数
      let distinctProduct = 1;
      for (const col of groupClauses) {
        const d = stats.nDistinct.get(col);
        if (d !== undefined && d > 0) {
          distinctProduct *= d;
        }
      }
      groupSize = Math.min(n, Math.max(1, distinctProduct));
    }

    const totalCost =
      startupCost +
      this.factors.cpuOperatorCost * n +
      this.factors.cpuTupleCost * groupSize;
    return {
      startupCost,
      totalCost,
      rows: groupSize,
      width: 0,
    };
  }

  // ── 工具方法 ──

  /**
   * 判断是否使用并行扫描。
   * 当并行扫描代价 < 顺序扫描代价 × threshold 时建议使用并行。
   */
  shouldUseParallel(
    stats: TableStats,
    nWorkers: number,
    threshold: number = 0.8,
  ): boolean {
    const seqCost = this.seqScanCost(stats).totalCost;
    if (seqCost <= 0) return false;
    const parCost = this.parallelScanCost(stats, nWorkers).totalCost;
    return parCost < seqCost * threshold;
  }
}
