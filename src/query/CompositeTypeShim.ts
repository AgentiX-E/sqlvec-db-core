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

/**
 * Detects row-field access (expr).field pattern.
 *
 * Matches a parenthesized expression immediately followed by a dot and an
 * identifier.  Handles one level of nested parentheses inside the
 * expression (e.g., (func(x)).field).
 *
 * Groups:
 *   1 – Inner expression (the value before .field)
 *   2 – Field name
 *
 * @example
 *   (t).id         → group 1: "t",         group 2: "id"
 *   (func(x)).min  → group 1: "func(x)",   group 2: "min"
 */
const ROW_FIELD_ACCESS_RE = /\(\s*((?:[^()]+|\([^()]*\))+)\s*\)\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Detects ROW(expr1, expr2, ...) constructor calls.
 *
 * Matches ROW() function calls and captures the arguments inside.
 *
 * Groups:
 *   1 – The full argument list
 */
const ROW_CONSTRUCTOR_RE = /\bROW\s*\(([\s\S]*?)\)\s*(?![A-Za-z0-9_])/gi;

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

  if (!CREATE_COMPOSITE_TYPE_RE.test(trimmed)) {
    return false;
  }

  // Exclude ENUM variant — handled by EnumShim
  if (/AS\s+ENUM\b/i.test(trimmed)) {
    return false;
  }

  return true;
}

/**
 * Detect whether the given SQL contains row-field access syntax,
 * i.e., a parenthesized expression followed by ".field_name".
 *
 * @param sql - The SQL text to check.
 * @returns `true` if row-field access is detected.
 */
export function detectRowFieldAccess(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  // Reset global regex state
  ROW_FIELD_ACCESS_RE.lastIndex = 0;

  return ROW_FIELD_ACCESS_RE.test(sql.trim());
}

/**
 * Detect whether the given SQL contains a ROW(...) constructor.
 *
 * @param sql - The SQL text to check.
 * @returns `true` if a ROW constructor is detected.
 */
export function detectRowConstructor(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  ROW_CONSTRUCTOR_RE.lastIndex = 0;
  return ROW_CONSTRUCTOR_RE.test(sql.trim());
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
      // Find matching close paren using balanced-paren tracking
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

  // ── Phase 2: (expr).field → json_extract(expr, '$.field') (globally) ──

  ROW_FIELD_ACCESS_RE.lastIndex = 0;
  const fieldAccessCount = (result.match(ROW_FIELD_ACCESS_RE) || []).length;
  if (fieldAccessCount > 0) {
    ROW_FIELD_ACCESS_RE.lastIndex = 0;
    result = result.replace(ROW_FIELD_ACCESS_RE, (_match, innerExpr, field): string => {
      logger.debug(
        { innerExpr, field },
        'Rewriting field access .%s to json_extract',
        field,
      );
      return `json_extract(${innerExpr.trim()}, '$.${field}')`;
    });
    rewritten = true;
  }

  // ── Phase 3: ROW(expr1, expr2, ...) → json_object('f1', expr1, 'f2', expr2, ...) ──

  ROW_CONSTRUCTOR_RE.lastIndex = 0;
  const rowConstructorCount = (result.match(ROW_CONSTRUCTOR_RE) || []).length;
  if (rowConstructorCount > 0) {
    ROW_CONSTRUCTOR_RE.lastIndex = 0;
    let rowIdx = 1;
    result = result.replace(ROW_CONSTRUCTOR_RE, (_match, args: string): string => {
      const argList = splitTopLevelCommas(args.trim()).map((a: string) => a.trim());
      const kvPairs: string[] = [];
      for (const arg of argList) {
        kvPairs.push(`'f${rowIdx}'`);
        kvPairs.push(arg);
        rowIdx++;
      }
      return `json_object(${kvPairs.join(', ')})`;
    });
    rewritten = true;
  }

  // ── Phase 4: Expand nested json_extract calls (row).field.subfield → chain ──
  // Already handled by Phase 2 for the first level; repeated passes would
  // be needed for (expr).field.subfield syntax which is uncommon.

  return { sql: result, rewritten };
}

// ── Internal Helpers ─────────────────────────────────────────────

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
 * Split a string by top-level commas (respecting nested parentheses).
 */
function splitTopLevelCommas(s: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) items.push(current.trim());
  return items;
}
