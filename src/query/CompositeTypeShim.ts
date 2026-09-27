/**
 * CompositeTypeShim — PostgreSQL composite type compatibility shim for SQLite.
 *
 * PostgreSQL supports composite (row) types via:
 *   CREATE TYPE name AS (col1 type1, col2 type2, ...)
 * and field access syntax (expr).field on composite-typed expressions.
 * SQLite has no equivalent composite type machinery.
 *
 * Strategy:
 *   1. CREATE TYPE name AS (col1 type1, ...) → register in __composite_types meta table
 *      and return SELECT 1 (no-op sentinel) since composite type DDL is metadata-only
 *      with no runtime storage effect in SQLite's flat-table model.
 *   2. Row field access (expr).field → json_extract(expr, '$.field')
 *      This preserves the field access semantics by using SQLite's JSON functions
 *      to extract the named field from a JSON representation of the row value.
 *   3. ROW(expr1, expr2, ...) → json_object('f1', expr1, 'f2', expr2, ...)
 *      Transforms PG ROW constructor into JSON object construction.
 *   4. All other SQL passes through unchanged.
 *
 * Detection uses regex; rewriting uses regex + balanced-paren boundary
 * finding for robust handling of type argument parentheses in attribute
 * definitions (e.g., DECIMAL(10,2)).
 *
 * Note: CREATE TYPE ... AS ENUM is handled by EnumShim.
 *       CREATE TYPE ... AS RANGE is handled by RangeTypeShim.
 *
 * @module CompositeTypeShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('CompositeTypeShim');

// ── Types ────────────────────────────────────────────────────────

export interface CompositeResult {
  /** Rewritten SQL (original if no rewrite was applied) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * Detects CREATE TYPE name AS ( ... ) — composite type DDL.
 *
 * Deliberately excludes:
 *   - CREATE TYPE ... AS ENUM   → handled by EnumShim
 *   - CREATE TYPE ... AS RANGE  → not a PG standard composite type
 *
 * Groups:
 *   1 – Composite type name (identifier)
 */
