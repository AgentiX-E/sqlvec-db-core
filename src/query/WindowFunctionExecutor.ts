/**
 * WindowFunctionExecutor — 排序后流式帧计算
 *
 * 支持：
 * - ROWS frame（物理行偏移）
 * - RANGE frame（逻辑值偏移） — 当前仅支持天级（日期/时间戳）和数值型 offset
 * - GROUPS frame（组偏移）
 * - 聚合窗口函数（SUM/AVG/COUNT/MAX/MIN over window）
 * - 排名函数（ROW_NUMBER, RANK, DENSE_RANK, NTILE, CUME_DIST, PERCENT_RANK）
 * - 偏移函数（LAG, LEAD, FIRST_VALUE, LAST_VALUE, NTH_VALUE）
 *
 * RANGE 帧注意事项：
 * - 对于日期/时间戳 ORDER BY 列，RANGE N PRECEDING/FOLLOWING 中的 N 解释为天（×86400000 ms）
 * - 对于数值 ORDER BY 列，N 直接解释为数值偏移
 * - 不支持月/年等非天级时间单位；如需精确控制请使用 ROWS 帧
 *
 * 实现策略：
 * 1. 按 PARTITION BY 列排序输入行
 * 2. 对每个分区，逐行计算窗口函数值
 * 3. 返回结果（附加窗口函数列或替换原数据）
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('WindowFunctionExecutor');

// ── 类型定义 ──

export interface WindowFrameBound {
  type: 'UNBOUNDED_PRECEDING' | 'PRECEDING' | 'CURRENT_ROW' | 'FOLLOWING' | 'UNBOUNDED_FOLLOWING';
  offset?: number;
}

export interface WindowFrame {
  type: 'ROWS' | 'RANGE' | 'GROUPS';
  start: WindowFrameBound;
  end: WindowFrameBound;
}

export interface WindowSpec {
  partitionBy: string[];
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>;
  frame: WindowFrame;
  exclude?: ExcludeMode;
}

/** 默认窗口帧：RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW */
const DEFAULT_FRAME: WindowFrame = {
  type: 'RANGE',
  start: { type: 'UNBOUNDED_PRECEDING' },
  end: { type: 'CURRENT_ROW' },
};

// ── EXCLUDE 子句支持 ──

/**
 * PostgreSQL EXCLUDE 模式：
 * - CURRENT ROW: 从帧中排除当前行
 * - GROUP: 排除所有 peer（ORDER BY 值相同的行）
 * - TIES: 排除 peer 组的其他行，保留当前行
 * - NO OTHERS: 默认行为，不排除任何行
 */
export type ExcludeMode = 'CURRENT ROW' | 'GROUP' | 'TIES' | 'NO OTHERS';

/**
 * 从 SQL OVER 子句中解析 EXCLUDE 模式。
 * 使用正则匹配 OVER 子句中出现的 EXCLUDE 关键字。
 * 
 * @param sql - 包含窗口函数的 SQL 字符串
 * @returns 检测到的 ExcludeMode，默认为 'NO OTHERS'
 */
export function parseExcludeMode(sql: string): ExcludeMode {
  // 匹配 OVER 子句中的 EXCLUDE 模式
  const excludeMatch = sql.match(
    /\bEXCLUDE\s+(CURRENT[_\s]+ROW|GROUP|TIES|NO[_\s]+OTHERS)\b/i,
  );
  if (!excludeMatch) {
    return 'NO OTHERS';
  }
  const mode = excludeMatch[1].toUpperCase();
  switch (mode) {
    case 'CURRENT ROW':
    case 'CURRENT_ROW':
      return 'CURRENT ROW';
    case 'GROUP':
      return 'GROUP';
    case 'TIES':
      return 'TIES';
    case 'NO OTHERS':
    case 'NO_OTHERS':
      return 'NO OTHERS';
    default:
      return 'NO OTHERS';
  }
}

/**
 * 根据 EXCLUDE 模式过滤帧行。
 * 
 * @param frameRows - 当前帧包含的行（来自 partition 的直接引用）
 * @param currentRowIndex - 当前行在 partition 中的索引
 * @param partition - 整个分区的行引用（用于引用匹配查找帧行在分区中的索引）
 * @param orderByValues - 分区中每行的 ORDER BY 列值子集（用于 peer group 比较）
 * @param excludeMode - EXCLUDE 模式
 * @returns 过滤后的帧行
 */
export function applyExcludeClause<T>(
  frameRows: T[],
  currentRowIndex: number,
  partition: T[],
  orderByValues: Record<string, unknown>[],
  excludeMode: ExcludeMode,
): T[] {
  if (excludeMode === 'NO OTHERS' || frameRows.length === 0) {
    return frameRows;
  }

  // 获取当前行在 partition 中的引用以及其 order-by 值
  const currentRow = partition[currentRowIndex];
  const currentOrderByVals = orderByValues[currentRowIndex];

  // 查找帧中某行在 partition 中的索引（基于引用比较）
  const findPartitionIndex = (row: T): number => {
    if (row === currentRow) return currentRowIndex;
    for (let i = 0; i < partition.length; i++) {
      if (partition[i] === row) return i;
    }
    return -1;
  };

  // 判断指定索引的行是否与当前行是 peer（ORDER BY 值相同）
  const isPeer = (idx: number): boolean => {
    if (idx < 0 || idx >= partition.length || !currentOrderByVals) return false;
    const rowOrderByVals = orderByValues[idx];
    if (!rowOrderByVals) return false;
    const keys = Object.keys(currentOrderByVals);
    if (keys.length === 0) return true; // 无 ORDER BY → 所有行视为 peer
    return keys.every(
      key => String(rowOrderByVals[key] ?? '') === String(currentOrderByVals[key] ?? ''),
    );
  };

  const result: T[] = [];

  for (const row of frameRows) {
    const idx = findPartitionIndex(row);

    switch (excludeMode) {
      case 'CURRENT ROW':
        if (idx !== currentRowIndex) {
          result.push(row);
        }
        break;
      case 'GROUP':
        if (!isPeer(idx)) {
          result.push(row);
        }
        break;
      case 'TIES':
        if (!isPeer(idx) || idx === currentRowIndex) {
          result.push(row);
        }
        break;
      default:
        result.push(row);
    }
  }

  return result;
}

