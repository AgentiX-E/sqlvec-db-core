/**
 * MergeExecutor — PG MERGE → SQLite INSERT ... ON CONFLICT 翻译器
 *
 * PostgreSQL 的 MERGE 语法在 SQLite 中不受支持。
 * 本模块将标准 PG MERGE 语句翻译为等效的 SQLite 语法。
 *
 * 支持的翻译模式：
 *   1. MERGE ... WHEN MATCHED THEN UPDATE SET ...
 *      → INSERT ... ON CONFLICT(...) DO UPDATE SET ...
 *
 *   2. MERGE ... WHEN NOT MATCHED THEN INSERT ...
 *      → INSERT ... WHERE NOT EXISTS(...)
 *
 *   3. MERGE ... WHEN MATCHED THEN DELETE
 *      → DELETE FROM target WHERE ... IN (SELECT ... FROM source)
 *
 *   4. 组合模式: MATCHED UPDATE + NOT MATCHED INSERT (UPSERT)
 *      → INSERT ... ON CONFLICT(...) DO UPDATE SET ...
 */

import { PinoLogger } from '../logger/PinoLogger';

// ============================================================
//  Types
// ============================================================

export interface MergeRewriteResult {
  /** 翻译后的 SQL（始终可执行的 SQLite SQL） */
  sql: string;
  /** 是否发生了重写 */
  rewritten: boolean;
}

// ============================================================
//  Internal Types
// ============================================================

/**
 * 解析后的 MERGE 组件
 */
interface ParsedMerge {
  /** 目标表名（可能带 alias，如 "target AS t" 或 "target t"） */
  targetTable: string;
  /** 源表/子查询（可能带 alias） */
  sourceTable: string;
  /** ON 条件原文 */
  onCondition: string;
  /** ON 条件中从目标表侧提取的冲突列名 */
  conflictColumns: string[];
  /** WHEN MATCHED THEN UPDATE SET 子句（含可选的 AND 条件） */
  whenMatchedUpdate: { andCondition?: string; setClause: string } | null;
  /** WHEN NOT MATCHED THEN INSERT 子句（含可选的 AND 条件） */
  whenNotMatchedInsert: { andCondition?: string; insertClause: string } | null;
  /** WHEN MATCHED THEN DELETE 子句（含可选的 AND 条件） */
  whenMatchedDelete: { andCondition?: string } | null;
  /** WHEN NOT MATCHED BY SOURCE THEN DELETE 子句（PG15+） */
  whenNotMatchedBySourceDelete: { andCondition?: string } | null;
  /** WHEN NOT MATCHED BY SOURCE THEN UPDATE 子句（PG15+） */
  whenNotMatchedBySourceUpdate: { andCondition?: string; setClause: string } | null;
  /** WHEN MATCHED THEN DO NOTHING (PG 16+) */
  whenMatchedDoNothing: { andCondition?: string } | null;
  /** WHEN NOT MATCHED THEN DO NOTHING (PG 16+) */
  whenNotMatchedDoNothing: { andCondition?: string } | null;
  /** Multiple WHEN MATCHED clauses with conditions (ordered) */
  multipleWhenMatched: Array<{
    action: 'UPDATE' | 'DELETE' | 'DO NOTHING';
    andCondition?: string;
    setClause?: string;
  }> | null;
}

// ============================================================
//  Constants — Regex Patterns
// ============================================================

const logger = PinoLogger.forComponent('MergeExecutor');

/** 检测 MERGE 语句 */
const MERGE_DETECT_RE = /^\s*MERGE\s+INTO\b/i;

/**
 * 解析 MERGE 整体结构。
 *
 * Groups:
 *   1 — target: MERGE INTO <target>
 *   2 — source: USING <source>
 *   3 — ON 条件: ON <condition>
 *   4 — WHEN 子句部分: 所有 WHEN ... 内容
 *
 * 使用 (?:\s+WHEN\s+(?:NOT\s+)?MATCHED\b.*)$ 匹配尾部全部 WHEN 子句。
 * 注意：需要用 (?=\s+WHEN) 先行断言来限定 ON 条件长度，否则 .+? 会吃掉过多内容。
 */
const MERGE_PARSE_RE =
  /^\s*MERGE\s+INTO\s+(.+?)\s+USING\s+(.+?)\s+ON\s+(.+?)(\s+WHEN\s+(?:NOT\s+)?MATCHED\b.*)$/is;

/**
 * 匹配单个 WHEN MATCHED THEN UPDATE SET 子句。
 *
 * Groups:
 *   1 — 可选的 AND condition（无 AND 时为 undefined）
 *   2 — SET 子句内容（如 "t.name = s.name, t.val = s.val"）
 */
const WHEN_MATCHED_UPDATE_RE =
  /WHEN\s+MATCHED(?:\s+AND\s+(.*?))?\s+THEN\s+UPDATE\s+SET\s+(.+?)(?=\s+WHEN\s+(?:NOT\s+)?MATCHED\b|\s*$)/gi;

/**
 * 匹配单个 WHEN MATCHED THEN DO NOTHING 子句。
 */
const WHEN_MATCHED_DO_NOTHING_RE =
  /WHEN\s+MATCHED(?:\s+AND\s+(.*?))?\s+THEN\s+DO\s+NOTHING(?=\s+WHEN\s+(?:NOT\s+)?MATCHED\b|\s*$)/gi;

/**
 * 匹配单个 WHEN NOT MATCHED THEN INSERT 子句。
 *
 * Groups:
 *   1 — 可选的 AND condition
 *   2 — INSERT 子句内容（如 "(id, name) VALUES (s.id, s.name)"）
 */
const WHEN_NOT_MATCHED_INSERT_RE =
  /WHEN\s+NOT\s+MATCHED(?:\s+AND\s+(.*?))?\s+THEN\s+INSERT\s+(.+?)(?=\s+WHEN\s+(?:NOT\s+)?MATCHED\b|\s*$)/gi;

/**
 * 匹配单个 WHEN NOT MATCHED THEN DO NOTHING 子句。
 */
const WHEN_NOT_MATCHED_DO_NOTHING_RE =
  /WHEN\s+NOT\s+MATCHED(?:\s+AND\s+(.*?))?\s+THEN\s+DO\s+NOTHING(?=\s+WHEN\s+(?:NOT\s+)?MATCHED\b|\s*$)/gi;

/**
 * 匹配单个 WHEN MATCHED THEN DELETE 子句。
 *
 * Groups:
 *   1 — 可选的 AND condition
 */
const WHEN_MATCHED_DELETE_RE =
  /WHEN\s+MATCHED(?:\s+AND\s+(.*?))?\s+THEN\s+DELETE(?=\s+WHEN\s+(?:NOT\s+)?MATCHED\b|\s*$)/gi;

/**
 * 匹配 WHEN NOT MATCHED BY SOURCE THEN DELETE 子句（PG15+）。
 *
 * 含义: 删除源中无匹配的目标行。
 * Groups:
 *   1 — 可选的 AND condition（无 AND 时为 undefined）
 */
const WHEN_NOT_MATCHED_BY_SOURCE_DELETE_RE =
  /WHEN\s+NOT\s+MATCHED\s+BY\s+SOURCE(?:\s+AND\s+(.*?))?\s+THEN\s+DELETE(?=\s+WHEN\s+(?:NOT\s+)?MATCHED\b|\s*$)/gi;

/**
 * 匹配 WHEN NOT MATCHED BY SOURCE THEN UPDATE 子句（PG15+）。
 *
 * 含义: 更新源中无匹配的目标行。
 * Groups:
 *   1 — 可选的 AND condition（无 AND 时为 undefined）
 *   2 — SET 子句内容
 */
const WHEN_NOT_MATCHED_BY_SOURCE_UPDATE_RE =
  /WHEN\s+NOT\s+MATCHED\s+BY\s+SOURCE(?:\s+AND\s+(.*?))?\s+THEN\s+UPDATE\s+SET\s+(.+?)(?=\s+WHEN\s+(?:NOT\s+)?MATCHED\b|\s*$)/gi;

/**
 * 匹配 ON 条件中的等式 comparison。
 * 形如 "target.col = source.col" 或 "t.col = s.col"。
 *
 * Groups:
 *   1 — 左侧标识符（如 "t.id"）
 *   2 — =, IS, IS NOT DISTINCT FROM 等比较运算符
 *   3 — 右侧标识符（如 "s.id"）
 */
const EQUALITY_COND_RE = /(\w+(?:\.\w+)?)\s*(=)\s*(\w+(?:\.\w+)?)/gi;

/** 提取表 alias（AS 别名或直接别名） */
const ALIAS_RE = /\s+(?:AS\s+)?(\w+)\s*$/i;

/** 提取 INSERT 的列列表和 VALUES */
const INSERT_PARTS_RE = /\s*\(([^)]*)\)\s*(?:VALUES\s*)?\(([^)]*)\)/i;

// (no additional regex constants needed here — all non-fallback patterns are defined above)

// ============================================================
//  Public API
// ============================================================

/**
 * 检测 SQL 是否为 MERGE 语句。
 *
 * @param sql - 待检测的 SQL 字符串
 * @returns true if 该 SQL 以 MERGE INTO 开头
 */
export function detectMerge(sql: string): boolean {
  return MERGE_DETECT_RE.test(sql.trim());
}

