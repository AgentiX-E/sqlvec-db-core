/**
 * LiteralProtectionLayer — SQL 字面量和注释保护层
 *
 * 在正则重写器链的入口和出口使用：
 * 1. 入口：注释剥离 + 字面量占位符替换
 * 2. 出口：字面量恢复 + 注释可恢复
 *
 * 原理：
 * - 将所有单引号字符串、双引号标识符、注释替换为占位符 __LIT_N__
 * - 所有 Detect/Rewrite 函数只看到非字面量 SQL 内容
 * - 重写完成后恢复原始字面量
 *
 * 支持的 SQL 语法元素：
 * - 单引号字符串 '...'（含转义单引号 ''）
 * - 双引号标识符 "..."（含转义双引号 ""）
 * - 单行注释 -- ...\n
 * - 多行注释 /* ... *​/
 */

// ── 接口 ──

import { skipSqlLiteral } from './SqlLiteralScanner';

export interface ProtectedSQL {
  /** 保护后的 SQL（字面量已被替换为占位符） */
  protectedSql: string;
  /** 存储的原始字面量（按出现顺序） */
  literals: string[];
  /** 占位符格式（默认为 __LIT_N__） */
  placeholderPrefix: string;
  /** 原始注释 */
  comments: Array<{ text: string; position: number }>;
}

// ── 占位符常量 ──

const DEFAULT_PREFIX = '__LIT_';

/**
 * 生成占位符：__LIT_{N}__
 * 例如：__LIT_0__, __LIT_1__, __LIT_2__
 */
function placeholderFor(index: number): string {
  return `${DEFAULT_PREFIX}${index}__`;
}

/**
 * Placeholder regex source: matches `__LIT_(\d+)__`.
 *
 * NOTE: kept as a *source string* (`.source`) rather than a shared module-level
 * `g` RegExp so every consumer builds its own instance. A shared `g` RegExp
 * would leak `lastIndex` state across `test()`/`replace()` calls (the same trap
 * documented in MacAddrShim), silently causing missed matches depending on call
 * order.
 */
const PLACEHOLDER_RE_SOURCE = '__LIT_(\\d+)__';

/**
 * Return a fresh, non-shared global RegExp matching a placeholder.
 */
function placeholderRegex(): RegExp {
  // eslint-disable-next-line require-unicode-regexp
  return new RegExp(PLACEHOLDER_RE_SOURCE, 'g');
}

// ── 扫描器：按优先级顺序匹配所有字面量和注释 ──

/**
 * 扫描 SQL 中所有需要保护的内容。
 *
 * 优先级：
 * 1. 多行注释 /* ... *​/（不嵌套）
 * 2. 单行注释 -- ... \n
 * 3. 单引号字符串（含 '' 转义）
 * 4. 双引号标识符（含 "" 转义）
 */
function scanLiteralRanges(sql: string): Array<{
  start: number;
  end: number;
  raw: string;
  type: 'string' | 'identifier' | 'single-line-comment' | 'multi-line-comment';
}> {
  const matches: Array<{
    start: number;
    end: number;
    raw: string;
    type: 'string' | 'identifier' | 'single-line-comment' | 'multi-line-comment';
  }> = [];

  // Scan with the shared literal-aware scanner so this protection layer covers
  // exactly the same constructs as `skipSqlLiteral` (including dollar-quoted
  // strings, backtick identifiers, and E'' backslash escapes). Without this the
  // layer would silently leave `$tag$ ... $tag$` and `\`...\`` unprotected.
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped === -1) {
      i++;
      continue;
    }

    const start = i;
    const end = skipped;
    const raw = sql.slice(start, end);
    const c = raw[0];

    let type: 'string' | 'identifier' | 'single-line-comment' | 'multi-line-comment';
    if (c === "'" || c === '$') type = 'string';
    else if (c === '"' || c === '`') type = 'identifier';
    else if (c === '-' && raw[1] === '-') type = 'single-line-comment';
    else type = 'multi-line-comment'; // `/* ... */`

    matches.push({ start, end, raw, type });
    i = end;
  }

  return matches;
}