/**
 * 比较两行的 ORDER BY 值是否相等（peer groups 判断）。
 */
function orderByValuesEqual(
  a: any,
  b: any,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
): boolean {
  for (const key of orderBy) {
    const va = a[key.column];
    const vb = b[key.column];
    if (String(va ?? '') !== String(vb ?? '')) return false;
  }
  return true;
}

/**
 * 比较两行的 ORDER BY 值大小。
 * 返回 -1 (a < b), 0 (a == b), 1 (a > b)。
 */
function compareOrderByValues(
  a: any,
  b: any,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
): number {
  for (const key of orderBy) {
    const va = a[key.column];
    const vb = b[key.column];
    // NULL 处理：在排序上下文中 NULL 如何比较？
    // SQL 标准中 NULL 在 ORDER BY 中视为小于所有非 NULL 值（或大于，取决于配置）
    // 这里简化为 NULL 不等于任何值，也不参与 RANGE 帧的范围判定
    if (va == null && vb == null) continue;
    if (va == null) return -1;
    if (vb == null) return 1;

    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    if (cmp !== 0) return key.order === 'DESC' ? -cmp : cmp;
  }
  return 0;
}

/**
 * 分区分组：按 PARTITION BY 列对行分组。
 */
function partitionRows(
  rows: any[],
  partitionBy: string[],
): Map<string, any[]> {
  const partitions = new Map<string, any[]>();
  for (const row of rows) {
    const key = partitionBy.map(col => String(row[col] ?? '')).join('|');
    if (!partitions.has(key)) {
      partitions.set(key, []);
    }
    partitions.get(key)!.push(row);
  }
  return partitions;
}

/**
 * 对分区内行按 ORDER BY 排序。
 */
function sortPartition(
  rows: any[],
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
): void {
  if (orderBy.length === 0) return;
  rows.sort((a, b) => compareOrderByValues(a, b, orderBy));
}

/**
 * 计算帧的起止行索引（ROWS 模式）。
 */
function computeRowsFrameBounds(
  partition: any[],
  currentIndex: number,
  frame: WindowFrame,
): { start: number; end: number } {
  const total = partition.length;
  let start: number, end: number;

  // 计算帧起始
  switch (frame.start.type) {
    case 'UNBOUNDED_PRECEDING':
      start = 0;
      break;
    case 'PRECEDING':
      start = Math.max(0, currentIndex - (frame.start.offset ?? 1));
      break;
    case 'CURRENT_ROW':
      start = currentIndex;
      break;
    case 'FOLLOWING':
      start = Math.min(total - 1, currentIndex + (frame.start.offset ?? 1));
      break;
    case 'UNBOUNDED_FOLLOWING':
      start = total - 1;
      break;
    default:
      start = 0;
  }

  // 计算帧结束
  switch (frame.end.type) {
    case 'UNBOUNDED_PRECEDING':
      end = 0;
      break;
    case 'PRECEDING':
      end = Math.max(0, currentIndex - (frame.end.offset ?? 1));
      break;
    case 'CURRENT_ROW':
      end = currentIndex;
      break;
    case 'FOLLOWING':
      end = Math.min(total - 1, currentIndex + (frame.end.offset ?? 1));
      break;
    case 'UNBOUNDED_FOLLOWING':
      end = total - 1;
      break;
    default:
      end = total - 1;
  }

  return { start, end };
}

/**
 * 计算帧的起止行索引（RANGE 模式）。
 * RANGE 帧基于 ORDER BY 值而不是行索引。
 * 对于数值 ORDER BY，N PRECEDING 表示 ORDER BY 值在 [current_value - N, current_value] 范围内。
 * 对于日期 ORDER BY，INTERVAL 'N days' PRECEDING 表示日期在 [current_date - N, current_date] 范围内。
 */
function computeRangeFrameBounds(
  partition: any[],
  currentIndex: number,
  frame: WindowFrame,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
): { start: number; end: number } {
  const total = partition.length;
  const currentRow = partition[currentIndex];

  if (frame.start.type === 'UNBOUNDED_PRECEDING' && frame.end.type === 'UNBOUNDED_FOLLOWING') {
    return { start: 0, end: total - 1 };
  }

  let start: number, end: number;

  // Determine the first/last rows in the partition
  const firstIndex = 0;
  const lastIndex = total - 1;

  // RANGE UNBOUNDED PRECEDING → 分区开始
  if (frame.start.type === 'UNBOUNDED_PRECEDING') {
    start = firstIndex;
  } else if (frame.start.type === 'CURRENT_ROW') {
    // RANGE CURRENT ROW: 包含所有与当前行 ORDER BY 值相同的 peer rows
    start = currentIndex;
    while (start > firstIndex && orderByValuesEqual(partition[start - 1], currentRow, orderBy)) {
      start--;
    }
  } else if (frame.start.type === 'PRECEDING') {
    // RANGE N PRECEDING: 基于 ORDER BY 值的逻辑偏移
    const offset = frame.start.offset ?? 1;
    start = findRangeStartBoundary(partition, currentIndex, offset, orderBy, 'PRECEDING', frame.start);
  } else {
    // FOLLOWING as start
    const offset = frame.start.offset ?? 1;
    start = findRangeStartBoundary(partition, currentIndex, offset, orderBy, 'FOLLOWING', frame.start);
  }

  if (frame.end.type === 'UNBOUNDED_FOLLOWING') {
    end = lastIndex;
  } else if (frame.end.type === 'CURRENT_ROW') {
    // RANGE CURRENT ROW: 包含所有与当前行 ORDER BY 值相同的 peer rows
    end = currentIndex;
    while (end < lastIndex && orderByValuesEqual(partition[end + 1], currentRow, orderBy)) {
      end++;
    }
  } else if (frame.end.type === 'FOLLOWING') {
    const offset = frame.end.offset ?? 1;
    end = findRangeEndBoundary(partition, currentIndex, offset, orderBy, 'FOLLOWING', frame.end);
  } else if (frame.end.type === 'PRECEDING') {
    const offset = frame.end.offset ?? 1;
    end = findRangeEndBoundary(partition, currentIndex, offset, orderBy, 'PRECEDING', frame.end);
  } else {
    end = currentIndex;
  }

  return { start, end };
}

