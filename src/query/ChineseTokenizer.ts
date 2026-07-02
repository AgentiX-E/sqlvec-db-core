/**
 * ChineseTokenizer — 中文文本分词器
 *
 * 优先使用 jieba-wasm 进行中文分词，如果 jieba-wasm 不可用则使用
 * 基于 CJK Unicode 范围的最简字符拆分作为 fallback。
 *
 * 集成了 FTS 字典系统：
 *   - Unaccent（去除变音符号）通过 NFKD 标准化
 *   - 支持与 FtsTranslator 的字典链集成
 *
 * @module query/ChineseTokenizer
 */

// ── CJK Unicode 范围 ────────────────────────────────────────────
// 常用中文字符、中文标点、全角符号等 Unicode 范围
const CJK_RANGES = [
  [0x2e80, 0x2eff],   // CJK 部首补充
  [0x2f00, 0x2fdf],   // 康熙部首
  [0x3000, 0x303f],   // CJK 符号和标点
  [0x3400, 0x4dbf],   // CJK 统一表意文字扩展 A
  [0x4e00, 0x9fff],   // CJK 统一表意文字
  [0xf900, 0xfaff],   // CJK 兼容表意文字
  [0xff00, 0xffef],   // 全角 ASCII、全角标点
] as const;

/**
 * 检测文本中是否包含 CJK 统一表意文字（中文）。
 *
 * @param text - 要检测的文本
 * @returns 如果包含中文字符返回 true，否则返回 false
 */
export function isChinese(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    for (const [start, end] of CJK_RANGES) {
      if (code >= start && code <= end) {
        return true;
      }
    }
  }
  return false;
}

// ── jieba-wasm 加载 ─────────────────────────────────────────────

let _jieba: typeof import('jieba-wasm') | null = null;
let _jiebaLoadError: Error | null = null;

function getJieba(): typeof import('jieba-wasm') | null {
  if (_jieba !== null) return _jieba;
  if (_jiebaLoadError !== null) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _jieba = require('jieba-wasm');
    return _jieba;
  } catch (err) {
    _jiebaLoadError = err instanceof Error ? err : new Error(String(err));
    return null;
  }
}

/**
 * 使用 jieba-wasm 对中文文本进行分词。
 *
 * 分词模式：使用 `cut()` 的精确模式（默认），适用于 FTS5 索引。
 * 如果 jieba-wasm 无法加载，回退到最简分词（按字符拆分）。
 *
 * @param text - 待分词的中文文本
 * @returns 分词结果数组
 */
export function tokenize(text: string): string[] {
  const jieba = getJieba();

  if (jieba !== null) {
    try {
      // 使用 cut 默认模式（精确模式），不启用 HMM
      // 过滤掉纯空白符 token，消除 jieba 将单词间空格作为独立 token 的行为
      return jieba.cut(text, false).filter((t: string) => t.trim().length > 0);
    } catch {
      // jieba 运行时失败，降级到 fallback
    }
  }

  return fallbackTokenize(text);
}

/**
 * 对中文文本进行分词，返回空格分隔的字符串，可直接插入 FTS5 表。
 *
 * 对于混合中英文内容，中文部分使用 jieba 分词，英文部分保留原样
 * （英文会在自动被空格分隔）。
 *
 * @param text - 待分词的文本
 * @returns 空格分隔的分词结果字符串
 */
export function tokenizeForFTS(text: string): string {
  const tokens = tokenize(text);
  return tokens.join(' ');
}

// ── Unaccent (去除变音符号) ──────────────────────────────────────

/**
 * 去除文本中的变音符号（重音符号），使用 NFKD 标准化。
 *
 * 例如：é → e, ü → u, ñ → n
 *
 * @param s - 可能包含变音符号的文本
 * @returns 去除变音符号后的文本
 */
export function unaccent(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

// ── Fallback 分词 ──────────────────────────────────────────────

/**
 * 基于 CJK Unicode 范围的最简分词 fallback。
 *
 * 策略：
 *   - 对于连续的中文字符，每个字符拆分为单独的词
 *   - 非中文部分（英文、数字等）保留原样
 *
 * @param text - 待分词的文本
 * @returns 分词结果数组
 */
function fallbackTokenize(text: string): string[] {
  const tokens: string[] = [];
  let currentBuffer = '';

  for (const char of text) {
    const code = char.charCodeAt(0);
    const isCJK = CJK_RANGES.some(([start, end]) => code >= start && code <= end);

    if (isCJK) {
      // 非中文缓冲区有内容，先提交
      if (currentBuffer.length > 0) {
        pushNormalized(tokens, currentBuffer);
        currentBuffer = '';
      }
      // 单个 CJK 字符作为一个独立的词
      tokens.push(char);
    } else {
      currentBuffer += char;
    }
  }

  // 处理剩余的非中文内容
  if (currentBuffer.length > 0) {
    pushNormalized(tokens, currentBuffer);
  }

  return tokens.filter(Boolean);
}

/**
 * 将文本按空白符拆分并加入 token 列表，同时过滤空串和纯空白。
 */
function pushNormalized(tokens: string[], text: string): void {
  const parts = text
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);

  for (const part of parts) {
    tokens.push(part);
  }
}
