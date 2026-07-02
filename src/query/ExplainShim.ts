/**
 * ExplainShim — Intercept EXPLAIN / EXPLAIN ANALYZE, rewrite to SQLite's
 * EXPLAIN QUERY PLAN, and return a structured plan tree.
 *
 * SQLite's EXPLAIN QUERY PLAN output has columns:
 *   id, parent, notused, detail
 *
 * The tree hierarchy is encoded in the `id` and `parent` columns:
 *   - parent === 0 → root-level node
 *   - parent === ⟨id⟩ → child of that node
 *
 * The `detail` column contains human-readable plan descriptions such as:
 *   "SCAN t1"
 *   "SEARCH t1 USING INDEX idx_name (name=?)"
 *   "USE TEMP B-TREE FOR ORDER BY"
 *   "LIST SUBQUERY 1"
 *   "CREATE BLOOM FILTER"
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import type Database from 'better-sqlite3';

const logger = PinoLogger.forComponent('ExplainShim');

// ============================================================
//  Types
// ============================================================

export interface ExplainNode {
  id: number;
  parentId: number | null;
  type: string;
  table: string;
  detail: string;
  estRows: number;
  estCost: number;
  children: ExplainNode[];
}

export type PlanFormat = 'text' | 'json' | 'yaml';

export interface SqliteExplainRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

export interface ExplainTiming {
  rows: number;
  time: number; // ms
}

// ============================================================
//  Regular expressions for parsing detail column
// ============================================================

/**
 * Matches "SCAN <table>" or "SCAN <table> USING ..."
 */
const SCAN_RE = /^(SCAN|SEARCH)\s+(\S+?)(?:\s+(.*))?$/i;

/**
 * Matches "USE TEMP B-TREE FOR <reason>" or "USE TEMP B-TABLE FOR <reason>"
 */
const TEMP_BTREE_RE = /^(USE\s+TEMP\s+B-T(?:REE|ABLE))\s+FOR\s+(.+)$/i;

/**
 * Matches "LIST SUBQUERY <n>"
 */
const LIST_SUBQUERY_RE = /^(LIST\s+SUBQUERY)\s+(\d+)$/i;

/**
 * Matches "CO-ROUTINE <n>"
 */
const CO_ROUTINE_RE = /^(CO-ROUTINE)\s+(\d+)$/i;

/**
 * Matches "CREATE BLOOM FILTER" or "BLOOM FILTER ON <table>"
 */
const BLOOM_FILTER_RE = /^((?:CREATE\s+)?BLOOM\s+FILTER(?:\s+ON\s+\S+)?)$/i;

/**
 * Matches "MERGE" or "GROUP BY SORT" etc.
 */
const MISC_RE = /^(MERGE|GROUP\s+BY\s+SORT|CORRELATED\s+SCALAR\s+SUBQUERY)(?:\s+(.*))?$/i;

// ============================================================
//  Detection & Rewriting
// ============================================================

/**
 * Returns true if the SQL starts with EXPLAIN or EXPLAIN ANALYZE.
 */
export function detectExplain(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return trimmed.startsWith('EXPLAIN');
}

/**
 * Rewrites EXPLAIN or EXPLAIN ANALYZE to SQLite's EXPLAIN QUERY PLAN.
 *
 * Examples:
 *   "EXPLAIN SELECT * FROM t"           → "EXPLAIN QUERY PLAN SELECT * FROM t"
 *   "EXPLAIN ANALYZE SELECT * FROM t"   → "EXPLAIN QUERY PLAN SELECT * FROM t"
 *
 * Returns the rewritten SQL and whether a rewrite occurred.
 */