/**
 * 在 RANGE 帧中，根据 ORDER BY 值向前寻找帧起始边界。
 * RANGE N PRECEDING: 找到所有 ORDER BY 值 >= (当前值 - offset) 的行。
 * 对于日期列，offset 是 INTERVAL 的天数。
 */
function findRangeStartBoundary(
  partition: any[],
  currentIndex: number,
  offset: number,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
  direction: 'PRECEDING' | 'FOLLOWING',
  bound: WindowFrameBound,
): number {
  const total = partition.length;
  const currentRow = partition[currentIndex];
  const firstIndex = 0;

  if (orderBy.length === 0) {
    // No ORDER BY — all rows are peers
    return firstIndex;
  }

  const orderByCol = orderBy[0].column;
  const order = orderBy[0].order;
  const currentValue = currentRow[orderByCol];

  if (currentValue === null || currentValue === undefined) {
    // NULL values — treat all NULLs as peers for RANGE
    let idx = currentIndex;
    while (idx > firstIndex && partition[idx - 1][orderByCol] === null) {
      idx--;
    }
    return idx;
  }

  if (direction === 'PRECEDING') {
    // For ASC: PRECEDING means values less than current
    // For DESC: PRECEDING means values greater than current
    // We need rows where orderBy value is within offset of the current value

    if (typeof currentValue === 'number') {
      const threshold = order === 'ASC'
        ? currentValue - offset
        : currentValue + offset;
      let idx = currentIndex;
      while (idx > firstIndex) {
        const val = partition[idx - 1][orderByCol];
        if (val === null || val === undefined) break;
        const numericVal = typeof val === 'number' ? val : Number(val);
        if (isNaN(numericVal)) break;
        if (order === 'ASC' && numericVal < threshold) break;
        if (order === 'DESC' && numericVal > threshold) break;
        idx--;
      }
      return idx;
    }

    // Handle Date/TIMESTAMP values
    if (currentValue instanceof Date || isISODateString(currentValue)) {
      const currentDate = currentValue instanceof Date ? currentValue : new Date(currentValue);
      const thresholdMs = currentDate.getTime() - (offset * 86400000); // Convert days to ms
      let idx = currentIndex;
      while (idx > firstIndex) {
        const val = partition[idx - 1][orderByCol];
        if (val === null || val === undefined) break;
        const rowDate = val instanceof Date ? val : new Date(val);
        if (isNaN(rowDate.getTime())) break;
        if (order === 'ASC' && rowDate.getTime() < thresholdMs) break;
        if (order === 'DESC' && rowDate.getTime() > thresholdMs) break;
        idx--;
      }
      return idx;
    }

    // Fallback for string or other types — use peer group
    let idx = currentIndex;
    while (idx > firstIndex && orderByValuesEqual(partition[idx - 1], currentRow, orderBy)) {
      idx--;
    }
    return idx;
  } else {
    // FOLLOWING as start: RANGE between M FOLLOWING and N PRECEDING (rare)
    // For ASC: M FOLLOWING means value + offset
    if (typeof currentValue === 'number') {
      const threshold = order === 'ASC'
        ? currentValue + offset
        : currentValue - offset;
      let idx = currentIndex;
      while (idx < total - 1) {
        const val = partition[idx + 1][orderByCol];
        if (val === null || val === undefined) break;
        const numericVal = typeof val === 'number' ? val : Number(val);
        if (isNaN(numericVal)) break;
        if (order === 'ASC' && numericVal > threshold) break;
        if (order === 'DESC' && numericVal < threshold) break;
        idx++;
      }
      return idx;
    }

    // Date/TIMESTAMP
    if (currentValue instanceof Date || isISODateString(currentValue)) {
      const currentDate = currentValue instanceof Date ? currentValue : new Date(currentValue);
      const thresholdMs = currentDate.getTime() + (offset * 86400000);
      let idx = currentIndex;
      while (idx < total - 1) {
        const val = partition[idx + 1][orderByCol];
        if (val === null || val === undefined) break;
        const rowDate = val instanceof Date ? val : new Date(val);
        if (isNaN(rowDate.getTime())) break;
        if (order === 'ASC' && rowDate.getTime() > thresholdMs) break;
        if (order === 'DESC' && rowDate.getTime() < thresholdMs) break;
        idx++;
      }
      return idx;
    }

    return currentIndex;
  }
}

/**
 * 在 RANGE 帧中，根据 ORDER BY 值向后寻找帧结束边界。
 */