const CREATE_COMPOSITE_TYPE_RE =
  /^\s*CREATE\s+TYPE\s+([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/i;

// ── In-memory composite type registry ────────────────────────────

interface CompositeTypeAttr {
  name: string;
  type: string;
}

interface CompositeTypeDef {
  name: string;
  attributes: CompositeTypeAttr[];
}

const compositeTypes = new Map<string, CompositeTypeDef>();

/**
 * Get all registered composite type names.
 */
export function getRegisteredTypes(): string[] {
  return Array.from(compositeTypes.keys());
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL contains a CREATE TYPE AS (...) composite
 * type definition.
 *
 * Does NOT match AS ENUM or AS RANGE variants.
 *
 * @param sql - The SQL statement to check.
 * @returns `true` if a composite type CREATE statement is found.
 */
export function detectCompositeType(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  const trimmed = sql.trim();

  // A composite type DDL must start with a real `CREATE TYPE` token (outside
  // any string/comment) followed by a name and `AS (`.
  if (!CREATE_COMPOSITE_TYPE_RE.test(trimmed)) {
    return false;
  }

  // Exclude ENUM variant — handled by EnumShim. We check the token following
  // `AS` should be `(` (CREATE_COMPOSITE_TYPE_RE already requires `AS\s*\(`),
  // so an `AS ENUM` statement will not have matched above in the first place.
  // Keep the explicit guard for robustness against future regex changes.
  if (/AS\s+ENUM\b/i.test(trimmed)) {
    return false;
  }

  return true;
}

/**
 * Detect whether the given SQL contains row-field access syntax,
 * i.e., a parenthesized expression followed by ".field_name".
 *
 * This is a literal-aware scan: the `(expr).field` pattern is only detected
 * outside string literals, quoted identifiers, and comments.
 *
 * @param sql - The SQL text to check.
 * @returns `true` if row-field access is detected.
 */
export function detectRowFieldAccess(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  const trimmed = sql.trim();
  return findRowFieldAccess(trimmed) !== null;
}

/**
 * Detect whether the given SQL contains a ROW(...) constructor.
 *
 * This is a literal-aware scan: `ROW(...)` is only detected outside string
 * literals, quoted identifiers, and comments.
 *
 * @param sql - The SQL text to check.
 * @returns `true` if a ROW constructor is detected.
 */
export function detectRowConstructor(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  const trimmed = sql.trim();
  return findRowConstructor(trimmed) !== null;
}

/**
 * Rewrite PostgreSQL composite type syntax elements for SQLite compatibility.
 *
 * Processing rules:
 *   1. CREATE TYPE name AS (col1 type1, ...)  → "SELECT 1" (no-op),
 *      registers type attributes in memory for reference.
 *   2. (expr).field  →  json_extract(expr, '$.field')
 *      Uses SQLite's json_extract to properly dereference the field.
 *   3. ROW(expr1, expr2)  →  json_object('f1', expr1, 'f2', expr2)
 *      Converts ROW constructor to JSON object construction.
 *   4. Everything else → pass-through unchanged.
 *
 * The rewrites apply globally (g flag), so multiple occurrences in
 * a single statement are all transformed.
 *
 * @param sql - The SQL statement to rewrite.
 * @returns A CompositeResult with the rewritten SQL, or the original
 *          if no composite-type syntax was found.
 */
export function rewriteCompositeType(sql: string): CompositeResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();
  let result = trimmed;
  let rewritten = false;

  // ── Phase 1: CREATE TYPE name AS (...) → SELECT 1 ───────────

  const typeMatch = trimmed.match(CREATE_COMPOSITE_TYPE_RE);
  if (typeMatch && typeMatch.index !== undefined) {
    const typeName = typeMatch[1];

    // Find the opening parenthesis position
    const asParenIdx = trimmed.indexOf('(', typeMatch.index + typeMatch[0].length - 1);
    if (asParenIdx !== -1) {
      // Find matching close paren using literal-aware balanced-paren tracking
      const closeParenIdx = findMatchingCloseParen(trimmed, asParenIdx);
      if (closeParenIdx !== -1) {
        // Extract and register attributes if possible
        const attrContent = trimmed.slice(asParenIdx + 1, closeParenIdx).trim();
        const attrs = parseAttributes(attrContent);
        if (attrs.length > 0) {
          compositeTypes.set(typeName.toLowerCase(), { name: typeName, attributes: attrs });
          logger.debug({ typeName, attributes: attrs }, 'Registered composite type');
        }

        logger.debug({ typeName }, 'Suppressing CREATE TYPE AS composite statement');
        result = createNoOpResult(trimmed, asParenIdx, closeParenIdx);
        rewritten = true;
      }
    }
  }

  // ── Phase 2: (expr).field → json_extract(expr, '$.field') (literal-aware) ──

  {
    const occurrences = findAllRowFieldAccess(result);
    if (occurrences.length > 0) {
      // Replace right-to-left so earlier indices stay valid.
      const parts: string[] = [];
      let cursor = 0;
      for (const occ of occurrences) {
        parts.push(result.slice(cursor, occ.start));
        parts.push(
          `json_extract(${occ.innerExpr.trim()}, '$.${occ.field}')`,
        );
        cursor = occ.end;
      }
      parts.push(result.slice(cursor));
      result = parts.join('');
      rewritten = true;
    }
  }

  // ── Phase 3: ROW(expr1, ...) → json_object('f1', expr1, ...) (literal-aware) ──

  {
    const occurrences = findAllRowConstructors(result);
    if (occurrences.length > 0) {
      const parts: string[] = [];
      let cursor = 0;
      let rowIdx = 1;
      for (const occ of occurrences) {
        parts.push(result.slice(cursor, occ.start));
        const argList = splitTopLevelCommas(occ.args.trim()).map((a: string) => a.trim());
        const kvPairs: string[] = [];
        for (const arg of argList) {
          kvPairs.push(`'f${rowIdx}'`);
          kvPairs.push(arg);
          rowIdx++;
        }
        parts.push(`json_object(${kvPairs.join(', ')})`);
        cursor = occ.end;
      }
      parts.push(result.slice(cursor));
      result = parts.join('');
      rewritten = true;
    }
  }

  return { sql: result, rewritten };
}

// ── Internal Helpers ─────────────────────────────────────────────

interface RowFieldAccessOccurrence {
  start: number;
  end: number;
  innerExpr: string;
  field: string;
}

interface RowConstructorOccurrence {
  start: number;
  end: number;
  args: string;
}

/**
 * Find the first `(expr).field` occurrence in `sql` outside any string
 * literal, quoted identifier, or comment. Returns the occurrence (with
 * positions and decoded inner expression/field) or `null`.
 *
 * The expression may itself contain balanced nested parentheses, which are
 * handled by matching the closing paren that balances the opening `(`.
 */
function findRowFieldAccess(sql: string): RowFieldAccessOccurrence | null {
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    if (c !== '(') continue;

    const close = findMatchingCloseParen(sql, i);
    if (close === -1) continue;

    // The character right after `)` must be a `.` followed by an identifier.
    let j = close + 1;
    if (sql[j] !== '.') continue;

    // Read the field identifier.
    const fieldMatch = sql.slice(j + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!fieldMatch) continue;

    const innerExpr = sql.slice(i + 1, close);
    return {
      start: i,
      end: j + 1 + fieldMatch[0].length,
      innerExpr,
      field: fieldMatch[0],
    };
  }
  return null;
}

/**
 * Find all `(expr).field` occurrences in order (left to right).
 */
function findAllRowFieldAccess(sql: string): RowFieldAccessOccurrence[] {
  const out: RowFieldAccessOccurrence[] = [];
  let idx = 0;
  while (idx < sql.length) {
    const occ = findRowFieldAccess(sql.slice(idx));
    if (!occ) break;
    out.push({
      start: idx + occ.start,
      end: idx + occ.end,
      innerExpr: occ.innerExpr,
      field: occ.field,
    });
    idx += occ.end;
  }
  return out;
}

/**
 * Find the first `ROW(...)` constructor occurrence in `sql` outside any
 * string literal, quoted identifier, or comment, returning its position and
 * decoded argument list. The opening paren is matched with balanced-paren
 * tracking so nested expressions inside the argument list are handled.
 */
function findRowConstructor(sql: string): RowConstructorOccurrence | null {
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }

    // Match the keyword ROW as a whole identifier.
    if (!/[A-Za-z_]/.test(c)) continue;
    if (i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1])) continue;
    if (!sql.startsWith('ROW', i)) continue;

    // The token after ROW must be an opening paren (allowing whitespace).
    let j = i + 3;
    while (j < sql.length && /\s/.test(sql[j])) j++;
    if (sql[j] !== '(') continue;

    const close = findMatchingCloseParen(sql, j);
    if (close === -1) continue;

    const args = sql.slice(j + 1, close);
    return { start: i, end: close + 1, args };
  }
  return null;
}

