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
 * 占位符正则模式：__LIT_(\d+)__
 */
const PLACEHOLDER_RE = /__LIT_(\d+)__/g;

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

  // 正则匹配顺序：
  // 1. 单引号字符串 '...'（支持 '' 转义）
  // 2. 双引号标识符 "..."（支持 "" 转义）
  // 3. 单行注释 -- ... \n
  // 4. 多行注释 /* ... */
  const re = /'(?:[^']*(?:''[^']*)*)'|"(?:[^"]*(?:""[^"]*)*)"|--[^\n]*|\/\*[\s\S]*?\*\//g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(sql)) !== null) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;

    if (raw.startsWith("'")) {
      matches.push({ start, end, raw, type: 'string' });
    } else if (raw.startsWith('"')) {
      matches.push({ start, end, raw, type: 'identifier' });
    } else if (raw.startsWith('--')) {
      matches.push({ start, end, raw, type: 'single-line-comment' });
    } else if (raw.startsWith('/*')) {
      matches.push({ start, end, raw, type: 'multi-line-comment' });
    }
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
 * @param protectedSQL ProtectedSQL 对象
 * @returns 恢复后的原始 SQL
 */
export function restoreSQL(protectedSQL: ProtectedSQL): string {
  let result = protectedSQL.protectedSql;
  const literals = protectedSQL.literals;

  // 使用 replace 替换所有占位符
  result = result.replace(PLACEHOLDER_RE, (match, indexStr) => {
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
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(sql);
}

/**
 * 从 protectedSql 中提取所有占位符索引。
 */
export function extractPlaceholderIndices(protectedSql: string): number[] {
  const indices: number[] = [];
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(protectedSql)) !== null) {
    indices.push(parseInt(m[1], 10));
  }
  return indices;
}