function findRangeEndBoundary(
  partition: any[],
  currentIndex: number,
  offset: number,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
  direction: 'FOLLOWING' | 'PRECEDING',
  bound: WindowFrameBound,
): number {
  const total = partition.length;
  const currentRow = partition[currentIndex];
  const lastIndex = total - 1;

  if (orderBy.length === 0) {
    return lastIndex;
  }

  const orderByCol = orderBy[0].column;
  const order = orderBy[0].order;
  const currentValue = currentRow[orderByCol];

  if (currentValue === null || currentValue === undefined) {
    let idx = currentIndex;
    while (idx < lastIndex && partition[idx + 1][orderByCol] === null) {
      idx++;
    }
    return idx;
  }

  if (direction === 'FOLLOWING') {
    if (typeof currentValue === 'number') {
      const threshold = order === 'ASC'
        ? currentValue + offset
        : currentValue - offset;
      let idx = currentIndex;
      while (idx < lastIndex) {
        const val = partition[idx + 1][orderByCol];
        if (val === null || val === undefined) break;
        const numericVal = typeof val === 'number' ? val : Number(val);
        if (isNaN(numericVal)) break;
        if (order === 'ASC' && numericVal > threshold) break;
        if (order === 'DESC' && numericVal < threshold) break;
        idx++;
      }
      return idx;
    }

    if (currentValue instanceof Date || isISODateString(currentValue)) {
      const currentDate = currentValue instanceof Date ? currentValue : new Date(currentValue);
      const thresholdMs = currentDate.getTime() + (offset * 86400000);
      let idx = currentIndex;
      while (idx < lastIndex) {
        const val = partition[idx + 1][orderByCol];
        if (val === null || val === undefined) break;
        const rowDate = val instanceof Date ? val : new Date(val);
        if (isNaN(rowDate.getTime())) break;
        if (order === 'ASC' && rowDate.getTime() > thresholdMs) break;
        if (order === 'DESC' && rowDate.getTime() < thresholdMs) break;
        idx++;
      }
      return idx;
    }

    // Fallback — use peer group
    let idx = currentIndex;
    while (idx < lastIndex && orderByValuesEqual(partition[idx + 1], currentRow, orderBy)) {
      idx++;
    }
    return idx;
  } else {
    // PRECEDING as end: RANGE BETWEEN N PRECEDING AND M PRECEDING
    if (typeof currentValue === 'number') {
      let idx = currentIndex;
      const threshold = order === 'ASC'
        ? currentValue - offset
        : currentValue + offset;
      while (idx > 0) {
        const val = partition[idx - 1][orderByCol];
        if (val === null || val === undefined) break;
        const numericVal = typeof val === 'number' ? val : Number(val);
        if (isNaN(numericVal)) break;
        if (order === 'ASC' && numericVal < threshold) break;
        if (order === 'DESC' && numericVal > threshold) break;
        idx--;
      }
      return idx;
    }

    if (currentValue instanceof Date || isISODateString(currentValue)) {
      const currentDate = currentValue instanceof Date ? currentValue : new Date(currentValue);
      const thresholdMs = currentDate.getTime() - (offset * 86400000);
      let idx = currentIndex;
      while (idx > 0) {
        const val = partition[idx - 1][orderByCol];
        if (val === null || val === undefined) break;
        const rowDate = val instanceof Date ? val : new Date(val);
        if (isNaN(rowDate.getTime())) break;
        if (order === 'ASC' && rowDate.getTime() < thresholdMs) break;
        if (order === 'DESC' && rowDate.getTime() > thresholdMs) break;
        idx--;
      }
      return idx;
    }

    return currentIndex;
  }
}

/**
 * 检查值是否为 ISO 日期字符串。
 */
function isISODateString(val: any): boolean {
  if (typeof val !== 'string') return false;
  // Match ISO 8601 date/datetime pattern
  return /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(val);
}

/**
 * 计算帧的起止行索引（GROUPS 模式）。
 * GROUPS 帧基于 peer groups（ORDER BY 值相同的行组成一个组）。
 */
function computeGroupsFrameBounds(
  partition: any[],
  currentIndex: number,
  frame: WindowFrame,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
): { start: number; end: number } {
  const total = partition.length;
  if (orderBy.length === 0) {
    return { start: 0, end: total - 1 };
  }

  // 计算每个行的组号（同一 ORDER BY 值的行共享组号）
  const groupIds: number[] = [];
  let currentGroupId = 0;
  groupIds.push(0);
  for (let i = 1; i < total; i++) {
    if (!orderByValuesEqual(partition[i - 1], partition[i], orderBy)) {
      currentGroupId++;
    }
    groupIds.push(currentGroupId);
  }

  const currentGroup = groupIds[currentIndex];
  let startGroup: number, endGroup: number;

  // 帧起始组
  switch (frame.start.type) {
    case 'UNBOUNDED_PRECEDING':
      startGroup = 0;
      break;
    case 'PRECEDING':
      startGroup = Math.max(0, currentGroup - (frame.start.offset ?? 1));
      break;
    case 'CURRENT_ROW':
      startGroup = currentGroup;
      break;
    case 'FOLLOWING':
      startGroup = currentGroup + (frame.start.offset ?? 1);
      break;
    case 'UNBOUNDED_FOLLOWING':
      startGroup = groupIds[total - 1];
      break;
    default:
      startGroup = 0;
  }

  // 帧结束组
  switch (frame.end.type) {
    case 'UNBOUNDED_PRECEDING':
      endGroup = 0;
      break;
    case 'PRECEDING':
      endGroup = Math.max(0, currentGroup - (frame.end.offset ?? 1));
      break;
    case 'CURRENT_ROW':
      endGroup = currentGroup;
      break;
    case 'FOLLOWING':
      endGroup = Math.min(groupIds[total - 1], currentGroup + (frame.end.offset ?? 1));
      break;
    case 'UNBOUNDED_FOLLOWING':
      endGroup = groupIds[total - 1];
      break;
    default:
      endGroup = groupIds[total - 1];
  }

  // 将组号范围转换为行索引范围
  let start = 0;
  while (start < total && groupIds[start] < startGroup) start++;
  let end = total - 1;
  while (end >= 0 && groupIds[end] > endGroup) end--;

  return { start, end: Math.max(start, end) };
}

/**
 * 计算帧范围内的行。
 */
function getFrameRows(
  partition: any[],
  currentIndex: number,
  frame: WindowFrame,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
): any[] {
  let bounds: { start: number; end: number };

  switch (frame.type) {
    case 'ROWS':
      bounds = computeRowsFrameBounds(partition, currentIndex, frame);
      break;
    case 'RANGE':
      bounds = computeRangeFrameBounds(partition, currentIndex, frame, orderBy);
      break;
    case 'GROUPS':
      bounds = computeGroupsFrameBounds(partition, currentIndex, frame, orderBy);
      break;
    default:
      bounds = { start: 0, end: partition.length - 1 };
  }

  const result: any[] = [];
  for (let i = bounds.start; i <= bounds.end; i++) {
    result.push(partition[i]);
  }
  return result;
}

// ── 聚合窗口函数实现 ──