export function rewriteExplain(sql: string): { sql: string; rewritten: boolean; analyze: boolean } {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase().replace(/\s+/g, ' ');

  let analyze = false;
  let innerSql = trimmed;

  if (upper.startsWith('EXPLAIN ANALYZE ')) {
    analyze = true;
    innerSql = trimmed.slice('EXPLAIN ANALYZE '.length).trim();
  } else if (upper.startsWith('EXPLAIN ')) {
    innerSql = trimmed.slice('EXPLAIN '.length).trim();
  } else if (upper === 'EXPLAIN') {
    // Standalone EXPLAIN with no inner SQL — just return passthrough
    return { sql: trimmed, rewritten: false, analyze: false };
  } else {
    // Not an EXPLAIN statement
    return { sql: trimmed, rewritten: false, analyze: false };
  }

  const rewritten = `EXPLAIN QUERY PLAN ${innerSql}`;
  logger.debug({ original: sql, rewritten, analyze }, 'rewriteExplain');
  return { sql: rewritten, rewritten: true, analyze };
}

// ============================================================
//  Parsing
// ============================================================

/**
 * Parse an EXPLAIN QUERY PLAN detail string and extract type + table + descriptive detail.
 * Returns the parsed components for building an ExplainNode.
 */
export function parseDetail(detail: string): { type: string; table: string; detail: string } {
  const trimmed = detail.trim();
  let type = trimmed;
  let table = '';
  let detailStr = '';

  // Try SCAN/SEARCH
  const scanMatch = trimmed.match(SCAN_RE);
  if (scanMatch) {
    type = scanMatch[1].toUpperCase();
    table = scanMatch[2];
    detailStr = scanMatch[3] || '';
    return { type, table, detail: detailStr };
  }

  // Try USE TEMP B-TREE / B-TABLE
  const btreeMatch = trimmed.match(TEMP_BTREE_RE);
  if (btreeMatch) {
    type = btreeMatch[1].toUpperCase();
    table = '';
    detailStr = `FOR ${btreeMatch[2]}`;
    return { type, table, detail: detailStr };
  }

  // Try LIST SUBQUERY
  const subqueryMatch = trimmed.match(LIST_SUBQUERY_RE);
  if (subqueryMatch) {
    type = subqueryMatch[1].toUpperCase();
    table = '';
    detailStr = subqueryMatch[2];
    return { type, table, detail: detailStr };
  }

  // Try CO-ROUTINE
  const coRoutineMatch = trimmed.match(CO_ROUTINE_RE);
  if (coRoutineMatch) {
    type = coRoutineMatch[1].toUpperCase();
    table = '';
    detailStr = coRoutineMatch[2];
    return { type, table, detail: detailStr };
  }

  // Try BLOOM FILTER
  const bloomMatch = trimmed.match(BLOOM_FILTER_RE);
  if (bloomMatch) {
    type = bloomMatch[1].toUpperCase();
    table = '';
    detailStr = '';
    return { type, table, detail: detailStr };
  }

  // Try misc
  const miscMatch = trimmed.match(MISC_RE);
  if (miscMatch) {
    type = miscMatch[1].toUpperCase();
    table = '';
    detailStr = miscMatch[2] || '';
    return { type, table, detail: detailStr };
  }

  // Fallback: use whole string as type
  return { type: trimmed, table: '', detail: '' };
}

/**
 * Parse the raw rows from SQLite's EXPLAIN QUERY PLAN into a structured ExplainNode tree.
 *
 * The `id` and `parent` columns define the tree:
 *   - parent === 0 → root-level node
 *   - parent === node.id → child of that node
 *
 * @param rows - Raw output from better-sqlite3 (array of { id, parent, notused, detail })
 * @returns Array of top-level ExplainNode trees
 */
export function parsePlanTree(rows: SqliteExplainRow[]): ExplainNode[] {
  if (!rows || rows.length === 0) {
    return [];
  }

  // Build a map of id → node (without children yet)
  const nodeMap = new Map<number, ExplainNode>();

  for (const row of rows) {
    const parsed = parseDetail(row.detail);
    const node: ExplainNode = {
      id: row.id,
      parentId: row.parent === 0 ? null : row.parent,
      type: parsed.type,
      table: parsed.table,
      detail: parsed.detail,
      estRows: 0, // SQLite EXPLAIN QUERY PLAN doesn't provide row estimates
      estCost: 0,
      children: [],
    };
    nodeMap.set(row.id, node);
  }

  // Build parent-child relationships
  const roots: ExplainNode[] = [];

  for (const row of rows) {
    const node = nodeMap.get(row.id)!;
    if (row.parent === 0) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(row.parent);
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphan node — treat as root
        roots.push(node);
      }
    }
  }

  return roots;
}