/**
 * Find all `ROW(...)` constructor occurrences in order (left to right).
 */
function findAllRowConstructors(sql: string): RowConstructorOccurrence[] {
  const out: RowConstructorOccurrence[] = [];
  let idx = 0;
  while (idx < sql.length) {
    const occ = findRowConstructor(sql.slice(idx));
    if (!occ) break;
    out.push({ start: idx + occ.start, end: idx + occ.end, args: occ.args });
    idx += occ.end;
  }
  return out;
}

/**
 * Parse attribute definitions from composite type DDL content.
 *
 * Input: "street TEXT, city TEXT, zip INT"
 * Output: [{name: "street", type: "TEXT"}, {name: "city", type: "TEXT"}, {name: "zip", type: "INT"}]
 *
 * Handles types with arguments like DECIMAL(10,2) and VARCHAR(255).
 */
function parseAttributes(content: string): CompositeTypeAttr[] {
  if (!content || content.trim().length === 0) return [];

  const attrs: CompositeTypeAttr[] = [];
  const items = splitTopLevelCommas(content);

  for (const item of items) {
    const trimmed = item.trim();
    // Match: name type[(args)]
    const match = trimmed.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?(?:\s*\[\])?)\s*/);
    if (match) {
      attrs.push({ name: match[1], type: match[2] });
    }
  }

  return attrs;
}

/**
 * Find the index of the closing parenthesis that matches the opening
 * parenthesis at `openIdx`.  Handles balanced nesting correctly.
 *
 * @param sql      - The full SQL string.
 * @param openIdx  - Index of the opening '(' character.
 * @returns The index of the matching ')' character, or -1 if not found.
 */
export function findMatchingCloseParen(sql: string, openIdx: number): number {
  if (openIdx < 0 || openIdx >= sql.length || sql[openIdx] !== '(') {
    return -1;
  }

  let depth = 0;

  for (let i = openIdx; i < sql.length; i++) {
    const ch = sql[i];

    // Skip string literals, quoted identifiers, and comments so that a
    // `(` or `)` appearing inside them does not affect depth tracking.
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }

    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Generate a no-op result SQL for a CREATE TYPE composite definition.
 *
 * Replaces everything from the opening `(` of the attribute list through
 * the matching closing `)` with `SELECT 1`, preserving any leading content.
 */
export function createNoOpResult(
  sql: string,
  openParenIdx: number,
  closeParenIdx: number,
): string {
  const before = sql.substring(0, openParenIdx).trimEnd();
  const after = sql.substring(closeParenIdx + 1).trim();

  const beforeCleaned = before.replace(/^\s*CREATE\s+TYPE\s+.+$/i, '').trim();
  const afterCleaned = after.replace(/^;.*$/, '').trim();

  if (!beforeCleaned && !afterCleaned) {
    return 'SELECT 1';
  }

  const parts: string[] = [];
  if (beforeCleaned) {
    parts.push(beforeCleaned);
  }
  parts.push('SELECT 1');
  if (afterCleaned) {
    parts.push(afterCleaned);
  }
  return parts.join('; ');
}

/**
 * Split a string by top-level commas (respecting nested parentheses and
 * string literals). A comma inside a string literal, quoted identifier, or
 * comment is NOT treated as a delimiter; only commas at depth 0 outside any
 * literal are used to split.
 */
function splitTopLevelCommas(s: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    // Skip literals/comments whole so their commas don't split.
    const skip = skipSqlLiteral(s, i);
    if (skip !== -1) {
      current += s.slice(i, skip);
      i = skip - 1;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) items.push(current.trim());
  return items;
}