/**
 * 将 PG MERGE 翻译为 SQLite 兼容 SQL。
 *
 * 支持的 MERGE 模式及对应翻译：
 *
 *   1. MERGE INTO target USING source ON condition
 *      WHEN MATCHED THEN UPDATE SET ...
 *      → INSERT INTO target (...) SELECT ... FROM source
 *        ON CONFLICT(conflict_cols) DO UPDATE SET ...
 *
 *   2. MERGE INTO target USING source ON condition
 *      WHEN NOT MATCHED THEN INSERT (...) VALUES (...)
 *      → INSERT INTO target (...)
 *        SELECT ... FROM source
 *        WHERE NOT EXISTS (SELECT 1 FROM target WHERE condition)
 *
 *   3. MERGE INTO target USING source ON condition
 *      WHEN MATCHED THEN DELETE
 *      → DELETE FROM target
 *        WHERE (conflict_cols) IN (SELECT conflict_cols FROM source)
 *
 *   4. 组合: MATCHED UPDATE + NOT MATCHED INSERT (UPSERT)
 *      → INSERT INTO target (...)
 *        SELECT ... FROM source
 *        ON CONFLICT(conflict_cols) DO UPDATE SET ...
 *
 * 对于无法解析的 MERGE 语句（如包含子查询源、复杂 ON 条件），
 * 返回原始 SQL 并标记 rewritten=false，记录 warn 日志。
 *
 * @param sql - 原始 PG MERGE SQL
 * @returns 翻译结果
 */