// ============================================================
//  Formatting
// ============================================================

/**
 * Render a single ExplainNode to indented text lines.
 */
function renderNodeText(node: ExplainNode, depth: number): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  const prefix = depth === 0 ? '' : '    ';
  const tablePart = node.table ? ` ${node.table}` : '';
  const detailPart = node.detail ? ` ${node.detail}` : '';
  lines.push(`${indent}${prefix}${node.type}${tablePart}${detailPart}`);

  for (const child of node.children) {
    const childLines = renderNodeText(child, depth + 1);
    lines.push(...childLines);
  }

  return lines;
}

/**
 * Render a single ExplainNode as JSON-indented string.
 */
function renderNodeJson(node: ExplainNode, indent: number): string {
  const pad = '  '.repeat(indent);
  const innerPad = '  '.repeat(indent + 1);
  const lines: string[] = [];
  lines.push(`${pad}{`);
  lines.push(`${innerPad}"id": ${node.id},`);
  lines.push(`${innerPad}"parentId": ${node.parentId === null ? 'null' : node.parentId},`);
  lines.push(`${innerPad}"type": ${JSON.stringify(node.type)},`);
  lines.push(`${innerPad}"table": ${JSON.stringify(node.table)},`);
  lines.push(`${innerPad}"detail": ${JSON.stringify(node.detail)},`);
  lines.push(`${innerPad}"estRows": ${node.estRows},`);
  lines.push(`${innerPad}"estCost": ${node.estCost},`);

  if (node.children.length === 0) {
    lines.push(`${innerPad}"children": []`);
  } else {
    lines.push(`${innerPad}"children": [`);
    for (let i = 0; i < node.children.length; i++) {
      const childJson = renderNodeJson(node.children[i], indent + 2);
      lines.push(childJson + (i < node.children.length - 1 ? ',' : ''));
    }
    lines.push(`${innerPad}]`);
  }

  lines.push(`${pad}}`);
  return lines.join('\n');
}

/**
 * Render a single ExplainNode as YAML-like text.
 */
function renderNodeYaml(node: ExplainNode, depth: number): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  lines.push(`${indent}- id: ${node.id}`);
  lines.push(`${indent}  parentId: ${node.parentId === null ? 'null' : node.parentId}`);
  lines.push(`${indent}  type: ${node.type}`);
  lines.push(`${indent}  table: ${node.table || 'null'}`);
  lines.push(`${indent}  detail: ${node.detail || 'null'}`);
  lines.push(`${indent}  estRows: ${node.estRows}`);
  lines.push(`${indent}  estCost: ${node.estCost}`);

  if (node.children.length > 0) {
    lines.push(`${indent}  children:`);
    for (const child of node.children) {
      const childLines = renderNodeYaml(child, depth + 1);
      lines.push(...childLines);
    }
  } else {
    lines.push(`${indent}  children: []`);
  }

  return lines;
}

/**
 * Format the parsed plan tree into the requested output format.
 *
 * @param explainResults - Array of top-level ExplainNode trees (from parsePlanTree)
 * @param format - Output format: 'text' (default), 'json', or 'yaml'
 * @returns Formatted string
 */