function windowSum(frameRows: any[], column: string): number {
  let total = 0;
  for (const row of frameRows) {
    total += Number(row[column]) || 0;
  }
  return total;
}

function windowAvg(frameRows: any[], column: string): number | null {
  if (frameRows.length === 0) return null;
  let total = 0;
  let count = 0;
  for (const row of frameRows) {
    const val = Number(row[column]);
    if (!isNaN(val)) {
      total += val;
      count++;
    }
  }
  return count > 0 ? total / count : null;
}

function windowCount(frameRows: any[], column: string): number {
  if (column === '*' || column === '1') {
    return frameRows.length;
  }
  let count = 0;
  for (const row of frameRows) {
    if (row[column] != null) count++;
  }
  return count;
}

function windowMin(frameRows: any[], column: string): number | null {
  if (frameRows.length === 0) return null;
  let min = Infinity;
  for (const row of frameRows) {
    const val = Number(row[column]);
    if (!isNaN(val) && val < min) {
      min = val;
    }
  }
  return min === Infinity ? null : min;
}

function windowMax(frameRows: any[], column: string): number | null {
  if (frameRows.length === 0) return null;
  let max = -Infinity;
  for (const row of frameRows) {
    const val = Number(row[column]);
    if (!isNaN(val) && val > max) {
      max = val;
    }
  }
  return max === -Infinity ? null : max;
}

// ── 解析窗口函数 SQL（使用 regex 解析，兼容 pgsql-ast-parser 不支持的 frame 语法） ──

/**
 * 从 SQL 中解析窗口函数规范。
 *
 * 支持解析以下模式：
 * - ROW_NUMBER() OVER (ORDER BY col)
 * - RANK() OVER (PARTITION BY col ORDER BY val DESC)
 * - SUM(col) OVER (PARTITION BY cat)
 * - AVG(col) OVER (ORDER BY col ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING)
 * - LAG(col, 1, 'default') OVER (ORDER BY col)
 * - NTILE(4) OVER (ORDER BY val)
 *
 * @param sql - 包含窗口函数的 SQL 字符串
 * @returns 解析结果或 null
 */
export function parseWindowSQL(sql: string): {
  function: string;
  args: string[];
  over: WindowSpec;
} | null {
  // 尝试使用 pgsql-ast-parser（支持无 frame 的窗口函数）
  try {
    const { parse } = require('pgsql-ast-parser');
    const ast = parse(sql);
    if (Array.isArray(ast) && ast.length > 0) {
      const stmt = ast[0] as any;
      if (stmt && stmt.columns) {
        for (const col of stmt.columns) {
          const expr = col.expr || col;
          if (expr && expr.type === 'call' && expr.over) {
            const fnName = expr.function?.name || '';
            const args: string[] = (expr.args || []).map((a: any) => {
              if (a.type === 'ref') return a.name;
              if (a.type === 'integer') return String(a.value);
              if (a.type === 'string') return a.value;
              if (a.type === 'star') return '*';
              return String(a.value ?? a.name ?? '');
            });

            const over = expr.over;
            const partitionBy: string[] = (over.partitionBy || []).map(
              (p: any) => p.name || (p.type === 'ref' ? p.name : String(p)),
            );
            const orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }> = (
              over.orderBy || []
            ).map((o: any) => ({
              column: o.by?.name || String(o.by ?? ''),
              order: (o.order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
            }));

            // 检查是否包含 frame 信息（pgsql-ast-parser 可能没有 frame 字段）
            let frame: WindowFrame;
            if (over.frame) {
              const f = over.frame;
              frame = {
                type: (f.type || 'RANGE').toUpperCase() as 'ROWS' | 'RANGE' | 'GROUPS',
                start: parseFrameBound(f.start),
                end: parseFrameBound(f.end),
              };
            } else {
              // 没有指定 frame：默认为 RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              frame = { ...DEFAULT_FRAME };
            }

            return {
              function: fnName,
              args,
              over: { partitionBy, orderBy, frame },
            };
          }
        }
      }
    }
  } catch {
    // pgsql-ast-parser 不支持带 frame 的窗口函数，降级到 regex
  }

  // 正则降级解析
  return parseWindowSQLRegex(sql);
}

function parseFrameBound(bound: any): WindowFrameBound {
  if (!bound) return { type: 'CURRENT_ROW' };

  const type = (bound.type || '').toUpperCase();
  const value = bound.value;

  switch (type) {
    case 'UNBOUNDED_PRECEDING':
      return { type: 'UNBOUNDED_PRECEDING' };
    case 'UNBOUNDED_FOLLOWING':
      return { type: 'UNBOUNDED_FOLLOWING' };
    case 'PRECEDING':
      return { type: 'PRECEDING', offset: value != null ? Number(value) : 1 };
    case 'FOLLOWING':
      return { type: 'FOLLOWING', offset: value != null ? Number(value) : 1 };
    case 'CURRENT_ROW':
    default:
      return { type: 'CURRENT_ROW' };
  }
}

/**
 * 正则降级解析窗口函数 SQL（兼容 frame 规范）。
 * 覆盖 pgsql-ast-parser 不支持的 ROWS/RANGE/GROUPS BETWEEN 语法。
 */
