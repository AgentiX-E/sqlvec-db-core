/**
 * ReturningExecutor — RETURNING 子句执行器
 *
 * SQLite 3.35+ 原生支持 INSERT/UPDATE/DELETE ... RETURNING。
 * better-sqlite3 的 run() 方法丢弃 RETURNING 结果，必须使用 get()/all() 代替。
 *
 * 本模块提供 RETURNING 子句的检测、剥离、分析以及执行辅助函数，
 * 使 QueryRouter 可以从 DML 语句中正确获取 RETURNING 行数据。
 */

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ReturningResult {
  rows: Record<string, any>[];
  rowCount: number;
}

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/** 匹配 RETURNING 子句的正则（不区分大小写）。RETURNING 必须是 DML 的最后一个子句。 */
const RETURNING_PATTERN = /\bRETURNING\b\s*/i;

/** 匹配 INSERT / UPDATE / DELETE DML 语句前缀。 */
const DML_PATTERN = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;

/**
 * 用于识别 "简单" RETURNING 内容的正则。
 * 简单 RETURNING = 仅包含列引用、逗号、AS 别名和空白（即无函数调用、无运算符）。
 */
const SIMPLE_RETURNING_PATTERN = /^[\w"`.\s,]+(?:\s+AS\s+\w+)?(?:\s*,\s*[\w"`.\s,]+(?:\s+AS\s+\w+)?)*$/i;

/** 匹配 DML 语句前的 WITH / WITH RECURSIVE CTE 前缀。 */
const CTE_PATTERN = /^\s*WITH\b/i;

/**
 * 匹配子查询的简单模式 — 检查 DML 的 VALUES/USING/WHERE/SET 部分是否有嵌套 SELECT。
 * 这是一个保守的启发式检测（避免复杂 AST 解析）。
 */
const SUBQUERY_PATTERN = /\(\s*SELECT\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * 判断 RETURNING 子句是否仅包含基础列引用（无聚合/函数调用/运算符）。
 *
 * 简单 RETURNING：
 *   - RETURNING *
 *   - RETURNING col1
 *   - RETURNING col1, col2
 *   - RETURNING col1 AS alias, col2
 *
 * 非简单（需要后处理）：
 *   - RETURNING col1 + 1
 *   - RETURNING COUNT(*)
 *   - RETURNING col1 || ', ' || col2
 *   - RETURNING (SELECT ...)
 *
 * @param returningClause - RETURNING 后的内容（如 "col1, col2" 或 "*"）
 */
export function isSimpleReturning(returningClause: string): boolean {
  const trimmed = returningClause.trim();

  // 空值不算简单
  if (!trimmed) return false;

  // RETURNING * 始终是简单引用
  if (trimmed === '*') return true;

  // 如果包含函数调用（左括号后紧跟非空格，且不是列引用中有括号），判定为复杂
  // 使用 AST 级别的启发式检查
  const hasFunctionCall = detectFunctionCall(trimmed);
  if (hasFunctionCall) return false;

  // 如果包含运算符（+ - * / || 等），判定为复杂
  const hasOperator = /[+\-*/%|&<>=!:]+/.test(trimmed.replace(/'.*?'/g, '').replace(/".*?"/g, ''));
  if (hasOperator) return false;

  // 匹配简单模式：仅限标识符、点号引用、逗号、AS 别名
  return SIMPLE_RETURNING_PATTERN.test(trimmed);
}

/**
 * Strip PG schema qualifiers from SQL.
 *
 * PG allows schema-qualified identifiers like:
 *   "public"."User", "public"."User"."id", "User"."id"
 *
 * SQLite doesn't understand schema/table-qualified dotted identifiers.
 * This function rewrites the SQL so that:
 *   - `"schema"."table"` → `"table"` (table references only)
 *   - `"schema"."table"."column"` → `"column"`
 *   - `"table"."column"` → `"column"`
 *
 * It does NOT strip table-qualified column refs that use unquoted identifiers
 * like `User.id` — those are handled elsewhere or by SQLite itself.
 *
 * Returns null if no rewrite was needed.
 *
 * @param sql - SQL that may contain schema-qualified identifiers
 */
export function stripPGSchemaQualifiers(sql: string): string | null {
  if (typeof sql !== 'string' || !sql) return null;

  let rewritten: string | null = null;

  // Step 1: Replace `"schema"."table"."column"` with `"column"`
  // (3-part: public.User.id)
  const THREE_PART_RE = /"([^"]+)"\."([^"]+)"\."([^"]+)"/g;
  let newSql = sql.replace(THREE_PART_RE, (_match, _schema, _table, column) => {
    rewritten = 'rewritten';
    return `"${column}"`;
  });

  // Step 2: Replace 2-part qualified identifiers ONLY when the first part
  // is a known PG schema (schema.table → table). Do NOT strip general
  // table.column references like "User"."id" — those are needed for
  // column disambiguation in JOINs.
  const SCHEMA_NAMES = ['public', 'pg_catalog', 'pg_temp', 'pg_toast', 'information_schema', 'pg_stat', 'pg_buffercache'];
  const SCHEMA_TABLE_RE = /"([^"]+)"\."([^"]+)"/g;
  newSql = newSql.replace(SCHEMA_TABLE_RE, (match, first, second) => {
    if (SCHEMA_NAMES.includes(first.toLowerCase())) {
      rewritten = 'rewritten';
      return `"${second}"`;
    }
    return match; // Keep table.column references unchanged
  });

  return rewritten !== null ? newSql : null;
}

/**
 * 从 INSERT/UPDATE/DELETE SQL 中剥离 RETURNING 子句，
 * 返回无 RETURNING 的 SQL（供 SQLite 执行）。
 *
 * 例如：
 *   "INSERT INTO t (name) VALUES ('x') RETURNING *"
 *   → "INSERT INTO t (name) VALUES ('x')"
 *
 * @param sql - 原始 SQL（可能含 RETURNING）
 * @returns 无 RETURNING 的 SQL；如果无 RETURNING 则返回原字符串
 */
export function stripReturningClause(sql: string): string {
  const trimmed = sql.trim();
  const match = RETURNING_PATTERN.exec(trimmed);
  if (!match) return sql;

  const returningStart = match.index;
  // RETURNING 子句从匹配位置开始，延伸到字符串末尾
  // 去掉尾部可能的分号（;）
  let result = trimmed.slice(0, returningStart).trimEnd();
  // 去除尾部可能的分号
  result = result.replace(/;\s*$/, '');
  return result;
}

/**
 * 提取 RETURNING 子句内容。
 *
 * 例如：
 *   "INSERT INTO t (name) VALUES ('x') RETURNING *"
 *   → "*"
 *
 *   "INSERT INTO t (name) VALUES ('x') RETURNING id, name AS n"
 *   → "id, name AS n"
 *
 * @param sql - 原始 SQL（可能含 RETURNING）
 * @returns RETURNING 后的内容（无前导空格），或 null（无 RETURNING 子句）
 */
export function extractReturningClause(sql: string): string | null {
  const match = RETURNING_PATTERN.exec(sql.trim());
  if (!match) return null;

  const afterReturning = sql.trim().slice(match.index + match[0].length).trim();
  // 去掉尾部可能的分号
  return afterReturning.replace(/;\s*$/, '').trim() || null;
}

/**
 * 是否为 DML 语句（INSERT / UPDATE / DELETE）。
 * 识别 WITH 开头的 CTE DML 以及普通 DML。
 *
 * 使用 \b 单词边界检测 DML 关键词，支持：
 *   - "INSERT INTO t ..."
 *   - "UPDATE t SET ..."
 *   - "DELETE FROM t ..."
 *   - "WITH cte AS (...) INSERT INTO t ..."
 *
 * @param sql - SQL 字符串
 */
export function isDmlStatement(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) return false;

  // 先检测 WITH CTE 前缀
  if (CTE_PATTERN.test(trimmed)) {
    // WITH CTE 场景：先去掉 CTE 定义，再检查 DML
    const afterCte = stripCteDefinitions(trimmed);
    return DML_PATTERN.test(afterCte);
  }

  return DML_PATTERN.test(trimmed);
}

/**
 * 判断是否为简单 DML（无复杂子查询、无 CTE），
 * 可以直接用 SQLite 原生 RETURNING 执行。
 *
 * 简单 DML 的判断标准：
 *   1. 无 WITH CTE 前缀
 *   2. 无嵌套子查询（在 VALUES/SET/WHERE 中无 SELECT 子查询）
 *   3. RETURNING 子句是简单列引用（如果有的话）
 *
 * @param sql - SQL 字符串
 */
export function shouldUseNativeReturning(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');

  // 必须包含 RETURNING 才能考虑原生执行
  if (!RETURNING_PATTERN.test(trimmed)) {
    return false;
  }

  // 排除 CTE（WITH）
  if (CTE_PATTERN.test(trimmed)) {
    return false;
  }

  // 排除 DML 中的子查询
  const dmlBody = extractDmlBody(trimmed);
  if (dmlBody && SUBQUERY_PATTERN.test(dmlBody)) {
    return false;
  }

  // 简单列引用的 RETURNING 可以直接用 SQLite 原生执行
  const returningClause = extractReturningClause(trimmed);
  if (returningClause && !isSimpleReturning(returningClause)) {
    // 非简单 RETURNING（有表达式/函数）也可用原生，因为 SQLite 支持表达式
    // 但这里保守处理：只要不是简单引用，就认为可能有兼容性问题
    return false;
  }

  return true;
}

// ──────────────────────────────────────────────
//  Internal Helpers
// ──────────────────────────────────────────────

/**
 * 检测 RETURNING 表达式是否包含函数调用。
 * 通过简单的括号匹配来启发式检测。
 *
 * 检测到的情况：
 *   - COUNT(*)
 *   - UPPER(col)
 *   - COALESCE(col, 0)
 *
 * 不误报的情况：
 *   - 括号不在标识符后紧接
 */
function detectFunctionCall(expr: string): boolean {
  // 去除字符串字面量以避免误报
  const cleaned = expr.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');

  // 查找 "标识符(" 模式 — 标识符后紧跟左括号（无空格，或空格后左括号）
  // 这表示一个函数调用
  const funcMatch = cleaned.match(/\b[a-zA-Z_]\w*\s*\(/);
  if (!funcMatch) return false;

  const matched = funcMatch[0].trim();
  // "列引用带括号" 场景实际不是函数调用，例如 "col(1)" 不是 SQL 函数
  // 但 SQL 中几乎不会出现这样的列名，所以可以接受这个误报率
  // 进一步：检查匹配位置前是否有 "AS" — AS 后的表达式不可能是函数调用？
  // 这里保守地认为任何 "标识符(" 都是函数调用

  return true;
}

/**
 * 提取 DML 语句的主体部分（去除 RETURNING 子句），
 * 用于子查询检测。
 */
function extractDmlBody(sql: string): string {
  const stripped = stripReturningClause(sql);
  // Strip a CTE prefix if present. Unreachable via shouldUseNativeReturning,
  // which already rejects CTE statements before calling extractDmlBody; kept
  // as a defensive safety net for future direct callers.
  /* c8 ignore next 3 */
  if (CTE_PATTERN.test(stripped)) {
    return stripCteDefinitions(stripped);
  }
  return stripped;
}

/**
 * 剥离 WITH CTE 定义前缀，返回纯 DML 语句。
 *
 * 输入: "WITH c AS (SELECT 1), d AS (SELECT 2) INSERT INTO t VALUES (1)"
 * 输出: "INSERT INTO t VALUES (1)"
 *
 * 策略：从右向左搜索 DML 关键词（INSERT/UPDATE/DELETE），
 * 取从 DML 关键词开始到字符串末尾的部分。
 */
function stripCteDefinitions(sql: string): string {
  const trimmed = sql.replace(/^\s*WITH\s+(?:RECURSIVE\s+)?/i, '');

  // 从右向左查找第一个 DML 关键词
  // 注意：CTE 定义中的子查询可能包含 INSERT/UPDATE/DELETE（罕见但可能），
  // 所以我们找最后一个出现的 DML 关键词
  const dmlMatch = trimmed.match(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i);
  if (dmlMatch && dmlMatch.index !== undefined) {
    return trimmed.slice(dmlMatch.index);
  }

  // 未找到 DML（理论上不该发生，但防御性编程）
  return trimmed;
}