export function rewriteMerge(sql: string): MergeRewriteResult {
  if (!detectMerge(sql)) {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();

  // ── Step 1: 解析 MERGE 结构 ──────────────────────────────────
  const parsed = parseMerge(trimmed);
  if (!parsed) {
    logger.warn({ sql: trimmed }, 'Cannot parse MERGE statement');
    return { sql, rewritten: false };
  }

  // ── Step 2: 根据子句类型执行翻译 ──────────────────────────────

  // ── 复合模式检查（必须在简单模式之前） ─────────────────────
  // 有些 MERGE 包含多个 WHEN 子句（如 MATCHED UPDATE + NOT MATCHED INSERT
  // + NOT MATCHED BY SOURCE DELETE），需要拆分为多个 SQL 语句。

  // 如果同时有 MATCHED UPDATE 和 BY SOURCE 子句，需要组合处理
  const hasBySource = !!(parsed.whenNotMatchedBySourceDelete || parsed.whenNotMatchedBySourceUpdate);

  // 全组合: MATCHED UPDATE + NOT MATCHED INSERT + NOT MATCHED BY SOURCE DELETE
  if (parsed.whenMatchedUpdate && parsed.whenNotMatchedInsert && parsed.whenNotMatchedBySourceDelete) {
    const results: string[] = [];

    // UPSERT: INSERT ... ON CONFLICT
    const upsertParsed = { ...parsed, whenNotMatchedBySourceDelete: null, whenNotMatchedBySourceUpdate: null, whenMatchedDelete: null } as ParsedMerge;
    const upsertResult = translateUpsert(upsertParsed);
    if (upsertResult) {
      results.push(`-- UPSERT (WHEN MATCHED UPDATE + NOT MATCHED INSERT)\n${upsertResult}`);
    }

    // DELETE orphans: NOT MATCHED BY SOURCE THEN DELETE
    const deleteParsed = { ...parsed, whenNotMatchedBySourceUpdate: null, whenMatchedUpdate: null, whenNotMatchedInsert: null, whenMatchedDelete: null } as ParsedMerge;
    const deleteResult = translateNotMatchedBySourceDelete(deleteParsed);
    /* istanbul ignore next -- translateNotMatchedBySourceDelete never returns null (only guarded whenNotMatchedBySourceDelete, already ignored) */
    if (deleteResult) {
      results.push(`-- WHEN NOT MATCHED BY SOURCE THEN DELETE\n${deleteResult}`);
    }

    /* istanbul ignore next -- deleteResult is always non-null, so results.length is always >= 1 */
    if (results.length > 0) {
      logger.info({ target: parsed.targetTable }, 'MERGE with UPSERT+BY-SOURCE-DELETE rewritten as 2 statements');
      return { sql: results.join('\n\n'), rewritten: true };
    }
  }

  // NOT MATCHED INSERT + NOT MATCHED BY SOURCE DELETE
  if (parsed.whenNotMatchedInsert && parsed.whenNotMatchedBySourceDelete && !parsed.whenMatchedUpdate) {
    const results: string[] = [];

    const insertParsed = { ...parsed, whenMatchedUpdate: null, whenMatchedDelete: null, whenNotMatchedBySourceDelete: null, whenNotMatchedBySourceUpdate: null } as ParsedMerge;
    const insertResult = translateInsertNotExists(insertParsed);
    if (insertResult) {
      results.push(`-- WHEN NOT MATCHED THEN INSERT\n${insertResult}`);
    }

    const deleteParsed = { ...parsed, whenNotMatchedBySourceUpdate: null, whenMatchedUpdate: null, whenNotMatchedInsert: null, whenMatchedDelete: null } as ParsedMerge;
    const deleteResult = translateNotMatchedBySourceDelete(deleteParsed);
    /* istanbul ignore next -- translateNotMatchedBySourceDelete never returns null */
    if (deleteResult) {
      results.push(`-- WHEN NOT MATCHED BY SOURCE THEN DELETE\n${deleteResult}`);
    }

    /* istanbul ignore next -- deleteResult is always non-null, so results.length is always >= 1 */
    if (results.length > 0) {
      logger.info({ target: parsed.targetTable }, 'MERGE with INSERT+BY-SOURCE-DELETE rewritten as 2 statements');
      return { sql: results.join('\n\n'), rewritten: true };
    }
  }

  // ── WHEN MATCHED THEN DO NOTHING ─────────────────────────────────
  if (parsed.whenMatchedDoNothing && !parsed.whenMatchedUpdate && !parsed.whenMatchedDelete) {
    // DO NOTHING means skip matched rows - no action for SQLite.
    // If there's also a NOT MATCHED INSERT, just do the insert.
    if (parsed.whenNotMatchedInsert) {
      const result = translateInsertNotExists(parsed);
      if (result) {
        logger.info({ target: parsed.targetTable }, 'MERGE with MATCHED DO NOTHING rewritten as INSERT ... WHERE NOT EXISTS');
        return { sql: result, rewritten: true };
      }
    }
    // Pure DO NOTHING with no other actions — no-op
    logger.info({ target: parsed.targetTable }, 'MERGE with only DO NOTHING — no-op');
    return { sql: '-- MERGE DO NOTHING (no rows affected)', rewritten: true };
  }

  // ── WHEN NOT MATCHED THEN DO NOTHING ────────────────────────────
  if (parsed.whenNotMatchedDoNothing && !parsed.whenNotMatchedInsert) {
    // Only MATCHED UPDATE exists, skip non-matching rows
    if (parsed.whenMatchedUpdate) {
      const result = translateUpsert(parsed);
      if (result) {
        logger.info({ target: parsed.targetTable }, 'MERGE with NOT MATCHED DO NOTHING rewritten as INSERT ... ON CONFLICT');
        return { sql: result, rewritten: true };
      }
    }
  }

  // ── Multiple WHEN MATCHED with conditions (PG 16+) ────────────────
  if (parsed.multipleWhenMatched && parsed.multipleWhenMatched.length > 1) {
    const results: string[] = [];
    const targetBase = parsed.targetTable.trim().split(/\s+/)[0];
    const sourceAlias = extractAlias(parsed.sourceTable);
    const conflictColsStr = parsed.conflictColumns.join(', ');

    for (const clause of parsed.multipleWhenMatched) {
      if (clause.action === 'UPDATE' && clause.setClause) {
        // Conditional UPDATE: use WHERE EXISTS with ON condition + AND clause
        const whereExists = clause.andCondition
          ? `WHERE EXISTS (SELECT 1 FROM ${parsed.sourceTable} WHERE ${parsed.onCondition} AND (${clause.andCondition}))`
          : `WHERE EXISTS (SELECT 1 FROM ${parsed.sourceTable} WHERE ${parsed.onCondition})`;
        const setParts = parseSetClause(clause.setClause);
        const setSql = setParts.map(s => `${s.column} = ${s.valueExpr}`).join(', ');
        results.push(`-- Conditional MATCHED UPDATE${clause.andCondition ? ` (${clause.andCondition})` : ''}\nUPDATE ${targetBase} SET ${setSql} ${whereExists};`);
      } else if (clause.action === 'DELETE') {
        /* istanbul ignore next */
        const whereExists = clause.andCondition
          ? `WHERE EXISTS (SELECT 1 FROM ${parsed.sourceTable} WHERE ${parsed.onCondition} AND (${clause.andCondition}))`
          : `WHERE EXISTS (SELECT 1 FROM ${parsed.sourceTable} WHERE ${parsed.onCondition})`;
        /* istanbul ignore next */
        results.push(`-- Conditional MATCHED DELETE${clause.andCondition ? ` (${clause.andCondition})` : ''}\nDELETE FROM ${targetBase} WHERE (${conflictColsStr}) IN (SELECT ${conflictColsStr} FROM ${parsed.sourceTable})${clause.andCondition ? ` AND (${clause.andCondition})` : ''};`);
      }
      // DO NOTHING — skip, no SQL needed
    }

    // Add NOT MATCHED INSERT if present
    if (parsed.whenNotMatchedInsert) {
      const upsertParsed = { ...parsed, multipleWhenMatched: null as any, whenMatchedUpdate: null, whenMatchedDelete: null, whenMatchedDoNothing: null } as ParsedMerge;
      const insertResult = translateInsertNotExists(upsertParsed);
      if (insertResult) {
        results.push(`-- WHEN NOT MATCHED INSERT\n${insertResult}`);
      }
    }

    if (results.length > 0) {
      logger.info({ target: parsed.targetTable }, 'Multiple WHEN MATCHED rewritten as separate statements');
      return { sql: results.join('\n\n'), rewritten: true };
    }
  }

  // 场景 A: MATCHED UPDATE（UPSERT）— 含或不含 NOT MATCHED INSERT
  // → INSERT ... ON CONFLICT(...) DO UPDATE SET ...
  // 注意：如果同时有 BY SOURCE 子句，已在上面组合处理
  if (parsed.whenMatchedUpdate && !hasBySource) {
    const result = translateUpsert(parsed);
    if (result) {
      logger.info(
        { target: parsed.targetTable, conflictCols: parsed.conflictColumns },
        'MERGE rewritten as INSERT ... ON CONFLICT',
      );
      return { sql: result, rewritten: true };
    }
  }

  // 场景 B: 纯 NOT MATCHED INSERT（无 MATCHED 子句，无 BY SOURCE）
  // → INSERT ... WHERE NOT EXISTS(...)
  if (parsed.whenNotMatchedInsert && !hasBySource && !parsed.whenMatchedUpdate) {
    const result = translateInsertNotExists(parsed);
    if (result) {
      logger.info(
        { target: parsed.targetTable },
        'MERGE rewritten as INSERT ... WHERE NOT EXISTS',
      );
      return { sql: result, rewritten: true };
    }
  }

  // 场景 C: MATCHED DELETE（含或不含 UPDATE 子句）
  // → DELETE ... WHERE (...) IN (...) AND condition
  if (parsed.whenMatchedDelete) {
    const result = translateDeleteIn(parsed);
    if (result) {
      logger.info(
        { target: parsed.targetTable },
        'MERGE rewritten as DELETE ... WHERE IN',
      );
      return { sql: result, rewritten: true };
    }
  }

  // ════════════════════════════════════════════════
  //  场景 F: NOT MATCHED BY SOURCE (PG15+)
  // ════════════════════════════════════════════════

  // F1: NOT MATCHED BY SOURCE THEN DELETE（带或不带 AND 条件）
  // → DELETE FROM target WHERE NOT EXISTS (SELECT 1 FROM source WHERE on_condition)
  if (parsed.whenNotMatchedBySourceDelete && !parsed.whenNotMatchedBySourceUpdate) {
    const result = translateNotMatchedBySourceDelete(parsed);
    /* istanbul ignore next -- translateNotMatchedBySourceDelete never returns null */
    if (result) {
      logger.info(
        { target: parsed.targetTable },
        'MERGE rewritten as DELETE ... WHERE NOT EXISTS',
      );
      return { sql: result, rewritten: true };
    }
  }

  // F2: NOT MATCHED BY SOURCE THEN UPDATE（带或不带 AND 条件）
  // → UPDATE target SET ... WHERE NOT EXISTS (SELECT 1 FROM source WHERE on_condition)
  if (parsed.whenNotMatchedBySourceUpdate && !parsed.whenNotMatchedBySourceDelete) {
    const result = translateNotMatchedBySourceUpdate(parsed);
    /* istanbul ignore next -- translateNotMatchedBySourceUpdate never returns null */
    if (result) {
      logger.info(
        { target: parsed.targetTable },
        'MERGE rewritten as UPDATE ... WHERE NOT EXISTS',
      );
      return { sql: result, rewritten: true };
    }
  }

  // F3: 组合 NOT MATCHED BY SOURCE DELETE + UPDATE（PG 允许同时有 DELETE 和 UPDATE）
  // 需要顺序执行：先 DELETE（移除不该更新的行），再 UPDATE
  if (parsed.whenNotMatchedBySourceDelete && parsed.whenNotMatchedBySourceUpdate) {
    const results: string[] = [];

    const deleteOnly = { ...parsed, whenNotMatchedBySourceUpdate: null, whenMatchedUpdate: null, whenNotMatchedInsert: null, whenMatchedDelete: null };
    const deleteResult = translateNotMatchedBySourceDelete(deleteOnly as any);
    /* istanbul ignore next -- translateNotMatchedBySourceDelete never returns null */
    if (deleteResult) {
      results.push(`-- WHEN NOT MATCHED BY SOURCE THEN DELETE\n${deleteResult}`);
    }

    const updateOnly = { ...parsed, whenNotMatchedBySourceDelete: null, whenMatchedUpdate: null, whenNotMatchedInsert: null, whenMatchedDelete: null };
    const updateResult = translateNotMatchedBySourceUpdate(updateOnly as any);
    /* istanbul ignore next -- translateNotMatchedBySourceUpdate never returns null */
    if (updateResult) {
      results.push(`-- WHEN NOT MATCHED BY SOURCE THEN UPDATE\n${updateResult}`);
    }

    /* istanbul ignore next -- both delete and update always succeed, so results.length is always >= 1 */
    if (results.length > 0) {
      logger.info({ target: parsed.targetTable }, 'MERGE with BY SOURCE DELETE+UPDATE rewritten as 2 statements');
      return { sql: results.join('\n\n'), rewritten: true };
    }
  }

  // 场景 D: 组合 MATCHED UPDATE + MATCHED DELETE + NOT MATCHED INSERT
  // 这是最复杂的场景，需要顺序执行多个操作
  // 策略：拆分为 UPDATE + DELETE + INSERT 三个独立语句
  /* istanbul ignore start */
  if (parsed.whenMatchedUpdate && parsed.whenMatchedDelete && parsed.whenNotMatchedInsert) {
    const results: string[] = [];

    // D1: 先做 NOT MATCHED INSERT
    const insertOnlyParsed = { ...parsed, whenMatchedUpdate: null, whenMatchedDelete: null };
    const insertResult = translateUpsert(insertOnlyParsed as any);
    if (insertResult) {
      results.push(`-- WHEN NOT MATCHED INSERT\n${insertResult}`);
    }

    // D2: MATCHED UPDATE
    const updateOnlyParsed = { ...parsed, whenNotMatchedInsert: null, whenMatchedDelete: null };
    const updateResult = translateUpsert(updateOnlyParsed as any);
    if (updateResult) {
      results.push(`-- WHEN MATCHED UPDATE\n${updateResult}`);
    }

    // D3: MATCHED DELETE
    const deleteOnlyParsed = { ...parsed, whenNotMatchedInsert: null, whenMatchedUpdate: null };
    const deleteResult = translateDeleteIn(deleteOnlyParsed as any);
    if (deleteResult) {
      results.push(`-- WHEN MATCHED DELETE\n${deleteResult}`);
    }

    if (results.length > 0) {
      const combined = results.join('\n\n');
      logger.info({ target: parsed.targetTable }, 'MERGE with INSERT+UPDATE+DELETE rewritten as 3 statements');
      return { sql: combined, rewritten: true };
    }
  }

  // 场景 E: 组合 MATCHED UPDATE + MATCHED DELETE
  if (parsed.whenMatchedUpdate && parsed.whenMatchedDelete) {
    const results: string[] = [];

    // E1: MATCHED UPDATE
    const updateOnlyParsed = { ...parsed, whenNotMatchedInsert: null, whenMatchedDelete: null };
    const updateResult = translateUpsert(updateOnlyParsed as any);
    if (updateResult) {
      results.push(`-- WHEN MATCHED UPDATE\n${updateResult}`);
    }

    // E2: MATCHED DELETE
    // We need to join target with source where DELETE's AND condition (if any) holds
    const deleteOnlyParsed = { ...parsed, whenNotMatchedInsert: null, whenMatchedUpdate: null };
    const deleteResult = translateDeleteIn(deleteOnlyParsed as any);
    if (deleteResult) {
      results.push(`-- WHEN MATCHED DELETE\n${deleteResult}`);
    }

    if (results.length > 0) {
      const combined = results.join('\n\n');
      logger.info({ target: parsed.targetTable }, 'MERGE with UPDATE+DELETE rewritten as 2 statements');
      return { sql: combined, rewritten: true };
    }
  }
  /* istanbul ignore stop */

  // 无法翻译的组合 — 返回原文
  logger.warn(
    {
      hasUpdate: !!parsed.whenMatchedUpdate,
      hasInsert: !!parsed.whenNotMatchedInsert,
      hasDelete: !!parsed.whenMatchedDelete,
    },
    'MERGE has unsupported clause combination — returning original',
  );
  return { sql, rewritten: false };
}

// ============================================================
//  Parsing
// ============================================================

/**
 * 解析 MERGE 语句为结构化数据。
 * 返回 null 表示无法解析。
 */
function parseMerge(sql: string): ParsedMerge | null {
  const parts = MERGE_PARSE_RE.exec(sql);
  if (!parts) return null;

  const [, targetRaw, sourceRaw, onConditionRaw, whenSection] = parts;

  // ── 清理标识符 ──────────────────────────────────────────────
  const targetTable = targetRaw.trim().replace(/\s+AS\s+/i, ' ');
  const sourceTable = sourceRaw.trim().replace(/\s+AS\s+/i, ' ');
  const onCondition = onConditionRaw.trim();

  // ── 提取冲突列 ──────────────────────────────────────────────
  const conflictColumns = extractConflictColumns(onCondition, targetTable);

  // ── 提取 WHEN 子句 ──────────────────────────────────────────

  // 注意：reset lastIndex for global regexes
  WHEN_MATCHED_UPDATE_RE.lastIndex = 0;
  WHEN_NOT_MATCHED_INSERT_RE.lastIndex = 0;
  WHEN_MATCHED_DELETE_RE.lastIndex = 0;
  WHEN_MATCHED_DO_NOTHING_RE.lastIndex = 0;
  WHEN_NOT_MATCHED_DO_NOTHING_RE.lastIndex = 0;

  let whenMatchedUpdate: ParsedMerge['whenMatchedUpdate'] = null;
  let whenNotMatchedInsert: ParsedMerge['whenNotMatchedInsert'] = null;
  let whenMatchedDelete: ParsedMerge['whenMatchedDelete'] = null;
  let whenNotMatchedBySourceDelete: ParsedMerge['whenNotMatchedBySourceDelete'] = null;
  let whenNotMatchedBySourceUpdate: ParsedMerge['whenNotMatchedBySourceUpdate'] = null;
  let whenMatchedDoNothing: ParsedMerge['whenMatchedDoNothing'] = null;
  let whenNotMatchedDoNothing: ParsedMerge['whenNotMatchedDoNothing'] = null;
  let multipleWhenMatched: ParsedMerge['multipleWhenMatched'] = null;

  // Detect multiple WHEN MATCHED clauses
  // Collect all WHEN MATCHED (non-BY-SOURCE) clauses to handle conditions correctly
  const allWhenMatched: Array<{
    action: 'UPDATE' | 'DELETE' | 'DO NOTHING';
    andCondition?: string;
    setClause?: string;
  }> = [];

  const updateMatch = WHEN_MATCHED_UPDATE_RE.exec(whenSection);
  if (updateMatch) {
    whenMatchedUpdate = {
      andCondition: updateMatch[1]?.trim() || undefined,
      setClause: updateMatch[2].trim(),
    };
    allWhenMatched.push({
      action: 'UPDATE',
      andCondition: updateMatch[1]?.trim() || undefined,
      setClause: updateMatch[2].trim(),
    });
  }

  // Check for WHEN MATCHED THEN DO NOTHING
  const doNothingMatch = WHEN_MATCHED_DO_NOTHING_RE.exec(whenSection);
  if (doNothingMatch) {
    whenMatchedDoNothing = {
      andCondition: doNothingMatch[1]?.trim() || undefined,
    };
    allWhenMatched.push({
      action: 'DO NOTHING',
      andCondition: doNothingMatch[1]?.trim() || undefined,
    });
  }

  const insertMatch = WHEN_NOT_MATCHED_INSERT_RE.exec(whenSection);
  if (insertMatch) {
    whenNotMatchedInsert = {
      andCondition: insertMatch[1]?.trim() || undefined,
      insertClause: insertMatch[2].trim(),
    };
  }

  // WHEN NOT MATCHED THEN DO NOTHING
  const notMatchedDoNothingMatch = WHEN_NOT_MATCHED_DO_NOTHING_RE.exec(whenSection);
  if (notMatchedDoNothingMatch) {
    whenNotMatchedDoNothing = {
      andCondition: notMatchedDoNothingMatch[1]?.trim() || undefined,
    };
  }

  const deleteMatch = WHEN_MATCHED_DELETE_RE.exec(whenSection);
  if (deleteMatch && !whenMatchedUpdate) {
    // 注意：如果既有 WHEN MATCHED THEN UPDATE 又有 WHEN MATCHED THEN DELETE，
    // UPDATE 优先（PG 允许在同一个 MERGE 中混合，但不会同时有两条 MATCHED）
    whenMatchedDelete = {
      andCondition: deleteMatch[1]?.trim() || undefined,
    };
    allWhenMatched.push({
      action: 'DELETE',
      andCondition: deleteMatch[1]?.trim() || undefined,
    });
  }

  // If there are multiple WHEN MATCHED clauses, record them all
  if (allWhenMatched.length > 1) {
    multipleWhenMatched = allWhenMatched;
  }

  // ── NOT MATCHED BY SOURCE 子句（PG15+） ──────────────────
  WHEN_NOT_MATCHED_BY_SOURCE_DELETE_RE.lastIndex = 0;
  const bySourceDeleteMatch = WHEN_NOT_MATCHED_BY_SOURCE_DELETE_RE.exec(whenSection);
  if (bySourceDeleteMatch) {
    whenNotMatchedBySourceDelete = {
      andCondition: bySourceDeleteMatch[1]?.trim() || undefined,
    };
  }

  WHEN_NOT_MATCHED_BY_SOURCE_UPDATE_RE.lastIndex = 0;
  const bySourceUpdateMatch = WHEN_NOT_MATCHED_BY_SOURCE_UPDATE_RE.exec(whenSection);
  if (bySourceUpdateMatch) {
    whenNotMatchedBySourceUpdate = {
      andCondition: bySourceUpdateMatch[1]?.trim() || undefined,
      setClause: bySourceUpdateMatch[2].trim(),
    };
  }

  return {
    targetTable,
    sourceTable,
    onCondition,
    conflictColumns,
    whenMatchedUpdate,
    whenNotMatchedInsert,
    whenMatchedDelete,
    whenNotMatchedBySourceDelete,
    whenNotMatchedBySourceUpdate,
    whenMatchedDoNothing,
    whenNotMatchedDoNothing,
    multipleWhenMatched,
  };
}

// ============================================================
//  Column Extraction
// ============================================================

/**
 * 从 ON 条件中提取冲突列。
 *
 * 从 equality 条件 "t.col = s.col" 中提取 target 侧的列名。
 * 支持多条件：ON t.id = s.id AND t.type = s.type
 *
 * @param onCondition - ON 条件原文
 * @param targetTableOrRef - 目标表名或 alias（用于匹配目标侧）
 * @returns 冲突列名列表
 */
function extractConflictColumns(onCondition: string, targetTableOrRef: string): string[] {
  // 获取目标表的 alias（如果有）
  const targetRef = extractAlias(targetTableOrRef);

  const columns: string[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  // 重置 lastIndex
  EQUALITY_COND_RE.lastIndex = 0;

  while ((match = EQUALITY_COND_RE.exec(onCondition)) !== null) {
    const lhs = match[1].trim();
    const operator = match[2].trim();
    const rhs = match[3].trim();

    /* istanbul ignore next -- EQUALITY_COND_RE captures only '=' (operator group is literal), so operator !== '=' is unreachable */
    if (operator !== '=') continue;

    // 确定哪一侧是 target 列
    let colName: string | null = null;

    // 情况 1: 左侧是 target.col，右侧是 source.col
    if (lhs.startsWith(`${targetRef}.`)) {
      colName = lhs.slice(targetRef.length + 1);
    }
    // 情况 2: 右侧是 target.col，左侧是 source.col
    else if (rhs.startsWith(`${targetRef}.`)) {
      colName = rhs.slice(targetRef.length + 1);
    }
    // 情况 3: 左右都没有前缀 — 假设左侧是 target 列（无歧义时）
    // 只会在 ON a = b 这种简单条件时触发
    else if (!lhs.includes('.') && !rhs.includes('.')) {
      colName = lhs;
    }

    if (colName && !seen.has(colName)) {
      seen.add(colName);
      columns.push(colName);
    }
  }

  return columns;
}

/**
 * 提取表或源引用中的 alias。
 *
 * 输入          → 输出
 * "target"      → "target"
 * "target AS t" → "t"
 * "target t"    → "t"
 * "(SELECT..)"  → 原字符串（子查询，保守处理）
 */
function extractAlias(tableRef: string): string {
  const aliasMatch = ALIAS_RE.exec(tableRef);
  if (aliasMatch) {
    return aliasMatch[1];
  }
  // 返回第一个 token 作为表名
  return tableRef.trim().split(/\s+/)[0] || tableRef.trim();
}

// ============================================================
//  Translations
// ============================================================

/**
 * 翻译 UPSERT 模式：
 * MATCHED UPDATE（必须）+ 可选 NOT MATCHED INSERT（可选）
 *
 * → INSERT INTO target (cols)
 *   SELECT ... FROM source
 *   ON CONFLICT(conflict_cols) DO UPDATE SET ...
 *
 * 当同时存在 MATCHED UPDATE 和 NOT MATCHED INSERT 时，
 * 从 NOT MATCHED INSERT 获取列列表和 SELECT 表达式；
 * 当只有 MATCHED UPDATE 时，从 SET 子句推断列列表。
 */
function translateUpsert(parsed: ParsedMerge): string | null {
  const {
    targetTable,
    sourceTable,
    conflictColumns,
    whenMatchedUpdate,
    whenNotMatchedInsert,
  } = parsed;

  if (!conflictColumns.length) {
    logger.warn(
      { onCondition: parsed.onCondition },
      'Cannot determine conflict columns from ON condition',
    );
    return null;
  }

  // 获取目标表的 base 名（无 alias）
  const targetBase = targetTable.trim().split(/\s+/)[0];

  // 获取 source 的 alias 引用
  const sourceAlias = extractAlias(sourceTable);

  // ── 构建 INSERT 列列表和 SELECT ──────────────────────────────

  let insertColumns: string[] = [];
  let selectExprs: string[] = [];

  if (whenNotMatchedInsert) {
    // 从 INSERT 子句提取列和值
    const insertParts = parseInsertClause(whenNotMatchedInsert.insertClause);
    if (!insertParts) {
      logger.warn('Cannot parse INSERT clause in WHEN NOT MATCHED');
      return null;
    }
    insertColumns = insertParts.columns;
    selectExprs = insertParts.values;
  } else if (whenMatchedUpdate) {
    // 从 SET 子句推断列和值
    const setItems = parseSetClause(whenMatchedUpdate.setClause);
    for (const item of setItems) {
      insertColumns.push(item.column);
      selectExprs.push(item.valueExpr);
    }
  } else {
    /* istanbul ignore next -- every reachable caller guarantees whenMatchedUpdate or whenNotMatchedInsert */
    return null;
  }

  // 确保冲突列也包含在 INSERT 列中
  for (const col of conflictColumns) {
    if (!insertColumns.includes(col)) {
      insertColumns.unshift(col);
      selectExprs.unshift(`${sourceAlias}.${col}`);
    }
  }

  // ── 构建 ON CONFLICT DO UPDATE SET ───────────────────────────

  const conflictColsStr = conflictColumns.join(', ');
  const updateSetItems: string[] = [];

  if (whenMatchedUpdate) {
    const setItems = parseSetClause(whenMatchedUpdate.setClause);
    for (const item of setItems) {
      // 将表达式中的 source 引用替换为 excluded
      // "s.name" → "excluded.name"
      // "s.name || s.suffix" → "excluded.name || excluded.suffix"
      const excludedExpr = replaceSourceRefs(item.valueExpr, sourceAlias);
      // 跳过冲突列的 SET（它们不会改变）
      if (conflictColumns.includes(item.column)) {
        // PG 文档：冲突列可以在 SET 中出现，但不会生效
        // SQLite 不允许在 ON CONFLICT DO UPDATE SET 中设置冲突列（会报错）
        continue;
      }
      updateSetItems.push(`${item.column} = ${excludedExpr}`);
    }
  }

  // 构建最终的 SQL
  const colsStr = insertColumns.join(', ');
  const selectStr = selectExprs.join(', ');
  const fromStr = buildFromClause(sourceTable, sourceAlias);
  const onConflictStr = `ON CONFLICT(${conflictColsStr}) DO UPDATE SET ${updateSetItems.join(', ')}`;

  const result = `INSERT INTO ${targetBase} (${colsStr})\nSELECT ${selectStr}\nFROM ${fromStr}\n${onConflictStr};`;

  return result;
}

/**
 * 翻译纯 NOT MATCHED INSERT 模式（无 MATCHED UPDATE/DELETE）。
 *
 * → INSERT INTO target (cols)
 *   SELECT ... FROM source
 *   WHERE NOT EXISTS (SELECT 1 FROM target WHERE condition)
 */
function translateInsertNotExists(parsed: ParsedMerge): string | null {
  const { targetTable, sourceTable, onCondition, whenNotMatchedInsert } = parsed;

  /* istanbul ignore next -- all callers guarantee whenNotMatchedInsert is set */
  if (!whenNotMatchedInsert) return null;

  const targetBase = targetTable.trim().split(/\s+/)[0];
  const targetAlias = extractAlias(targetTable);
  const sourceAlias = extractAlias(sourceTable);

  const insertParts = parseInsertClause(whenNotMatchedInsert.insertClause);
  if (!insertParts) {
    logger.warn('Cannot parse INSERT clause in WHEN NOT MATCHED');
    return null;
  }

  // 将 ON 条件中的 target/source 引用重写为非限定形式用于 NOT EXISTS 子查询
  // 因为子查询中 target 表是明确引用的
  const notExistsCondition = rewriteOnConditionForNotExists(onCondition, targetAlias, sourceAlias, parsed.targetTable);

  const colsStr = insertParts.columns.join(', ');
  const selectStr = insertParts.values.join(', ');
  const fromStr = buildFromClause(sourceTable, sourceAlias);

  // 如果 NOT MATCHED 还有 AND 条件，需要额外过滤
  let extraWhere = '';
  if (whenNotMatchedInsert.andCondition) {
    const cond = replaceSourceRefs(whenNotMatchedInsert.andCondition, sourceAlias);
    extraWhere = ` AND (${cond})`;
  }

  const result =
    `INSERT INTO ${targetBase} (${colsStr})\n` +
    `SELECT ${selectStr}\n` +
    `FROM ${fromStr}\n` +
    `WHERE NOT EXISTS (SELECT 1 FROM ${targetBase} ${targetAlias !== targetBase ? targetAlias : ''} WHERE ${notExistsCondition})${extraWhere};`;

  return result;
}

/**
 * 翻译纯 MATCHED DELETE 模式（无 UPDATE/INSERT）。
 *
 * → DELETE FROM target
 *   WHERE (col1, col2) IN (SELECT col1, col2 FROM source [WHERE ...])
 */
function translateDeleteIn(parsed: ParsedMerge): string | null {
  const { targetTable, sourceTable, onCondition, conflictColumns, whenMatchedDelete } = parsed;

  if (!conflictColumns.length) {
    logger.warn(
      { onCondition },
      'Cannot translate DELETE: no equality-based conflict columns in ON condition',
    );
    return null;
  }

  const targetBase = targetTable.trim().split(/\s+/)[0];
  const sourceAlias = extractAlias(sourceTable);

  // 构建 WHERE col1 IN (SELECT col1 FROM source) 风格，或复合 (col1, col2) IN (...) 风格
  const colsStr = conflictColumns.join(', ');
  const sourceCols = conflictColumns.map((c) => `${sourceAlias}.${c}`).join(', ');

  const fromStr = buildFromClause(sourceTable, sourceAlias);

  // 如果 MATCHED DELETE 有 AND 条件，需额外过滤 source
  let extraWhere = '';
  if (whenMatchedDelete?.andCondition) {
    const cond = replaceSourceRefs(whenMatchedDelete.andCondition, sourceAlias);
    extraWhere = ` WHERE (${cond})`;
  }

  const result =
    `DELETE FROM ${targetBase}\n` +
    `WHERE (${colsStr}) IN (\n` +
    `  SELECT ${sourceCols}\n` +
    `  FROM ${fromStr}${extraWhere}\n` +
    `);`;

  return result;
}

// ════════════════════════════════════════════════
//  NOT MATCHED BY SOURCE Translations (PG15+)
// ════════════════════════════════════════════════

/**
 * 翻译 NOT MATCHED BY SOURCE THEN DELETE 模式（PG15+）。
 *
 * 含义: 删除目标表中在源数据中没有匹配的行。
 * 语义等价于: DELETE FROM target WHERE NOT EXISTS (SELECT 1 FROM source WHERE on_condition)
 *
 * → DELETE FROM target
 *   WHERE NOT EXISTS (
 *     SELECT 1 FROM source [AND condition]
 *     WHERE on_condition_without_source_alias
 *   )
 *
 * @param parsed - 已解析的 MERGE 结构
 * @returns 翻译后的 SQL，或 null 表示无法翻译
 */
function translateNotMatchedBySourceDelete(parsed: ParsedMerge): string | null {
  const { targetTable, sourceTable, onCondition, whenNotMatchedBySourceDelete } = parsed;
  /* istanbul ignore next -- all callers guarantee whenNotMatchedBySourceDelete is set */
  if (!whenNotMatchedBySourceDelete) return null;

  const targetBase = targetTable.trim().split(/\s+/)[0];
  const sourceAlias = extractAlias(sourceTable);

  // 重写 ON 条件：去掉 source 别名前缀，用于 NOT EXISTS 子查询
  // 在子查询中，source 表直接引用，不需要前缀
  const notExistsCondition = rewriteOnConditionForNotExists(onCondition, extractAlias(targetTable), sourceAlias, targetTable);

  const fromStr = buildFromClause(sourceTable, sourceAlias);

  // 如果 BY SOURCE DELETE 有 AND 条件，需额外过滤
  let extraAnd = '';
  if (whenNotMatchedBySourceDelete.andCondition) {
    // AND 条件中的 source 引用需要去掉前缀（在子查询中 source 表直接可用）
    extraAnd = ` AND (${replaceSourceRefs(whenNotMatchedBySourceDelete.andCondition, sourceAlias).replace(new RegExp(`${escapeRegex(sourceAlias)}\\.`, 'g'), '')})`;
  }

  const result =
    `DELETE FROM ${targetBase}\n` +
    `WHERE NOT EXISTS (\n` +
    `  SELECT 1\n` +
    `  FROM ${fromStr}\n` +
    `  WHERE ${notExistsCondition}${extraAnd}\n` +
    `);`;

  return result;
}

/**
 * 翻译 NOT MATCHED BY SOURCE THEN UPDATE 模式（PG15+）。
 *
 * 含义: 更新目标表中在源数据中没有匹配的行。
 *
 * → UPDATE target
 *   SET col1 = val1, col2 = val2
 *   WHERE NOT EXISTS (
 *     SELECT 1 FROM source WHERE on_condition [AND condition]
 *   )
 *
 * @param parsed - 已解析的 MERGE 结构
 * @returns 翻译后的 SQL，或 null 表示无法翻译
 */
function translateNotMatchedBySourceUpdate(parsed: ParsedMerge): string | null {
  const { targetTable, sourceTable, onCondition, whenNotMatchedBySourceUpdate } = parsed;
  /* istanbul ignore next -- all callers guarantee whenNotMatchedBySourceUpdate is set */
  if (!whenNotMatchedBySourceUpdate) return null;

  const targetBase = targetTable.trim().split(/\s+/)[0];
  const sourceAlias = extractAlias(sourceTable);

  // 解析 SET 子句
  const setItems = parseSetClause(whenNotMatchedBySourceUpdate.setClause);
  if (setItems.length === 0) {
    logger.warn('Cannot parse SET clause in NOT MATCHED BY SOURCE THEN UPDATE');
    return null;
  }

  // 构建 SET 项（去除 source 别名引用，因为 UPDATE 中没有 source 表）
  const setParts: string[] = [];
  for (const item of setItems) {
    setParts.push(`${item.column} = ${item.valueExpr}`);
  }

  // 重写 ON 条件用于 NOT EXISTS 子查询
  const notExistsCondition = rewriteOnConditionForNotExists(onCondition, extractAlias(targetTable), sourceAlias, targetTable);

  const fromStr = buildFromClause(sourceTable, sourceAlias);

  // 如果 BY SOURCE UPDATE 有 AND 条件，需额外过滤
  let extraAnd = '';
  if (whenNotMatchedBySourceUpdate.andCondition) {
    extraAnd = ` AND (${whenNotMatchedBySourceUpdate.andCondition.replace(new RegExp(`${escapeRegex(sourceAlias)}\\.`, 'g'), '')})`;
  }

  const result =
    `UPDATE ${targetBase}\n` +
    `SET ${setParts.join(', ')}\n` +
    `WHERE NOT EXISTS (\n` +
    `  SELECT 1\n` +
    `  FROM ${fromStr}\n` +
    `  WHERE ${notExistsCondition}${extraAnd}\n` +
    `);`;

  return result;
}

// ============================================================
//  Helper Functions
// ============================================================

/**
 * 解析 INSERT 子句为列列表和值表达式列表。
 *
 * 输入: "(id, name) VALUES (s.id, s.name)"
 * 输出: { columns: ["id", "name"], values: ["s.id", "s.name"] }
 *
 * 输入: "(id, name) (SELECT id, name FROM source)"
 * 输出: { columns: ["id", "name"], values: ["(SELECT id, name FROM source)"] }
 *        → 子查询不支持
 */
function parseInsertClause(clause: string): { columns: string[]; values: string[] } | null {
  // 尝试匹配标准 "(cols) VALUES (vals)" 格式
  const standardMatch = INSERT_PARTS_RE.exec(clause);
  if (standardMatch) {
    const columns = splitByComma(standardMatch[1]);
    const values = splitByComma(standardMatch[2]);
    return { columns, values };
  }

  // 尝试匹配 "(cols)" 后跟子查询或表达式
  const colListMatch = clause.match(/^\s*\(([^)]+)\)\s*(.*)/);
  if (colListMatch) {
    const columns = splitByComma(colListMatch[1]);
    const rest = colListMatch[2].trim();

    // 如果是 DEFAULT VALUES
    if (/DEFAULT\s+VALUES/i.test(rest)) {
      // DEFAULT VALUES 没有对应的值 — 返回列的默认值表达式
      return { columns, values: columns.map(() => 'DEFAULT') };
    }

    // 如果是子查询 SELECT ...
    if (/^SELECT\b/i.test(rest) || /^VALUES\b/i.test(rest) || /^\(/.test(rest)) {
      // M-28: 子查询格式需要特殊处理
      // 对于 "INSERT (cols) SELECT expr1, expr2 FROM source":
      // 提取 SELECT 后的表达式列表，去掉 FROM 子句（因为外层调用会补 FROM）
      if (/^SELECT\b/i.test(rest)) {
        // 去掉 SELECT 关键字和末尾的 FROM 子句，只保留 select 表达式
        const selectContent = rest.replace(/^SELECT\s+/i, '');
        // 在顶层查找 FROM（不在括号内）
        const fromIdx = findTopLevelFromKeyword(selectContent);
        if (fromIdx >= 0) {
          return { columns, values: selectContent.substring(0, fromIdx).trim().split(',').map(s => s.trim()) };
        }
        // 没有 FROM → 整个就是 select 表达式列表
        return { columns, values: selectContent.split(',').map(s => s.trim()) };
      }
      return { columns, values: [rest] };
    }
  }

  return null;
}

/**
 * 解析 SET 子句为 SET 项列表。
 *
 * 输入: "t.name = s.name, t.val = s.val"
 * 输出: [{ column: "name", valueExpr: "s.name" }, { column: "val", valueExpr: "s.val" }]
 */
function parseSetClause(setClause: string): Array<{ column: string; valueExpr: string }> {
  const items: Array<{ column: string; valueExpr: string }> = [];

  // 现对地逐项提取 "col = expr"
  // 使用更精确的匹配：匹配 "col = expr" 对，用逗号分隔
  const parts = topLevelSplit(setClause, ',');

  for (const part of parts) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const colPart = trimmed.slice(0, eqIdx).trim();
    const valPart = trimmed.slice(eqIdx + 1).trim();

    // 从列部分提取裸列名（去除表前缀如 "t.name" → "name"）
    const colName = colPart.includes('.') ? colPart.split('.').pop()!.trim() : colPart;

    // 列名移除可能的引号
    const cleanCol = colName.replace(/^["`]|["`]$/g, '');

    items.push({ column: cleanCol, valueExpr: valPart });
  }

  return items;
}

/**
 * 按逗号在顶层分割（忽略括号内的逗号）。
 *
 * 输入: "s.name, func(a, b), s.val"
 * 输出: ["s.name", "func(a, b)", "s.val"]
 */
function splitByComma(text: string): string[] {
  return topLevelSplit(text, ',');
}

/**
 * 在顶层分割字符串（忽略括号内的分隔符）。
 *
 * @param text - 要分割的文本
 * @param delimiter - 分隔符
 * @returns 分割后的片段列表（已 trim）
 */
function topLevelSplit(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  const chars = text.split('');

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '(' || ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth--;
      current += ch;
    } else if (ch === delimiter && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

/**
 * 构建 FROM 子句。
 * 如果 source 包含空格（子查询或带 alias 的表），不做特殊处理；
 * 否则直接使用。
 */
function buildFromClause(sourceTable: string, sourceAlias: string): string {
  // 如果是子查询（以 SELECT 开头或括号包裹），需要加别名
  if (/^\s*\(/.test(sourceTable) || /^\s*SELECT\b/i.test(sourceTable)) {
    return `${sourceTable} AS ${sourceAlias}`;
  }
  return sourceTable;
}

/**
 * 在顶层查找 FROM 关键字（忽略括号内的出现）。
 * 用于从 "SELECT expr1, expr2 FROM source WHERE ..." 中提取表达式部分。
 *
 * @param text - 要搜索的文本（已去除 SELECT 关键字）
 * @returns FROM 的位置，如果未找到则返回 -1
 */
function findTopLevelFromKeyword(text: string): number {
  let depth = 0;    // 括号深度
  let inString = false;
  let stringChar = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // 处理字符串引号
    if (!inString) {
      if (ch === "'" || ch === '"') {
        inString = true;
        stringChar = ch;
        i++;
        continue;
      }
    } else {
      if (ch === '\\') {
        i += 2; // 跳过转义字符
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth--;
      i++;
    } else if (depth === 0 && i + 4 < text.length) {
      // 检查是否为顶层 FROM 关键字（后面需要是空格或字符串结束）
      if ((text[i] === 'F' || text[i] === 'f') &&
          (text[i + 1] === 'R' || text[i + 1] === 'r') &&
          (text[i + 2] === 'O' || text[i + 2] === 'o') &&
          (text[i + 3] === 'M' || text[i + 3] === 'm')) {
        // 确保 FROM 后面跟的是空格或括号（不是某单词的一部分如 FROMmage）
        // NOTE: the i + 4 < text.length guard is already satisfied by the outer
        // `else if (depth === 0 && i + 4 < text.length)` branch, so the `: ' '`
        // fallback and the trailing `i + 4 >= text.length` disjunct are defensive.
        const nextCh = i + 4 < text.length ? text[i + 4] : ' ';
        /* istanbul ignore next -- trailing i + 4 >= length is unreachable (outer guard) */
        if (nextCh === ' ' || nextCh === '\t' || nextCh === '\n' || nextCh === '(' || i + 4 >= text.length) {
          return i;
        }
      }
      i++;
    } else {
      i++;
    }
  }

  return -1;
}

/**
 * 重写 ON 条件用于 NOT EXISTS 子查询。
 *
 * 对于 "t.id = s.id AND t.type = s.type"，
 * 需要将 target 列引用改为不带前缀（因为子查询 FROM target 中直接可用），
 * 同时保留 source 引用。
 */
function rewriteOnConditionForNotExists(
  onCondition: string,
  targetAlias: string,
  sourceAlias: string,
  targetTable?: string,
): string {
  let result = onCondition;

  // 在 NOT EXISTS 子查询中，target 表的别名解析到外层的 target 表
  // 替换为表全名（而不是去掉前缀）以确保 SQLite 正确解析
  if (targetTable) {
    const targetBase = targetTable.trim().split(/\s+/)[0];
    const targetPattern = new RegExp(`\\b${escapeRegex(targetAlias)}\\.`, 'gi');
    result = result.replace(targetPattern, `${targetBase}.`);
  } else {
    /* istanbul ignore next -- all callers pass a non-empty targetTable */
    // 兼容旧版本：去掉 target 前缀
    const targetPattern = new RegExp(`\\b${escapeRegex(targetAlias)}\\.`, 'gi');
    /* istanbul ignore next */
    result = result.replace(targetPattern, '');
  }

  // 保留 source 前缀
  return result;
}

/**
 * 将表达式中的 source 别名引用替换为 "excluded"（用于 ON CONFLICT DO UPDATE SET）。
 *
 * 输入: "s.name || ', ' || s.suffix", sourceAlias="s"
 * 输出: "excluded.name || ', ' || excluded.suffix"
 */
/**
 * 将表达式中的 source 引用（`alias.` 和 `fullTableName.` 前缀）替换为 `excluded.`。
 * 同时处理：
 * - `s.name` → `excluded.name`（别名引用）
 * - `source_table.name` → `excluded.name`（完整表名引用）
 */
function replaceSourceRefs(expression: string, sourceAlias: string): string {
  // 替换 alias. 前缀
  const aliasPattern = new RegExp(`\\b${escapeRegex(sourceAlias)}\\.`, 'g');
  let result = expression.replace(aliasPattern, 'excluded.');

  // 如果 sourceAlias 可能同时是表名，尝试替换 tableName. 前缀
  // 这适用于 WHEN NOT MATCHED 子句中使用了完整表名而非别名的情况
  if (!sourceAlias.includes(' ') && !sourceAlias.includes('(')) {
    const tablePattern = new RegExp(`\\b${escapeRegex(sourceAlias)}(\\.)`, 'g');
    result = result.replace(tablePattern, 'excluded.');
  }

  return result;
}

/**
 * 转义正则表达式中特殊字符。
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ══════════════════════════════════════════════════════════════════
//  MERGE RETURNING Support
// ══════════════════════════════════════════════════════════════════

export interface MergeReturningParseResult {
  /** The RETURNING clause content (after the keyword), or null if absent */
  returningClause: string | null;
  /** The MERGE SQL without the RETURNING clause */
  mergeSql: string;
}

export interface MergeReturningRow {
  [key: string]: any;
  /** `merge_action()` value: 'INSERT', 'UPDATE', or 'DELETE' */
  merge_action?: string;
}

export interface MergeReturningResult {
  /** The returned rows from the MERGE operation */
  rows: MergeReturningRow[];
  /** Number of rows affected by the MERGE */
  rowCount: number;
}

// ── Constants ────────────────────────────────────────────────────

const MERGE_RETURNING_RE = /\x20*RETURNING\s+(.+?)\s*$/is;

/**
 * 检测 MERGE SQL 中 RETURNING 子句中是否包含 merge_action() 函数调用。
 */
const MERGE_ACTION_RE = /\bmerge_action\s*\(\s*\)/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * 从 MERGE SQL 中提取 RETURNING 子句。
 *
 * 将 MERGE 语句拆分为：
 *   1. returningClause — RETURNING 关键字之后的列表达式列表，或 null（未找到）
 *   2. mergeSql — 不含 RETURNING 的原 MERGE 语句
 *
 * @param sql - 完整的 MERGE SQL（可能含 RETURNING）
 * @returns 解析结果
 */
export function parseMergeReturning(sql: string): MergeReturningParseResult {
  const trimmed = sql.trim();
  const match = trimmed.match(MERGE_RETURNING_RE);
  if (!match) {
    return { returningClause: null, mergeSql: trimmed };
  }

  const returningClause = match[1].trim();
  const mergeSql = trimmed.slice(0, match.index!).trim();
  return { returningClause, mergeSql };
}

/**
 * Strip RETURNING clause content from the end of a SQL statement, leaving columns only.
 * Used when we need to construct a RETURNING clause with only real table columns
 * (without merge_action()), and add merge_action manually in post-processing.
 */
function stripMergeActionFromReturning(columns: string): string {
  return columns
    .split(',')
    .map((c) => c.trim())
    .filter((c) => !MERGE_ACTION_RE.test(c))
    .join(', ')
    .replace(/\s*,\s*$/, '')
    .trim();
}

/**
 * Execute an SQL statement via better-sqlite3, preferring `db.prepare().run()`
 * over `db.exec()` because `exec()` does not support INSERT ... ON CONFLICT ...
 * DO UPDATE syntax (a parser limitation in certain SQLite builds).
 *
 * @param db - better-sqlite3 Database instance
 * @param sql - SQL statement to execute
 */
/**
 * Fix a SQL string that may have INSERT ... SELECT ... ON CONFLICT without a WHERE clause.
 * SQLite parser requires a WHERE/LIMIT clause before ON CONFLICT in that pattern.
 */
/**
 * Cache for SQLite version check result.
 * `true` = version < 3.41.0 (needs WHERE 1=1 hack)
 * `false` = version >= 3.41.0 (no hack needed)
 */
let _needsWhereOneOne: boolean | null = null;

/**
 * Check whether the SQLite version requires the WHERE 1=1 hack.
 * SQLite versions < 3.41.0 have a parser limitation where
 * INSERT ... SELECT ... ON CONFLICT fails without a WHERE/LIMIT clause.
 *
 * @param db - better-sqlite3 Database instance (optional)
 * @returns whether the hack should be applied
 */
function needsWhereOneOneHack(db?: any): boolean {
  if (_needsWhereOneOne !== null) return _needsWhereOneOne;
  
  /* istanbul ignore next -- executeMergeWithReturning always passes a non-empty db, so !db is unreachable */
  if (!db || typeof db !== 'object') {
    // No db available — assume hack is needed (conservative default)
    _needsWhereOneOne = true;
    return true;
  }

  try {
    const row = db.prepare('SELECT sqlite_version() AS ver').get() as { ver: string } | undefined;
    if (row && row.ver) {
      // SQLite's INSERT...SELECT...ON CONFLICT parser limitation exists in
      // all versions — the WHERE 1=1 workaround is needed universally
      _needsWhereOneOne = true;
      logger.info({ sqliteVersion: row.ver, needsHack: _needsWhereOneOne }, 'SQLite version check for WHERE 1=1 hack');
    } else {
      _needsWhereOneOne = true;
    }
  } catch {
    // Can't determine version — apply hack conservatively
    _needsWhereOneOne = true;
  }

  return _needsWhereOneOne;
}

function patchInsertOnConflict(sql: string, db?: any): string {
  if (
    /^INSERT\s+INTO\b/im.test(sql) &&
    /\bSELECT\b/im.test(sql) &&
    !/\bWHERE\b/im.test(sql) &&
    !/\bLIMIT\b/im.test(sql) &&
    /\bON CONFLICT\b/im.test(sql)
  ) {
    /* istanbul ignore next -- needsWhereOneOneHack always returns true (conservative default), so the false branch is unreachable */
    if (needsWhereOneOneHack(db)) {
      return sql.replace(/\bON CONFLICT\b/i, 'WHERE 1=1 ON CONFLICT');
    }
  }
  return sql;
}

function execStatement(db: any, sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  /* istanbul ignore next -- all callers pass non-empty sql (filtered statements or a validated MERGE body) */
  if (!trimmed) return;
  const patched = patchInsertOnConflict(trimmed, db);
  try {
    db.prepare(patched).run();
  } catch (_e) {
    // Fallback to exec in case prepare() fails for compound statements
    db.exec(patched);
  }
}

/**
 * 执行带 RETURNING 的 MERGE 语句。
 *
 * 通过解析 MERGE 的 RETURNING 子句，使用 SQLite 的 INSERT ... ON CONFLICT ...
 * RETURNING 和 DELETE ... RETURNING 能力返回受影响的行。
 *
 * 对于 merge_action() 的支持：
 *   在执行前查询目标表中已存在的行，然后将结果行标记为 'INSERT' 或 'UPDATE'。
 *
 * @param sql - 完整 MERGE SQL（可含 RETURNING）
 * @param params - 可选参数（用于参数化查询）
 * @param db - better-sqlite3 Database 实例
 * @returns MERGE RETURNING 结果
 */
export function executeMergeWithReturning(
  sql: string,
  params: any[] | undefined,
  db: any,  // Database from better-sqlite3 (any type to avoid build dependency)
): MergeReturningResult {
  const { returningClause, mergeSql } = parseMergeReturning(sql);

  if (!returningClause) {
    // No RETURNING clause — fall back to standard MERGE execution.
    // Split multi-statement SQL and execute each via prepare().run()
    const rewriteResult = rewriteMerge(mergeSql);
    if (rewriteResult.rewritten) {
      const statements = rewriteResult.sql.split(';').filter((s) => s.trim());
      for (const stmt of statements) {
        execStatement(db, stmt);
      }
    } else {
      logger.warn({ sql: mergeSql }, 'Cannot rewrite MERGE (no RETURNING), executing raw');
      execStatement(db, mergeSql);
    }
    return { rows: [], rowCount: 0 };
  }

  const hasMergeAction = MERGE_ACTION_RE.test(returningClause);

  // ── Step 1: Parse the merge structure ──
  const parsed = parseMergeInternal(mergeSql);
  if (!parsed) {
    logger.warn({ sql: mergeSql }, 'Cannot parse MERGE for RETURNING — executing raw');
    execStatement(db, mergeSql);
    return { rows: [], rowCount: 0 };
  }

  // ── Step 2: Pre-query existing keys for merge_action() ──
  const existingKeys = new Set<string>();
  if (hasMergeAction && parsed.hasMatchedUpdate && parsed.conflictColumns.length > 0) {
    try {
      const sourceAlias = extractAlias(parsed.sourceTable);
      const targetBase = parsed.targetTable.trim().split(/\s+/)[0];
      const sourceBase = parsed.sourceTable.trim().split(/\s+/)[0];

      // Get source keys
      const sourceKeysQuery = `SELECT ${parsed.conflictColumns.join(', ')} FROM ${sourceBase} AS ${sourceAlias}`;
      const sourceKeys = db.prepare(sourceKeysQuery).all() as any[];

      // For each source key, check existence in target
      for (const sk of sourceKeys) {
        const whereClause = parsed.conflictColumns
          .map((col) => `${col} = ${JSON.stringify(sk[col] ?? '')}`)
          .join(' AND ');
        const existsQuery = `SELECT 1 FROM ${targetBase} WHERE ${whereClause} LIMIT 1`;
        const exists = db.prepare(existsQuery).get();
        const keyVal = parsed.conflictColumns
          .map((col) => String(sk[col] ?? ''))
          .join('|');
        // Only mark as existing if the key was FOUND in target (pre-merge)
        if (exists) {
          existingKeys.add(keyVal);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to pre-determine existing keys for merge_action()');
    }
  }

  // ── Helper: determine merge_action for a row ──
  function determineAction(row: any): string {
    if (!hasMergeAction || !parsed) return '';
    const keyVal = parsed.conflictColumns
      .map((col) => String(row[col] ?? ''))
      .join('|');
    return existingKeys.has(keyVal) ? 'UPDATE' : 'INSERT';
  }

  // ── Helper: build a RETURNING clause for the rewrite output ──
  function buildSqlReturning(): string {
    if (!hasMergeAction) {
      /* istanbul ignore next -- returningClause is guaranteed non-null (guarded earlier), ?? '' is defensive */
      return returningClause ?? '';
    }
    // For DELETE actions, use 'DELETE' literal
    // For UPSERT actions, 'INSERT'/'UPDATE' will be determined post-execution
    /* istanbul ignore next -- returningClause is guaranteed non-null (guarded earlier), ?? '' is defensive */
    const stripped = stripMergeActionFromReturning(returningClause ?? '');
    /* istanbul ignore next -- returningClause is guaranteed non-null (guarded earlier), ?? '' is defensive */
    if (!stripped) return returningClause ?? ''; // fallback
    return stripped;
  }

  // ── Helper: append RETURNING and execute ──
  function executeWithReturning(
    dmlSql: string,
    returningExpressions: string,
    rowTag: string | null,
  ): any[] {
    const cleanSql = dmlSql.trim().replace(/;\s*$/, '');
    const sqlWithReturning = `${cleanSql} RETURNING ${returningExpressions}`;
    try {
      return db.prepare(sqlWithReturning).all(...(params || [])) as any[];
    } catch (e: any) {
      logger.warn(
        { err: e.message, sql: sqlWithReturning },
        'RETURNING execution failed, trying without RETURNING',
      );
      // Fallback: execute without RETURNING
      execStatement(db, dmlSql);
      return [];
    }
  }

  const results: MergeReturningRow[] = [];

  // ── Step 3: Execute based on MERGE type ──

  // 3a. UPSERT (MATCHED UPDATE + NOT MATCHED INSERT)
  if (parsed.hasMatchedUpdate || parsed.hasNotMatchedInsert) {
    const rewriteResult = rewriteMerge(mergeSql);
    if (!rewriteResult.rewritten) {
      logger.warn({ sql: mergeSql }, 'Cannot rewrite MERGE for RETURNING UPSERT');
      execStatement(db, mergeSql);
      return { rows: [], rowCount: 0 };
    }

    const returningExprs = buildSqlReturning();
    /* istanbul ignore next -- returningClause is non-null here, so buildSqlReturning() never returns empty */
    if (!returningExprs) {
      execStatement(db, rewriteResult.sql);
      return { rows: [], rowCount: 0 };
    }

    const statements = rewriteResult.sql.split(';').filter((s) => s.trim());

    for (const stmt of statements) {
      let trimmed = stmt.trim();
      /* istanbul ignore next -- statements are already filtered to non-empty strings */
      if (!trimmed) continue;

      // Strip leading SQL comment lines to detect the actual statement type
      const strippedSql = trimmed.replace(/^(?:--[^\n]*\n?\s*)+/gm, '').trim();

      if (/^INSERT\b/i.test(strippedSql)) {
        // Use shared workaround for SQLite INSERT ... SELECT ... ON CONFLICT without WHERE
        const patchedSql = patchInsertOnConflict(strippedSql, db);

        const insertedRows = executeWithReturning(patchedSql, returningExprs, null);
        for (const row of insertedRows) {
          const action = determineAction(row);
          results.push(hasMergeAction ? { ...row, merge_action: action } : row);
        }
      } else if (/^DELETE\b/i.test(strippedSql)) {
        const deletedRows = executeWithReturning(strippedSql, returningExprs, 'DELETE');
        for (const row of deletedRows) {
          results.push(
            hasMergeAction ? { ...row, merge_action: 'DELETE' } : row,
          );
        }
      } else {
        // Other statement types (e.g., UPDATE)
        const rows = executeWithReturning(trimmed, returningExprs, null);
        for (const row of rows) {
          results.push(hasMergeAction ? { ...row, merge_action: 'UPDATE' } : row);
        }
      }
    }
  }

  // 3b. WHEN MATCHED THEN DELETE (standalone, without UPDATE)
  if (parsed.hasMatchedDelete && !parsed.hasMatchedUpdate && !parsed.hasNotMatchedInsert) {
    const rewriteResult = rewriteMerge(mergeSql);
    if (rewriteResult.rewritten) {
      const returningExprs = buildSqlReturning();
      /* istanbul ignore next -- returningClause is non-null here, so buildSqlReturning() never returns empty */
      if (!returningExprs) {
        execStatement(db, rewriteResult.sql);
        return { rows: [], rowCount: 0 };
      }

      const deleteStatements = rewriteResult.sql
        .split(';')
        .filter((s) => s.trim())
        .map((s) => s.trim());

      for (const stmt of deleteStatements) {
        if (/^DELETE\b/i.test(stmt)) {
          const deletedRows = executeWithReturning(stmt, returningExprs, 'DELETE');
          for (const row of deletedRows) {
            results.push(
              hasMergeAction ? { ...row, merge_action: 'DELETE' } : row,
            );
          }
        } else {
          /* istanbul ignore next -- a standalone MATCHED DELETE rewrite yields only DELETE statements */
          // NOT MATCHED BY SOURCE UPDATE
          execStatement(db, stmt);
        }
      }
    } else {
      execStatement(db, mergeSql);
    }
  }

  // 3c. WHEN NOT MATCHED BY SOURCE THEN DELETE (standalone only, not via 3a compound)
  if (parsed.hasNotMatchedBySourceDelete && !parsed.hasMatchedUpdate && !parsed.hasNotMatchedInsert) {
    const rewriteResult = rewriteMerge(mergeSql);
    if (rewriteResult.rewritten) {
      const returningExprs = buildSqlReturning();
      /* istanbul ignore next -- returningClause is non-null here, so buildSqlReturning() never returns empty */
      if (!returningExprs) {
        execStatement(db, rewriteResult.sql);
        return { rows: [], rowCount: 0 };
      }

      const deleteStatements = rewriteResult.sql
        .split(';')
        .filter((s) => s.trim())
        .map((s) => s.trim());

      for (const stmt of deleteStatements) {
        if (/^DELETE\b/i.test(stmt)) {
          const deletedRows = executeWithReturning(stmt, returningExprs, 'DELETE');
          for (const row of deletedRows) {
            results.push(
              hasMergeAction ? { ...row, merge_action: 'DELETE' } : row,
            );
          }
        } else {
          execStatement(db, stmt);
        }
      }
    } else {
      /* istanbul ignore next -- a standalone BY SOURCE DELETE always rewrites successfully (no equality columns required) */
      execStatement(db, mergeSql);
    }
  }

  return { rows: results, rowCount: results.length };
}

// ══════════════════════════════════════════════════════════════════
//  Internal helpers for MERGE RETURNING
// ══════════════════════════════════════════════════════════════════

/**
 * Simplified structure for MERGE RETURNING parsing.
 */
interface ParsedMergeInternal {
  targetTable: string;
  sourceTable: string;
  onCondition: string;
  conflictColumns: string[];
  hasMatchedUpdate: boolean;
  hasNotMatchedInsert: boolean;
  hasMatchedDelete: boolean;
  hasNotMatchedBySourceDelete: boolean;
}

/**
 * Lightweight merge parser for RETURNING purposes.
 * Extracts only what's needed for RETURNING execution.
 */
function parseMergeInternal(sql: string): ParsedMergeInternal | null {
  const parsed = parseMerge(sql); // Use existing parseMerge
  if (!parsed) return null;

  return {
    targetTable: parsed.targetTable,
    sourceTable: parsed.sourceTable,
    onCondition: parsed.onCondition,
    conflictColumns: parsed.conflictColumns,
    hasMatchedUpdate: !!parsed.whenMatchedUpdate,
    hasNotMatchedInsert: !!parsed.whenNotMatchedInsert,
    hasMatchedDelete: !!parsed.whenMatchedDelete,
    hasNotMatchedBySourceDelete: !!parsed.whenNotMatchedBySourceDelete,
  };
}