function parseWindowSQLRegex(sql: string): {
  function: string;
  args: string[];
  over: WindowSpec;
} | null {
  // 匹配模式: FUNC_NAME(args) OVER (PARTITION BY ... ORDER BY ... FRAME_SPEC ... EXCLUDE ...)
  // 其中 FRAME_SPEC 可以是 ROWS/RANGE/GROUPS BETWEEN ... AND ...
  const simpleOverMatch = sql.match(
    /\b(\w+)\s*\(([^()]*)\)\s*OVER\s*\(\s*((?:PARTITION\s+BY\s+[^()]+?\s+)?(?:ORDER\s+BY\s+[^()]+?)?(?:\s+(?:ROWS|RANGE|GROUPS)\s+(?:BETWEEN\s+[^()]+?\s+AND\s+[^()]+?|UNBOUNDED\s+PRECEDING|CURRENT\s+ROW))?[^()]*?)\s*\)/i,
  );

  if (!simpleOverMatch) {
    return null;
  }

  const fnName = simpleOverMatch[1].toLowerCase();
  const argsStr = simpleOverMatch[2].trim();
  const overStr = simpleOverMatch[3].trim();

  // 解析参数
  const args: string[] = argsStr
    ? argsStr.split(',').map(a => a.trim().replace(/^['"]|['"]$/g, ''))
    : [];

  // 解析 PARTITION BY
  const partitionMatch = overStr.match(/PARTITION\s+BY\s+(.+?)(?:\s+ORDER\s+BY\s+|$)/i);
  const partitionBy = partitionMatch
    ? partitionMatch[1].split(',').map(c => c.trim().replace(/["`]/g, ''))
    : [];

  // 解析 ORDER BY
  const orderMatch = overStr.match(/ORDER\s+BY\s+(.+?)(?:\s+(?:ROWS|RANGE|GROUPS)\s|$)/i);
  const orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }> = orderMatch
    ? orderMatch[1].split(',').map(p => {
        const tokens = p.trim().split(/\s+/);
        const column = tokens[0].replace(/["`]/g, '');
        const order = tokens.length > 1 && tokens[1].toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        return { column, order };
      })
    : [];

  // 解析 frame
  const frame = parseFrameFromOver(overStr);

  // 解析 EXCLUDE
  const exclude = parseExcludeMode(sql);

  return {
    function: fnName,
    args,
    over: { partitionBy, orderBy, frame, ...(exclude !== 'NO OTHERS' ? { exclude } : {}) },
  };
}

/**
 * 从 OVER 子句字符串中解析 frame 规范。
 */
function parseFrameFromOver(overStr: string): WindowFrame {
  // 匹配 ROWS/RANGE/GROUPS BETWEEN ... AND ...
  const betweenFrameMatch = overStr.match(
    /(ROWS|RANGE|GROUPS)\s+BETWEEN\s+(\w+(?:\s+\w+)?)\s+AND\s+(\w+(?:\s+\w+)?)/i,
  );
  if (betweenFrameMatch) {
    const frameType = betweenFrameMatch[1].toUpperCase() as 'ROWS' | 'RANGE' | 'GROUPS';
    const start = parseFrameBoundStr(betweenFrameMatch[2]);
    const end = parseFrameBoundStr(betweenFrameMatch[3]);
    return { type: frameType, start, end };
  }

  // 匹配 ROWS/RANGE/GROUPS UNBOUNDED PRECEDING
  const unboundedPrecedingMatch = overStr.match(
    /(ROWS|RANGE|GROUPS)\s+UNBOUNDED\s+PRECEDING/i,
  );
  if (unboundedPrecedingMatch) {
    const frameType = unboundedPrecedingMatch[1].toUpperCase() as 'ROWS' | 'RANGE' | 'GROUPS';
    return {
      type: frameType,
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'CURRENT_ROW' },
    };
  }

  // 匹配 ROWS/RANGE/GROUPS CURRENT ROW
  const currentRowMatch = overStr.match(/(ROWS|RANGE|GROUPS)\s+CURRENT\s+ROW/i);
  if (currentRowMatch) {
    const frameType = currentRowMatch[1].toUpperCase() as 'ROWS' | 'RANGE' | 'GROUPS';
    return {
      type: frameType,
      start: { type: 'CURRENT_ROW' },
      end: { type: 'CURRENT_ROW' },
    };
  }

  // 默认 frame
  return { ...DEFAULT_FRAME };
}

/**
 * 解析 frame 边界字符串。
 */
function parseFrameBoundStr(boundStr: string): WindowFrameBound {
  const s = boundStr.trim().toUpperCase();

  if (s === 'UNBOUNDED PRECEDING') return { type: 'UNBOUNDED_PRECEDING' };
  if (s === 'UNBOUNDED FOLLOWING') return { type: 'UNBOUNDED_FOLLOWING' };
  if (s === 'CURRENT ROW') return { type: 'CURRENT_ROW' };

  const precedingMatch = s.match(/^(\d+)\s+PRECEDING$/);
  if (precedingMatch) {
    return { type: 'PRECEDING', offset: parseInt(precedingMatch[1], 10) };
  }

  const followingMatch = s.match(/^(\d+)\s+FOLLOWING$/);
  if (followingMatch) {
    return { type: 'FOLLOWING', offset: parseInt(followingMatch[1], 10) };
  }

  return { type: 'CURRENT_ROW' };
}

// ── 核心窗口函数执行 ──

/**
 * 执行窗口函数。
 *
 * @param rows         输入行数据
 * @param functionName 窗口函数名（小写）
 * @param args         函数参数
 * @param windowSpec   窗口规范
 * @param outputColumn 输出列名（默认使用函数名）
 * @returns 添加了窗口函数列的新行数组
 */
export function executeWindowFunction(
  rows: any[],
  functionName: string,
  args: string[],
  windowSpec: WindowSpec,
  outputColumn?: string,
): any[] {
  if (rows.length === 0) return [];

  const fn = functionName.toLowerCase();
  const col = outputColumn || fn;
  const result: any[] = rows.map(r => ({ ...r })); // 浅拷贝避免修改原数据

  const { partitionBy, orderBy, frame } = windowSpec;

  // 按 PARTITION BY 分组
  const partitions = partitionBy.length > 0
    ? partitionRows(result, partitionBy)
    : new Map<string, any[]>([['all', result]]);

  for (const [, partition] of partitions) {
    if (partition.length === 0) continue;

    // 排序分区
    sortPartition(partition, orderBy);

    // 构建 ORDER BY 值数组（用于 EXCLUDE 子句中的 peer group 检测）
    const orderByValues = partition.map(row => {
      if (orderBy.length === 0) return {};
      const vals: Record<string, any> = {};
      for (const ob of orderBy) {
        vals[ob.column] = row[ob.column];
      }
      return vals;
    });
    const excludeMode = windowSpec.exclude ?? 'NO OTHERS';

    // 根据函数类型执行
    switch (fn) {
      case 'row_number':
        executeRowNumber(partition, col);
        break;
      case 'rank':
        executeRank(partition, col, orderBy);
        break;
      case 'dense_rank':
        executeDenseRank(partition, col, orderBy);
        break;
      case 'cume_dist':
        executeCumeDist(partition, col, orderBy);
        break;
      case 'percent_rank':
        executePercentRank(partition, col, orderBy);
        break;
      case 'ntile':
        executeNtile(partition, col, args);
        break;
      case 'lag':
        executeLag(partition, col, args);
        break;
      case 'lead':
        executeLead(partition, col, args);
        break;
      case 'first_value':
        executeFirstValue(partition, col, args);
        break;
      case 'last_value':
        executeLastValue(partition, col, args, orderBy, frame, orderByValues, excludeMode);
        break;
      case 'nth_value':
        executeNthValue(partition, col, args);
        break;
      case 'sum':
        executeAggWindow(partition, col, args, 'sum', orderBy, frame, orderByValues, excludeMode);
        break;
      case 'avg':
        executeAggWindow(partition, col, args, 'avg', orderBy, frame, orderByValues, excludeMode);
        break;
      case 'count':
        executeAggWindow(partition, col, args, 'count', orderBy, frame, orderByValues, excludeMode);
        break;
      case 'max':
        executeAggWindow(partition, col, args, 'max', orderBy, frame, orderByValues, excludeMode);
        break;
      case 'min':
        executeAggWindow(partition, col, args, 'min', orderBy, frame, orderByValues, excludeMode);
        break;
      default:
        logger.warn({ fn }, 'Unknown window function, setting to null');
        for (const row of partition) {
          row[col] = null;
        }
    }
  }

  return result;
}

// ── 排名函数实现 ──

/**
 * ROW_NUMBER() — 分区内逐行递增编号。
 */
function executeRowNumber(partition: any[], outputColumn: string): void {
  let counter = 1;
  for (const row of partition) {
    row[outputColumn] = counter++;
  }
}

/**
 * RANK() — 相同值共享序号，下一值跳过。
 * 当 ORDER BY 值变化时，序号 = 已处理行数 + 1。
 */
function executeRank(
  partition: any[],
  outputColumn: string,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
): void {
  if (partition.length === 0) return;
  if (orderBy.length === 0) {
    // 无 ORDER BY：所有行 rank = 1
    for (const row of partition) {
      row[outputColumn] = 1;
    }
    return;
  }

  let rank = 1;
  let processed = 1;
  partition[0][outputColumn] = rank;

  for (let i = 1; i < partition.length; i++) {
    processed++;
    if (!orderByValuesEqual(partition[i - 1], partition[i], orderBy)) {
      rank = processed;
    }
    partition[i][outputColumn] = rank;
  }
}

/**
 * DENSE_RANK() — 相同值共享序号，下一值连续递增。
 * 当 ORDER BY 值变化时，序号递增 1。
 */
function executeDenseRank(
  partition: any[],
  outputColumn: string,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
): void {
  if (partition.length === 0) return;
  if (orderBy.length === 0) {
    for (const row of partition) {
      row[outputColumn] = 1;
    }
    return;
  }

  let rank = 1;
  partition[0][outputColumn] = rank;

  for (let i = 1; i < partition.length; i++) {
    if (!orderByValuesEqual(partition[i - 1], partition[i], orderBy)) {
      rank++;
    }
    partition[i][outputColumn] = rank;
  }
}

/**
 * CUME_DIST() — 累计分布：`(当前行之前或与当前行同值的行数) / (分区总行数)`。
 *
 * 返回值范围 (0, 1]。对于 ORDER BY 值最小的行，CUME_DIST = 1/N（N 为分区行数）。
 * 如果没有 ORDER BY，所有行的 CUME_DIST = 1。
 */
function executeCumeDist(
  partition: any[],
  outputColumn: string,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
): void {
  const total = partition.length;
  if (total === 0) return;

  if (orderBy.length === 0) {
    for (const row of partition) {
      row[outputColumn] = 1;
    }
    return;
  }

  // 对于每行，计算 peer group 的结束索引（同 ORDER BY 值的最后一行）
  let i = 0;
  while (i < total) {
    // 找到与当前行同值（peer）的组的结束位置
    let peerEnd = i;
    while (peerEnd + 1 < total && orderByValuesEqual(partition[peerEnd], partition[peerEnd + 1], orderBy)) {
      peerEnd++;
    }

    // 该 peer 组中所有行的 CUME_DIST 值相同
    const cumeDist = (peerEnd + 1) / total;
    for (let j = i; j <= peerEnd; j++) {
      partition[j][outputColumn] = cumeDist;
    }

    i = peerEnd + 1;
  }
}

/**
 * PERCENT_RANK() — 百分比排名：`(rank - 1) / (total - 1)`。
 *
 * 返回值范围 [0, 1]。第一行（rank=1）的 PERCENT_RANK = 0。
 * 如果分区只有一行，PERCENT_RANK = 0。
 * 如果没有 ORDER BY，所有行的 PERCENT_RANK = 0。
 */
function executePercentRank(
  partition: any[],
  outputColumn: string,
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
): void {
  const total = partition.length;
  if (total === 0) return;

  if (orderBy.length === 0) {
    for (const row of partition) {
      row[outputColumn] = 0;
    }
    return;
  }

  const denominator = Math.max(total - 1, 1); // 避免除零

  // 先计算 RANK 值，然后转换为 PERCENT_RANK
  let rank = 1;
  let processed = 1;
  partition[0][outputColumn] = 0; // rank=1 → (1-1)/denom = 0

  for (let i = 1; i < total; i++) {
    processed++;
    if (!orderByValuesEqual(partition[i - 1], partition[i], orderBy)) {
      rank = processed;
    }
    partition[i][outputColumn] = (rank - 1) / denominator;
  }
}

/**
 * NTILE(N) — 将分区分为 N 个桶。
 * 桶大小 = floor(行数 / N)，多余的行均匀分配到前几个桶。
 */
function executeNtile(
  partition: any[],
  outputColumn: string,
  args: string[],
): void {
  const n = args.length > 0 ? parseInt(args[0], 10) : 1;
  const total = partition.length;

  if (n <= 0 || total === 0) {
    for (const row of partition) {
      row[outputColumn] = null;
    }
    return;
  }

  const tileSize = Math.floor(total / n);
  const remainder = total % n;

  let currentTile = 1;
  let countInTile = 0;

  for (let i = 0; i < total; i++) {
    partition[i][outputColumn] = currentTile;
    countInTile++;

    // 判断是否应切换到下一个桶
    const thisTileSize = tileSize + (currentTile <= remainder ? 1 : 0);
    if (countInTile >= thisTileSize && currentTile < n) {
      currentTile++;
      countInTile = 0;
    }
  }
}

// ── 偏移函数实现 ──

/**
 * LAG(col, offset, default) — 向前取第 offset 行的值。
 * offset 默认 1，default 默认 null。
 */
function executeLag(
  partition: any[],
  outputColumn: string,
  args: string[],
): void {
  const column = args[0] || '';
  const offset = args.length > 1 ? parseInt(args[1], 10) : 1;
  const defaultValue = args.length > 2 ? args[2] : null;

  if (!column) {
    for (const row of partition) {
      row[outputColumn] = null;
    }
    return;
  }

  for (let i = 0; i < partition.length; i++) {
    const lagIndex = i - offset;
    if (lagIndex >= 0) {
      partition[i][outputColumn] = partition[lagIndex][column];
    } else {
      partition[i][outputColumn] = defaultValue;
    }
  }
}

/**
 * LEAD(col, offset, default) — 向后取第 offset 行的值。
 * offset 默认 1，default 默认 null。
 */
function executeLead(
  partition: any[],
  outputColumn: string,
  args: string[],
): void {
  const column = args[0] || '';
  const offset = args.length > 1 ? parseInt(args[1], 10) : 1;
  const defaultValue = args.length > 2 ? args[2] : null;

  if (!column) {
    for (const row of partition) {
      row[outputColumn] = null;
    }
    return;
  }

  for (let i = 0; i < partition.length; i++) {
    const leadIndex = i + offset;
    if (leadIndex < partition.length) {
      partition[i][outputColumn] = partition[leadIndex][column];
    } else {
      partition[i][outputColumn] = defaultValue;
    }
  }
}

/**
 * FIRST_VALUE(col) — 分区内第一行的值。
 * 如果指定了 ORDER BY，第一行是排序后的第一行。
 */
function executeFirstValue(
  partition: any[],
  outputColumn: string,
  args: string[],
): void {
  const column = args[0] || '';
  if (!column || partition.length === 0) {
    for (const row of partition) {
      row[outputColumn] = null;
    }
    return;
  }

  const firstVal = partition[0][column];
  for (const row of partition) {
    row[outputColumn] = firstVal;
  }
}

/**
 * LAST_VALUE(col) — 分区内最后一行的值。
 * 默认 frame 为 RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW，
 * 因此 LAST_VALUE 默认返回当前行的值。如果需要分区最后一行，
 * 必须显式指定 frame: RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING。
 */
function executeLastValue(
  partition: any[],
  outputColumn: string,
  args: string[],
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
  frame: WindowFrame,
  orderByValues?: Array<Record<string, any>>,
  excludeMode?: ExcludeMode,
): void {
  const column = args[0] || '';
  if (!column || partition.length === 0) {
    for (const row of partition) {
      row[outputColumn] = null;
    }
    return;
  }

  const mode = excludeMode ?? 'NO OTHERS';

  for (let i = 0; i < partition.length; i++) {
    let frameRows = getFrameRows(partition, i, frame, orderBy);
    if (mode !== 'NO OTHERS' && orderByValues) {
      frameRows = applyExcludeClause(frameRows, i, partition, orderByValues, mode);
    }
    if (frameRows.length > 0) {
      partition[i][outputColumn] = frameRows[frameRows.length - 1][column];
    } else {
      partition[i][outputColumn] = null;
    }
  }
}

/**
 * NTH_VALUE(col, N) — 分区内第 N 行的值（从 1 开始）。
 */
function executeNthValue(
  partition: any[],
  outputColumn: string,
  args: string[],
): void {
  const column = args[0] || '';
  const n = args.length > 1 ? parseInt(args[1], 10) : 1;

  if (!column || partition.length === 0 || n < 1) {
    for (const row of partition) {
      row[outputColumn] = null;
    }
    return;
  }

  const nthIndex = n - 1;
  const nthVal = nthIndex < partition.length ? partition[nthIndex][column] : null;
  for (const row of partition) {
    row[outputColumn] = nthVal;
  }
}

// ── 聚合窗口函数实现 ──

/**
 * 聚合窗口函数（SUM/AVG/COUNT/MAX/MIN over window frame）。
 */
function executeAggWindow(
  partition: any[],
  outputColumn: string,
  args: string[],
  aggFn: 'sum' | 'avg' | 'count' | 'max' | 'min',
  orderBy: Array<{ column: string; order: 'ASC' | 'DESC' }>,
  frame: WindowFrame,
  orderByValues?: Array<Record<string, any>>,
  excludeMode?: ExcludeMode,
): void {
  const column = args[0] || '*';
  const mode = excludeMode ?? 'NO OTHERS';

  for (let i = 0; i < partition.length; i++) {
    let frameRows = getFrameRows(partition, i, frame, orderBy);
    if (mode !== 'NO OTHERS' && orderByValues) {
      frameRows = applyExcludeClause(frameRows, i, partition, orderByValues, mode);
    }
    let val: any;

    switch (aggFn) {
      case 'sum':
        val = windowSum(frameRows, column);
        break;
      case 'avg':
        val = windowAvg(frameRows, column);
        break;
      case 'count':
        val = windowCount(frameRows, column);
        break;
      case 'max':
        val = windowMax(frameRows, column);
        break;
      case 'min':
        val = windowMin(frameRows, column);
        break;
    }

    partition[i][outputColumn] = val;
  }
}