// ── 保护函数 ──

/**
 * 保护 SQL：替换字符串字面量、注释为占位符。
 *
 * 支持：
 * - 单引号字符串 '...'（含转义单引号 ''）
 * - 双引号标识符 "..."（含转义双引号 ""）
 * - 单行注释 -- ...\n
 * - 多行注释 /* ... *​/
 *
 * @param sql 原始 SQL
 * @returns ProtectedSQL 对象
 */
export function protectSQL(sql: string): ProtectedSQL {
  const literals: string[] = [];
  const comments: Array<{ text: string; position: number }> = [];
  const matches = scanLiteralRanges(sql);

  // 从右向左构建结果字符串，确保排除优先级正确
  // 使用位置标记法：标记哪些范围被替换为占位符
  const protectedChars: string[] = []; // 结果字符串字符
  let litIndex = 0;

  // 方法：将 SQL 拆分为片段，字面量片段替换为占位符
  let lastIndex = 0;
  let result = '';

  for (const match of matches) {
    // 追加匹配开始之前的 SQL
    result += sql.slice(lastIndex, match.start);

    // 存储完整原始值（含引号或注释标记）
    literals.push(match.raw);

    // 用占位符替换
    const placeholder = placeholderFor(litIndex);
    result += placeholder;
    litIndex++;

    // 记录注释信息
    if (match.type === 'single-line-comment' || match.type === 'multi-line-comment') {
      comments.push({
        text: match.raw,
        position: match.start,
      });
    }

    lastIndex = match.end;
  }

  // 追加剩余的 SQL
  result += sql.slice(lastIndex);

  return {
    protectedSql: result,
    literals,
    placeholderPrefix: DEFAULT_PREFIX,
    comments,
  };
}

// ── 恢复函数 ──

/**
 * 恢复 SQL：将占位符替换回原始字面量。
 *
 * 从右向左替换确保偏移量正确。
 *
 * NOTE (known limitation): a bare `__LIT_N__` token that happens to appear in
 * the *original* SQL code (e.g. a real column named `__LIT_0__`) is
 * indistinguishable from a placeholder token and will be replaced if its index
 * is within bounds. This is accepted because the `__LIT_` prefix is an internal
 * convention that never appears in real schema identifiers, and rewriting the
 * placeholder scheme would break consumers (PgCronShim) that in-line match
 * `__LIT_(\d+)__` against `protectedSql`. Strings/comments are safe: they are
 * themselves protected and thus never contain a bare `__LIT_N__` after restore.
 *
 * @param protectedSQL ProtectedSQL 对象
 * @returns 恢复后的原始 SQL
 */
export function restoreSQL(protectedSQL: ProtectedSQL): string {
  let result = protectedSQL.protectedSql;
  const literals = protectedSQL.literals;

  // 使用 replace 替换所有占位符
  result = result.replace(placeholderRegex(), (match, indexStr) => {
    const idx = parseInt(indexStr, 10);
    if (idx >= 0 && idx < literals.length) {
      return literals[idx];
    }
    // 占位符索引越界，保留原样（不应发生）
    return match;
  });

  return result;
}

// ── 工具函数 ──

/**
 * 检查 protectedSql 中是否还有未处理的占位符。
 * 用于验证保护/恢复的一致性。
 */
export function hasPlaceholders(sql: string): boolean {
  return placeholderRegex().test(sql);
}

/**
 * 从 protectedSql 中提取所有占位符索引。
 */
export function extractPlaceholderIndices(protectedSql: string): number[] {
  const indices: number[] = [];
  const re = placeholderRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(protectedSql)) !== null) {
    indices.push(parseInt(m[1], 10));
  }
  return indices;
}