export function formatPlanTree(explainResults: ExplainNode[], format: PlanFormat = 'text'): string {
  if (!explainResults || explainResults.length === 0) {
    return format === 'json' ? '[]' : '';
  }

  switch (format) {
    case 'json': {
      // Wrap in array
      const parts: string[] = [];
      parts.push('[');
      for (let i = 0; i < explainResults.length; i++) {
        parts.push(renderNodeJson(explainResults[i], 1));
        if (i < explainResults.length - 1) {
          parts[parts.length - 1] += ',';
        }
      }
      parts.push(']');
      return parts.join('\n');
    }

    case 'yaml': {
      const lines: string[] = [];
      for (const node of explainResults) {
        const nodeLines = renderNodeYaml(node, 0);
        lines.push(...nodeLines);
      }
      return lines.join('\n');
    }

    case 'text':
    default: {
      const lines: string[] = [];
      for (const node of explainResults) {
        const nodeLines = renderNodeText(node, 0);
        lines.push(...nodeLines);
      }
      return lines.join('\n');
    }
  }
}

// ============================================================
//  ANALYZE
// ============================================================

/**
 * When EXPLAIN ANALYZE is used, append actual row counts and timing
 * information to the formatted plan output.
 *
 * @param sql - The original EXPLAIN ANALYZE SQL statement
 * @param actualTimings - Map of plan node step IDs to their actual execution stats
 * @returns Formatted string with appended ANALYZE information
 */
export function formatAnalyze(
  sql: string,
  actualTimings?: Map<number, ExplainTiming>,
): string {
  if (!actualTimings || actualTimings.size === 0) {
    return '';
  }

  const lines: string[] = ['', '-- EXPLAIN ANALYZE'];

  // Extract the inner query description for context
  const trimmed = sql.trim().toUpperCase().replace(/\s+/g, ' ');
  let context = '';
  if (trimmed.startsWith('EXPLAIN ANALYZE ')) {
    context = trimmed.slice('EXPLAIN ANALYZE '.length);
  } else if (trimmed.startsWith('EXPLAIN ')) {
    context = trimmed.slice('EXPLAIN '.length);
  }
  if (context) {
    lines.push(`-- Query: ${context}`);
  }

  lines.push('-- Actual timing:');
  for (const [stepId, timing] of actualTimings) {
    // Find or describe the step
    const stepDesc = timing.rows !== undefined ? `rows=${timing.rows}` : '';
    const timeDesc = timing.time !== undefined ? `time=${timing.time.toFixed(3)}ms` : '';
    const parts = [stepDesc, timeDesc].filter(Boolean);
    lines.push(`--   Step ${stepId}: ${parts.join(', ')}`);
  }

  lines.push('');

  return lines.join('\n');
}

// ============================================================
//  Convenience: Full pipeline
// ============================================================

export interface ExplainShimResult {
  trees: ExplainNode[];
  text: string;
  json: string;
  yaml: string;
  analyze: boolean;
}

/**
 * Run the full EXPLAIN shim pipeline:
 *   detect → rewrite → execute (via db) → parse → format all
 *
 * @param sql - The original SQL (may start with EXPLAIN or EXPLAIN ANALYZE)
 * @param db   - A better-sqlite3 Database instance
 * @returns    - ExplainShimResult with all formats
 */
export function runExplainShim(sql: string, db: Database.Database): ExplainShimResult {
  const { sql: rewrittenSql, rewritten, analyze } = rewriteExplain(sql);

  if (!rewritten) {
    // Not an EXPLAIN — return empty
    return {
      trees: [],
      text: '',
      json: '[]',
      yaml: '',
      analyze,
    };
  }

  // Execute EXPLAIN QUERY PLAN against SQLite
  let rows: SqliteExplainRow[];
  try {
    rows = db.prepare(rewrittenSql).all() as SqliteExplainRow[];
  } catch (err: any) {
    logger.error({ err, sql: rewrittenSql }, 'EXPLAIN QUERY PLAN execution failed');
    throw err;
  }

  // Parse into tree
  const trees = parsePlanTree(rows);

  // Format all outputs
  const text = formatPlanTree(trees, 'text');
  const json = formatPlanTree(trees, 'json');
  const yaml = formatPlanTree(trees, 'yaml');

  return { trees, text, json, yaml, analyze };
}
