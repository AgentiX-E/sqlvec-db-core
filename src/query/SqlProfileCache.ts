/**
 * SqlProfileCache — SQL 分类分析与缓存系统
 *
 * 核心思路：
 *   1. 对每条 SQL 做一次分类（单趟 regex 扫描），确定它是否需要 PG 特有的语法改写
 *   2. 缓存分类结果（LRU），后续相同 SQL 命中缓存 → 零检测开销
 *   3. 标准 SQL（isStandardSQL=true）绕过整个 executeInternal 管线，
 *      通过 routing 信息直接路由到正确的 shard
 *
 * 为什么这是一次真正的优化：
 *   - executeInternal 有 ~1600 行代码、50+ detect/rewrite 调用
 *   - 每个 detect() 都是一次完整 regex 回溯
 *   - pgbench TPC-B 只有 7 种 SQL pattern，第一个事务后缓存命中率 100%
 *   - 标准 SQL 无需任何 PG 改写 → 全部跳过 → 零额外开销
 *
 * Routing 逻辑：
 *   - SELECT with WHERE key → 路由到目标 shard（单 shard 查询）
 *   - INSERT with VALUES → 路由到目标 shard
 *   - UPDATE/DELETE with WHERE key → 路由到目标 shard
 *   - 无 key / 复杂语句 / DDL → broadcast 或 shard 0
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('SqlProfileCache');

// ──────────────────────────────────────────────────
//  PG-Specific Syntax Patterns（按功能分组）
// ──────────────────────────────────────────────────

/** 所有 PG 特有语法的组合正则。一条 SQL 匹配其中任何一项 = non-standard */
const PG_SPECIFIC_PATTERN = new RegExp([
  // ── Types & Casts ──
  /::\s*(?:\w+(?:\[\])?(?:\s*,\s*\w+(?:\[\])?)*)?/.source,                        // ::type type cast
  /\bSERIAL\b|\bBIGSERIAL\b|\bSMALLSERIAL\b/.source,                                // SERIAL 系列类型
  /\bROW\b(?!\s*NUMBER)\s*\(/.source,                                                // ROW(...) 构造器
  /\bRECORD\b/.source,                                                               // RECORD 类型
  /\bXML\s*(?:PARSE|SERIALIZE|AGGREGATE|TABLE|EXISTS|CONCAT|COMMENT)\b/.source,     // XML 函数
  /\bCOMPOSITE\b/.source,                                                            // COMPOSITE 类型
  /\bDOMAIN\b/.source,                                                               // DOMAIN 类型

  // ── Arrays ──
  /\bARRAY\s*\[/.source,                                                              // ARRAY[...] 构造
  /\bARRAY\s*\(/.source,                                                              // ARRAY(subquery)
  /\bANY\s*\(/.source,                                                               // ANY (subquery/array)
  /\bALL\s*\(/.source,                                                               // ALL (subquery/array)
  /\bUNNEST\b/.source,                                                               // UNNEST 函数

  // ── String / Pattern Matching ──
  /\bILIKE\b/.source,                                                                // ILIKE（大小写不敏感 LIKE）
  /\bSIMILAR\s+TO\b/.source,                                                         // SIMILAR TO
  /\$\$/.source,                                                                      // $$ 美元引号
  /\bSUBSTRING\s*\(/.source,                                                          // SUBSTRING 函数（PG 版支持 regex）

  // ── JSON ──
  /->>?/.source,                                                                      // -> 和 ->> JSON 操作符
  /#>>?/.source,                                                                      // #> 和 #>> JSON 路径
  /@>/.source,                                                                        // @> JSON 包含
  /<@/.source,                                                                        // <@ JSON 被包含
  /\bJSON_EXISTS\b|\bJSON_VALUE\b|\bJSON_QUERY\b|\bJSON_TABLE\b|\bJSON_SCALAR\b|\bJSON_SERIALIZE\b/.source,
  /\bJSON_OBJECTAGG\b|\bJSON_ARRAYAGG\b/.source,
  /\bJSON\b.*\bRETURNING\b/.source,                                                    // JSON ... RETURNING

  // ── DDL ──
  /\bCREATE\s+EXTENSION\b/.source,                                                     // CREATE EXTENSION
  /\bCREATE\s+(?:OR\s+)?REPLACE\s+(?:FUNCTION|PROCEDURE|AGGREGATE)\b/.source,          // PL/pgSQL 函数
  /\bCREATE\s+RULE\b/.source,                                                          // CREATE RULE
  /\bCREATE\s+SEQUENCE\b/.source,                                                      // CREATE SEQUENCE
  /\bGENERATED\s+(?:ALWAYS\s+)?AS\s+IDENTITY\b/.source,                                // GENERATED ... AS IDENTITY
  /\bSECURITY\s+LABEL\b/.source,                                                       // SECURITY LABEL
  /\bSECURITY\s+BARRIER\b/.source,                                                     // SECURITY BARRIER
  /\bFOREIGN\s+(?:DATA\s+)?WRAPPER\b/.source,                                          // FDW
  /\bFOREIGN\s+TABLE\b/.source,                                                        // FOREIGN TABLE
  /\bCREATE\s+SERVER\b/.source,                                                        // CREATE SERVER
  /\bCREATE\s+USER\s+MAPPING\b/.source,                                                // CREATE USER MAPPING
  /\bPUBLICATION\b|\bSUBSCRIPTION\b/.source,                                            // Publication/Subscription
  /\bREPLICATION\b/.source,                                                             // Replication slot
  /\bTABLESPACE\b/.source,                                                              // TABLESPACE
  /\bINHERITS\b/.source,                                                                // INHERITS
  /\bPARTITION\s+OF\b/.source,                                                         // PARTITION OF

  // ── DML ──
  /\bMERGE\s+INTO\b/.source,                                                            // MERGE INTO
  /\bINSERT\s+OVERWRITE\b/.source,                                                      // INSERT OVERWRITE
  /\bON\s+CONFLICT\b/.source,                                                           // ON CONFLICT（SQLite 也支持，但 PG 版语法不同）
  /\bRETURNING\b/.source,                                                               // RETURNING 子句
  /\bDISTINCT\s+ON\b/.source,                                                           // DISTINCT ON

  // ── Query Constructs ──
  /\bLATERAL\b/.source,                                                                 // LATERAL 子查询
  /\bMATERIALIZED\b/.source,                                                            // CTE 的 MATERIALIZED
  /\bSEARCH\s+(?:BREADTH|DEPTH)\s+FIRST\b/.source,                                     // CTE 的 SEARCH
  /\bCYCLE\b/.source,                                                                   // CTE 的 CYCLE
  /\bFETCH\s+(?:FIRST|NEXT)\b/.source,                                                  // FETCH FIRST/NEXT
  /\bTABLESAMPLE\b/.source,                                                             // TABLESAMPLE
  /\bGROUPING\s+SETS\b|\bCUBE\b|\bROLLUP\b/.source,                                    // GROUPING SETS / CUBE / ROLLUP
  /\bFILTER\s*\(/.source,                                                              // FILTER (WHERE) 聚合条件
  /\bWITHIN\s+GROUP\b/.source,                                                          // WITHIN GROUP (ORDER BY)
  /\bEXCLUDE\s+(?:CURRENT\s+(?:ROW|GROUP)|GROUP|TIES)\b/.source,                        // Window frame EXCLUDE
  /\bGROUPS\b(?!\s+BY\b)/.source,                                                       // Window frame GROUPS

  // ── Security / Permission ──
  /\bSECURITY\s+(?:LABEL|BARRIER|INVOKER|DEFINER)\b/.source,
  /\bGRANT\s+ALL\b/.source,                                                             // GRANT ALL
  /\bSET\s+(?:SESSION\s+|LOCAL\s+)?(?:AUTHORIZATION|ROLE|SESSION\s+AUTHORIZATION)\b/.source,

  // ── 2PC / Transaction ──
  /\bPREPARE\s+TRANSACTION\b/.source,                                                   // PREPARE TRANSACTION
  /\bCOMMIT\s+PREPARED\b/.source,                                                       // COMMIT PREPARED
  /\bROLLBACK\s+PREPARED\b/.source,                                                     // ROLLBACK PREPARED
  /\bSAVEPOINT\s+\w+/i.source,                                                          // SAVEPOINT

  // ── System / Maintenance ──
  /\bCHECKPOINT\b/.source,                                                              // CHECKPOINT
  /\bDISCARD\b/.source,                                                                 // DISCARD
  /\bLISTEN\b/.source,                                                                  // LISTEN
  /\bNOTIFY\b/.source,                                                                  // NOTIFY
  /\bLOAD\b/.source,                                                                    // LOAD
  /\bANALYZE\b/.source,                                                                // ANALYZE（PG 特有语法）
  /\bCLUSTER\b/.source,                                                                // CLUSTER
  /\bREINDEX\b/.source,                                                                // REINDEX
  /\bREFRESH\s+MATERIALIZED\s+VIEW\b/.source,                                          // REFRESH MATERIALIZED VIEW
  /\bVACUUM\b/.source,                                                                 // VACUUM

  // ── Vector / Extension Functions ──
  /\bvss_/.source,                                                                       // vss_ 向量函数
  /\bpg_catalog\b/.source,                                                               // pg_catalog schema
  /\bpg_typeof\b|\bpg_sleep\b|\bpg_backend_pid\b|\bpg_read_file\b/i.source,
  /\bpg_stat_activity\b|\bpg_stat_database\b|\bpg_stat_user_tables\b|\bpg_stat_bgwriter\b/i.source,
  /\bpg_dump\b|\bpg_restore\b/.source,                                                   // pg_dump related
  /\bpgcrypto\b|\bpgp_sym_encrypt\b|\bpgp_sym_decrypt\b|\bdigest\b|\bhmac\b/i.source,   // pgcrypto

  // ── Type Conversion Functions ──
  /\bCAST\s*\(/.source,                                                                  // CAST(x AS type)
  /\bCOALESCE\b/.source,                                                                // COALESCE（SQLite 不支持）
  /\bGREATEST\b|\bLEAST\b/.source,                                                       // GREATEST/LEAST

  // ── DDL Compatibility ──
  /\bTABLE\s+\(/.source,                                                                 // TABLE(col) 简写
  /\bIF\s+NOT\s+EXISTS\b/.source,                                                        // IF NOT EXISTS（SQLite 不支持全场景）
  /\bIF\s+EXISTS\b/.source,                                                              // IF EXISTS
  /\bALTER\s+TABLE\s+.*\bOWNER\s+TO\b/.source,                                          // ALTER TABLE ... OWNER TO
  /\bALTER\s+TABLE\s+.*\bSET\s+TABLESPACE\b/.source,                                    // ALTER TABLE ... SET TABLESPACE

  // ── Window Function Extensions ──
  /\bDENSE_RANK\b|\bNTILE\b|\bPERCENT_RANK\b|\bCUME_DIST\b|\bFIRST_VALUE\b|\bLAST_VALUE\b|\bLAG\b|\bLEAD\b|\bNTH_VALUE\b/i.source,

  // ── Full-Text Search ──
  /\bTSVECTOR\b|\bTSQUERY\b|\bTS_RANK\b|\bTO_TSVECTOR\b|\bTO_TSQUERY\b|\bPLAINTO_TSQUERY\b|\bPHRASETO_TSQUERY\b|\bWEBSEARCH_TO_TSQUERY\b/i.source,
  /\b@@\b/.source,                                                                       // FTS @@ operator

  // ── Array / List Functions ──
  /\bSTRING_TO_ARRAY\b|\bARRAY_TO_STRING\b|\bARRAY_AGG\b|\bARRAY_APPEND\b|\bARRAY_CAT\b|\bARRAY_NDIMS\b|\bARRAY_DIMS\b|\bARRAY_LENGTH\b|\bARRAY_LOWER\b|\bARRAY_POSITION\b|\bARRAY_POSITIONS\b|\bARRAY_PREPEND\b|\bARRAY_REMOVE\b|\bARRAY_REPLACE\b|\bARRAY_TO_STRING\b|\bARRAY_UPPER\b|\bCARDINALITY\b/i.source,

  // ── Misc ──
  /\bINHERITS\s*\(/.source,                                                              // INHERITS (parent table)
  /\bONLY\s+\w+/.source,                                                                 // ONLY tablename
  /\bCONCURRENTLY\b/.source,                                                             // CONCURRENTLY
  /\bINCLUDING\s+(?:ALL|COMMENTS|CONSTRAINTS|DEFAULTS|IDENTITY|INDEXES|STATISTICS|STORAGE)\b/.source,  // INCLUDING
  /\bEXCLUDING\s+(?:ALL|COMMENTS|CONSTRAINTS|DEFAULTS|IDENTITY|INDEXES|STATISTICS|STORAGE)\b/.source,  // EXCLUDING
  /\bUSING\s+(?:HASH|GIST|SPGIST|GIN|BRIN|BLOOM)\s*\(/.source,                          // Index method
  /\bUSING\s+(?:BTREE)\s*\(/.source,                                                     // USING BTREE (SQLite default)
].map(re => re.replace(/^\^|\$$/g, '')).join('|'), 'i');

// Quick check for common patterns — avoids full regex when possible
const PIPE = '|';

// ──────────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────────

/** SQL 路由决策 */
export type SqlRouting =
  | { type: 'single-shard'; shardId: number; key?: string }
  | { type: 'all-shards' }
  | { type: 'ddl'; shardId: number }
  | { type: 'no-route' };

/** 分类结果 */
export interface SqlProfile {
  /** true = 纯标准 SQL，无需任何 PG 改写 */
  isStandardSQL: boolean;
  /** 路由决策 */
  routing: SqlRouting;
  /** normalized SQL（用于缓存 key） */
  normalized: string;
}

// ──────────────────────────────────────────────────
//  LRU Cache
// ──────────────────────────────────────────────────

class LRUMap<K, V> extends Map<K, V> {
  constructor(private max: number) { super(); }
  get(key: K): V | undefined {
    const val = super.get(key);
    if (val !== undefined) { this.delete(key); this.set(key, val); }
    return val;
  }
  set(key: K, val: V): this {
    if (this.size >= this.max) { const first = this.keys().next(); if (!first.done) this.delete(first.value); }
    return super.set(key, val);
  }
}

// ──────────────────────────────────────────────────
//  SQL Normalization
// ──────────────────────────────────────────────────

/**
 * 对 SQL 做轻量归一化，用于缓存 key。
 * 不改变语义，只做 whitespace 合并 + trim。
 * 保留参数占位符（$1, $2）不变。
 */
function normalizeSQL(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')          // Remove line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
    .replace(/\s+/g, ' ')            // Collapse whitespace
    .replace(/\s*([(),;=<>!+\-*/])\s*/g, '$1') // Compact around operators
    .replace(/\s*['"]/g, "'")        // Remove space before quotes
    .trim();
}

/**
 * patternizeSQL — 令牌化 SQL，将所有字面量替换为 `?`，生成 pattern key。
 *
 * 采用**单趟字符级 tokenizer**（非正则）来正确识别 SQL 令牌边界。
 * 跟踪状态：当前是否在字符串内、注释内，确保不被内容中的符号干扰。
 *
 * 替换以下类型字面量：
 *   - 数字：整数（42, -5, +3），浮点数（3.14, .5, -2.0），科学计数法（1.5e10, 2E-3）
 *   - 字符串：单引号字符串（'hello'），转义引号（'it''s'），Unicode 转义（E'\u0041'）
 *   - 美元引号字符串（$$...$$, $tag$...$tag$）
 *   - 十六进制字面量（X'1A2F'）
 *   - 位串字面量（B'1010'）
 *
 * 不替换：
 *   - 标识符（表名、列名）
 *   - SQL 关键字（SELECT, WHERE 等）
 *   - 操作符（=, +, IN, BETWEEN 等）
 *
 * @param sql - 原始 SQL（在 normalizeSQL 之前调用，避免字符串内容被预处理破坏）
 * @returns 所有字面量已替换为 `?` 的 pattern 字符串
 */
function patternizeSQL(sql: string): string {
  const out: string[] = [];
  let i = 0;

  while (i < sql.length) {
    // ── Line comment: -- ... ──
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }

    // ── Block comment: /* ... */ ──
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // ── Single-quoted string literal: 'hello', 'it''s', E'\u0041' ──
    if (sql[i] === "'") {
      out.push('?');
      i++;
      let escaped = false;
      while (i < sql.length) {
        if (escaped) { escaped = false; i++; continue; }
        // PostgreSQL E'...' escape sequences
        if (sql[i] === '\\') { escaped = true; i++; continue; }
        if (sql[i] === "'") {
          // SQL double-quote escape: ''
          if (i + 1 < sql.length && sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // ── Dollar-quoted string: $$...$$, $tag$...$tag$  ──
    if (sql[i] === '$') {
      const tagStart = i;
      i++;
      while (i < sql.length && sql[i] !== '$') i++;
      if (i < sql.length) {
        const openTag = sql.slice(tagStart, i + 1); // e.g. $tag$ or $$
        const closeIdx = sql.indexOf(openTag, i + 1);
        if (closeIdx !== -1) {
          out.push('?');
          i = closeIdx + openTag.length;
          continue;
        }
      }
      // Fallback: no matching close tag, emit as-is
      i = tagStart;
      out.push(sql[i++]);
      continue;
    }

    // ── Double-quoted identifier: "table_name" ──
    // NOT replaced (identifiers are structural) — but the full quoted token
    // must be preserved so distinct identifiers do not collapse to the same
    // cache key. Copy the whole `"..."` span verbatim.
    if (sql[i] === '"') {
      const start = i;
      i++;
      while (i < sql.length && sql[i] !== '"') {
        if (sql[i] === '\\') { i++; } // Handle escaped quotes
        i++;
      }
      if (i < sql.length) i++; // include the closing quote
      out.push(sql.slice(start, i));
      continue;
    }

    // ── Hex literal (X'...', x'...') and Bit literal (B'...', b'...') ──
    // Must come BEFORE identifier check, so X'1A2F' is parsed as a single token
    // rather than identifier X + string '1A2F'.
    if ((sql[i] === 'x' || sql[i] === 'X' || sql[i] === 'b' || sql[i] === 'B') &&
        i + 1 < sql.length && sql[i + 1] === "'") {
      const prefix = sql[i];
      const endQuote = sql.indexOf("'", i + 2);
      if (endQuote !== -1) {
        const content = sql.slice(i + 2, endQuote);
        const validHex = prefix === 'x' || prefix === 'X'
          ? /^[0-9A-Fa-f]*$/.test(content)
          : /^[01]*$/.test(content);
        if (validHex) {
          out.push('?');
          i = endQuote + 1;
          continue;
        }
      }
    }

    // ── Identifier (letter or underscore start) ──
    // MUST come before number check to prevent `col_1` → `col_?`
    if (/[a-zA-Z_]/.test(sql[i])) {
      let j = i;
      while (j < sql.length && /[a-zA-Z_0-9]/.test(sql[j])) j++;
      out.push(sql.slice(i, j));
      i = j;
      continue;
    }

    // ── Number (integer, float, scientific) ──
    // Pattern: optional sign + digits + optional ('.' digits + optional exponent)
    // Start with digits OR '.' followed by digits OR sign followed by digits
    if (
      /\d/.test(sql[i]) ||
      (sql[i] === '.' && i + 1 < sql.length && /\d/.test(sql[i + 1])) ||
      ((sql[i] === '-' || sql[i] === '+') && i + 1 < sql.length && /\d/.test(sql[i + 1]))
    ) {
      let j = i;

      // Unary sign
      if (sql[j] === '-' || sql[j] === '+') j++;

      // Integer part
      while (j < sql.length && /\d/.test(sql[j])) j++;

      // Fractional part: .digits
      if (j < sql.length && sql[j] === '.' && j + 1 < sql.length && /\d/.test(sql[j + 1])) {
        j++; // skip '.'
        while (j < sql.length && /\d/.test(sql[j])) j++;
      }

      // Scientific notation: e[+-]digits
      if (j < sql.length && (sql[j] === 'e' || sql[j] === 'E')) {
        const expStart = j;
        j++;
        if (j < sql.length && (sql[j] === '-' || sql[j] === '+')) j++;
        if (j < sql.length && /\d/.test(sql[j])) {
          while (j < sql.length && /\d/.test(sql[j])) j++;
        } else {
          j = expStart; // Not scientific, backtrack
        }
      }

      out.push('?');
      i = j;
      continue;
    }

    // ── Other character: emit as-is ──
    out.push(sql[i]);
    i++;
  }

  return out.join('');
}

// ──────────────────────────────────────────────────
//  Routing
// ──────────────────────────────────────────────────

/**
 * 从 SQL 中提取 WHERE 条件中的键值，用于 shard 路由。
 * 支持 aid, bid, tid, *_id, id 等常见主键列名。
 */
function extractWhereKey(sql: string): { key: string; value: string } | null {
  // Match: WHERE "col" = 'value'  or  WHERE col = value
  const whereMatch = sql.match(/\bWHERE\s+(?:"(\w+)"|(\w+))\s*=\s*(?:'(\d+)'|"(\d+)"|(\d+))/i);
  if (!whereMatch) return null;
  // A successful match already guarantees a non-empty column name (`\w+`) and a
  // non-empty numeric value (`\d+`), so no further nullability guard is needed.
  const col = whereMatch[1] || whereMatch[2];
  const val = whereMatch[3] || whereMatch[4] || whereMatch[5];
  return { key: col, value: val };
}

/**
 * 从 INSERT 语句中提取将要插入的键值。
 */
function extractInsertKey(sql: string): { key: string; value: string } | null {
  // Match: INSERT INTO t(col, aid, ...) VALUES(v1, val, ...)
  const insertIntoMatch = sql.match(/INSERT\s+INTO\s+(?:"(\w+)"|(\w+))\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
  if (!insertIntoMatch) return null;
  const cols = insertIntoMatch[3].split(',').map(c => c.trim().replace(/"/g, ''));
  const vals = insertIntoMatch[4].split(',').map(v => v.trim().replace(/['"]/g, ''));

  // Find first key column
  const keyIdx = cols.findIndex(c => /^(id|aid|bid|tid|.*_id)$/i.test(c));
  if (keyIdx >= 0 && keyIdx < vals.length) {
    return { key: cols[keyIdx], value: vals[keyIdx] };
  }
  return null;
}

/**
 * 简单一致性哈希：string → shardId
 */
function hashToShard(key: string, shardCount: number): number {
  if (shardCount <= 1) return 0;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0; // Convert to 32-bit int
  }
  return Math.abs(hash) % shardCount;
}

// ──────────────────────────────────────────────────
//  SqlProfileCache
// ──────────────────────────────────────────────────

export class SqlProfileCache {
  private cache: LRUMap<string, SqlProfile>;
  private shardCount: number = 1;

  constructor(maxEntries: number = 1000) {
    this.cache = new LRUMap<string, SqlProfile>(maxEntries);
  }

  /** 设置当前 shard 数量（由外部更新） */
  setShardCount(count: number): void {
    this.shardCount = count;
  }

  /**
   * 获取 SQL 的分类结果。
   * 缓存 key 使用 patternized SQL，所有字面量替换为 `?`：
   *
   *     UPDATE pgbench_accounts SET abalance = abalance + 1274 WHERE aid = 42
   *     →  UPDATE pgbench_accounts SET abalance = abalance + ? WHERE aid = ?
   *
   *     WHERE name = 'Alice'   ←→   WHERE name = 'Bob'
   *     →  WHERE name = ?      ←→   WHERE name = ?
   *
   * 命中缓存 → 复用分类结果，按需重新计算 routing（依赖实际值）。
   * 未命中 → 执行 classify 后缓存。
   *
   * Pipeline:
   *   1. patternizeSQL(sql) → 对原始 SQL 做令牌化，替换所有字面量为 `?`
   *      （在 normalizeSQL 之前调用，确保字符串内容不被预处理器破坏）
   *   2. normalizeSQL(patternKey) → whitespace/operator 归一化，生成缓存 key
   *   3. inferRouting(normalizeSQL(sql)) → 用原始值计算 shard 路由
   */
  getProfile(sql: string): SqlProfile {
    // 1&2: Patternize raw SQL → normalize → cache key
    const patternKey = normalizeSQL(patternizeSQL(sql));
    // 3: Original values for routing (patternize would remove the numbers we need)
    const routingSql = normalizeSQL(sql);

    const cached = this.cache.get(patternKey);
    if (cached) {
      return {
        isStandardSQL: cached.isStandardSQL,
        routing: cached.isStandardSQL
          ? this.inferRouting(routingSql)
          : { type: 'no-route' as const },
        normalized: patternKey,
      };
    }

    const isStandardSQL = !PG_SPECIFIC_PATTERN.test(patternKey);
    const routing = isStandardSQL
      ? this.inferRouting(routingSql)
      : { type: 'no-route' as const };

    const profile: SqlProfile = { isStandardSQL, routing, normalized: patternKey };
    this.cache.set(patternKey, profile);
    return profile;
  }

  /** 清空缓存（shardCount 变化时调用） */
  clear(): void {
    this.cache.clear();
  }

  /** 缓存条目数 */
  get size(): number {
    return this.cache.size;
  }

  // ── Private ──

  /**
   * 为标准 SQL 推断路由决策。
   * - SELECT / UPDATE / DELETE with simple WHERE key → single-shard
   * - INSERT with explicit key column → single-shard
   * - INSERT without key / SELECT without WHERE / scanning queries → all-shards
   * - DDL / transaction control / etc. → shard 0
   */
  private inferRouting(sql: string): SqlRouting {
    const shardCount = this.shardCount;
    const upperSQL = sql.toUpperCase().trim();

    // BEGIN / COMMIT / ROLLBACK → single shard 0
    if (/^(BEGIN|COMMIT|ROLLBACK|END)\b/.test(upperSQL)) {
      return { type: 'single-shard', shardId: 0 };
    }

    // DDL → single shard 0
    if (/^(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/.test(upperSQL)) {
      return { type: 'ddl', shardId: 0 };
    }

    // SELECT, UPDATE, DELETE, INSERT → attempt key-based routing
    if (/^(SELECT|UPDATE|DELETE)\b/.test(upperSQL)) {
      const key = extractWhereKey(sql);
      if (key) {
        const shardId = hashToShard(key.value, shardCount);
        return { type: 'single-shard', shardId, key: key.value };
      }
      return { type: 'all-shards' };
    }

    if (/^INSERT\b/.test(upperSQL)) {
      const key = extractInsertKey(sql);
      if (key) {
        const shardId = hashToShard(key.value, shardCount);
        return { type: 'single-shard', shardId, key: key.value };
      }
      return { type: 'all-shards' };
    }

    // SET / SHOW / other → single shard 0
    return { type: 'single-shard', shardId: 0 };
  }
}
