/**
 * LtreeShim — PostgreSQL ltree extension shim for sqlvec-db.
 *
 * Implements the label-tree data type for hierarchical data.
 *
 * Classes:
 *   - LtreeLabel — single label (alphanumeric + underscore, case-normalized)
 *   - LtreePath  — ordered list of LtreeLabels; comparable & prefix-matchable
 *   - LtreeShim  — static handler methods mirroring PostgreSQL ltree operators
 *
 * Operators (all via LtreeShim static methods):
 *   - compare(a, b)   → -1 | 0 | 1   (depth then lexicographic)
 *   - ancestorOf(a, b)  ↔ a @> b
 *   - descendantOf(a, b) ↔ a <@ b
 *   - match(a, pattern)  ↔ a ~ pattern
 *   - lca(a, b)       → lowest common ancestor
 *   - subltree(p, s, e) → subpath extraction
 *   - nlevel(p)       → label count
 *   - ltree2text(p)   → dotted-string representation
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('LtreeShim');

// ── Constants ──────────────────────────────────────────────────────

const LABEL_RE = /^[a-zA-Z0-9_]+$/;
const LTREE_PATH_RE = /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/;

// ── LtreeLabel ────────────────────────────────────────────────────

/**
 * A single label in an ltree path.
 * Labels must be alphanumeric (plus underscore). Case is preserved but
 * comparison is case-sensitive (matching PostgreSQL ltree behavior).
 */
export class LtreeLabel {
  readonly value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('LtreeLabel: expected non-empty string, got ' + typeof value);
    }
    const trimmed = value.trim();
    if (!LABEL_RE.test(trimmed)) {
      throw new Error(
        'Invalid ltree label: "' +
          trimmed +
          '". Labels must contain only alphanumeric characters and underscores.',
      );
    }
    this.value = trimmed;
  }

  toString(): string {
    return this.value;
  }

  equals(other: LtreeLabel): boolean {
    return this.value === other.value;
  }

  /** Lexicographic comparison of label values. */
  compareTo(other: LtreeLabel): -1 | 0 | 1 {
    if (this.value < other.value) return -1;
    if (this.value > other.value) return 1;
    return 0;
  }
}

// ── LtreePath ─────────────────────────────────────────────────────

/**
 * An ordered list of LtreeLabels representing a hierarchical path
 * (e.g. "Top.Countries.Europe.Germany").
 *
 * Implements Comparable: paths are compared first by depth (number of labels),
 * then lexicographically by label values in order.
 */
export class LtreePath {
  readonly labels: readonly LtreeLabel[];

  constructor(labels: LtreeLabel[] | string) {
    if (typeof labels === 'string') {
      this.labels = LtreePath.parse(labels).labels;
    } else if (Array.isArray(labels)) {
      if (labels.length === 0) {
        throw new Error('LtreePath: path must contain at least one label');
      }
      this.labels = Object.freeze([...labels]);
    } else {
      throw new Error('LtreePath: expected string or LtreeLabel[], got ' + typeof labels);
    }
  }

  /** Number of labels in this path (depth). */
  get depth(): number {
    return this.labels.length;
  }

  /** Parse a dotted-string representation into an LtreePath. */
  static parse(input: string): LtreePath {
    if (!input || typeof input !== 'string') {
      throw new Error('Invalid ltree: expected non-empty string, got ' + typeof input);
    }
    if (!LTREE_PATH_RE.test(input)) {
      throw new Error(
        'Invalid ltree path: "' +
          input +
          '". Labels must be alphanumeric, separated by dots.',
      );
    }
    const labels = input.split('.').map(seg => new LtreeLabel(seg));
    return new LtreePath(labels);
  }

  /** Return the dotted-string representation. */
  toString(): string {
    return this.labels.map(l => l.toString()).join('.');
  }

  /**
   * Compare paths: first by depth (shallower < deeper), then by lexicographic
   * label comparison left-to-right.
   */
  compareTo(other: LtreePath): -1 | 0 | 1 {
    // First by depth
    if (this.depth < other.depth) return -1;
    if (this.depth > other.depth) return 1;

    // Same depth: compare label by label
    for (let i = 0; i < this.depth; i++) {
      const cmp = this.labels[i].compareTo(other.labels[i]);
      if (cmp !== 0) return cmp;
    }
    return 0;
  }

  /**
   * Check if this path is an ancestor of `other` (this @> other).
   * Returns true if this path is a prefix of `other`.
   */
  isAncestorOf(other: LtreePath): boolean {
    if (this.depth > other.depth) return false;
    for (let i = 0; i < this.depth; i++) {
      if (!this.labels[i].equals(other.labels[i])) return false;
    }
    return true;
  }

  /**
   * Check if this path is a descendant of `other` (this <@ other).
   * Returns true if `other` is a prefix of this path.
   */
  isDescendantOf(other: LtreePath): boolean {
    return other.isAncestorOf(this);
  }

  /**
   * Extract a subpath from `start` (inclusive) to `end` (exclusive).
   */
  subltree(start: number, end?: number): LtreePath {
    const slice = this.labels.slice(start, end ?? this.depth);
    if (slice.length === 0) {
      throw new Error('subltree: resulting subpath is empty');
    }
    return new LtreePath([...slice]);
  }

  /**
   * Extract subpath: from `start`, take `count` labels.
   */
  subpath(start: number, count: number): LtreePath {
    const slice = this.labels.slice(start, start + count);
    if (slice.length === 0) {
      throw new Error('subpath: resulting subpath is empty');
    }
    return new LtreePath([...slice]);
  }

  /** Check equality. */
  equals(other: LtreePath): boolean {
    return this.compareTo(other) === 0;
  }
}

// ── LtreeShim — Static Handler ────────────────────────────────────

export class LtreeShim {
  private static logger = PinoLogger.forComponent('LtreeShim');

  // ── Construction ──────────────────────────────────────────────

  /**
   * Create an LtreePath from a dotted-string representation.
   */
  static ltree(input: string): LtreePath {
    return LtreePath.parse(input);
  }

  // ── I/O ───────────────────────────────────────────────────────

  /**
   * Convert an LtreePath to its dotted-string text representation.
   */
  static ltree2text(path: LtreePath): string {
    return path.toString();
  }

  /**
   * Parse an input string (same as ltree()). Equivalent to ltree_in(cstring).
   */
  static ltree_in(cstring: string): LtreePath {
    return LtreePath.parse(cstring);
  }

  // ── Comparison Operators ──────────────────────────────────────

  /**
   * Compare two LtreePaths.
   * Returns -1 if a < b, 0 if a == b, 1 if a > b.
   * Comparison is by path depth first, then lexicographically by label.
   */
  static compare(a: LtreePath, b: LtreePath): -1 | 0 | 1 {
    return a.compareTo(b);
  }

  /** a < b */
  static lt(a: LtreePath, b: LtreePath): boolean {
    return a.compareTo(b) < 0;
  }

  /** a <= b */
  static lte(a: LtreePath, b: LtreePath): boolean {
    return a.compareTo(b) <= 0;
  }

  /** a > b */
  static gt(a: LtreePath, b: LtreePath): boolean {
    return a.compareTo(b) > 0;
  }

  /** a >= b */
  static gte(a: LtreePath, b: LtreePath): boolean {
    return a.compareTo(b) >= 0;
  }

  /** a == b */
  static eq(a: LtreePath, b: LtreePath): boolean {
    return a.compareTo(b) === 0;
  }

  // ── Ancestor / Descendant ─────────────────────────────────────

  /**
   * Check if `ancestor` is an ancestor of `descendant`.
   * Equivalent to PostgreSQL's @> operator: ancestor @> descendant.
   */
  static ancestorOf(ancestor: LtreePath, descendant: LtreePath): boolean {
    return ancestor.isAncestorOf(descendant);
  }

  /**
   * Check if `descendant` is a descendant of `ancestor`.
   * Equivalent to PostgreSQL's <@ operator: descendant <@ ancestor.
   */
  static descendantOf(descendant: LtreePath, ancestor: LtreePath): boolean {
    return descendant.isDescendantOf(ancestor);
  }

  // ── Matching ──────────────────────────────────────────────────

  /**
   * Check if a path matches an lquery pattern (~ operator).
   * Supports:
   *   - `*`  — matches any single label at that position
   *   - `%`  — matches any depth (zero or more labels)
   *   - exact label match
   */
  static match(path: LtreePath, pattern: string): boolean {
    const parts = pattern.split('.');

    // Handle any-depth wildcard
    const hasAnyDepth = parts.includes('%');
    if (hasAnyDepth) {
      const fixedLabels = parts.filter(p => p !== '*' && p !== '%');
      if (fixedLabels.length === 0) return true;

      let pi = 0;
      for (const label of path.labels) {
        if (pi < fixedLabels.length && label.value === fixedLabels[pi]) {
          pi++;
        }
      }
      return pi === fixedLabels.length;
    }

    // Exact length matching (with single-label wildcards)
    if (parts.length !== path.depth) return false;

    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '*') continue;
      if (path.labels[i].value !== parts[i]) return false;
    }
    return true;
  }

  // ── LCA (Lowest Common Ancestor) ──────────────────────────────

  /**
   * Find the lowest common ancestor of two ltree paths.
   * Returns the longest common prefix path.
   * Mirrors PostgreSQL's lca(a, b).
   */
  static lca(a: LtreePath, b: LtreePath): LtreePath {
    const minDepth = Math.min(a.depth, b.depth);
    const common: LtreeLabel[] = [];
    for (let i = 0; i < minDepth; i++) {
      if (a.labels[i].equals(b.labels[i])) {
        common.push(a.labels[i]);
      } else {
        break;
      }
    }
    if (common.length === 0) {
      throw new Error('lca: no common ancestor between "' + a.toString() + '" and "' + b.toString() + '"');
    }
    return new LtreePath(common);
  }

  // ── Subpath Extraction ────────────────────────────────────────

  /**
   * Extract a subpath from start (inclusive) to end (exclusive).
   * Mirrors PostgreSQL's subltree(ltree, start, end).
   */
  static subltree(path: LtreePath, start: number, end?: number): LtreePath {
    return path.subltree(start, end);
  }

  // ── Level ─────────────────────────────────────────────────────

  /**
   * Return the number of labels in the path (depth).
   * Mirrors PostgreSQL's nlevel(ltree).
   */
  static nlevel(path: LtreePath): number {
    return path.depth;
  }

  // ── Other Utilities ───────────────────────────────────────────

  /**
   * Concatenate two ltree paths.
   * Mirrors PostgreSQL's || operator.
   */
  static concat(a: LtreePath, b: LtreePath): LtreePath {
    const combined = [...a.labels, ...b.labels];
    return new LtreePath(combined);
  }

  /**
   * Check if any label in the path matches the given label.
   * Mirrors PostgreSQL's ? operator.
   */
  static anyLabelMatch(path: LtreePath, label: string): boolean {
    const target = new LtreeLabel(label);
    return path.labels.some(l => l.equals(target));
  }

  /**
   * Check if the module is enabled. Always returns true.
   */
  static isModuleEnabled(): boolean {
    return true;
  }

  /**
   * Detect if a SQL statement contains ltree function calls.
   */
  static detectFunctions(sql: string): boolean {
    const LTREE_FUNCS_RE =
      /\b(ltree|ltree2text|ltree_in|nlevel|subltree|subpath|lquery|ltxtquery|lca)\s*\(/i;
    return LTREE_FUNCS_RE.test(sql);
  }

  /**
   * Evaluate a named ltree function with the given arguments.
   */
  static evaluateFunction(fnName: string, args: unknown[]): unknown {
    const name = fnName.toLowerCase();

    switch (name) {
      case 'ltree':
      case 'ltree_in':
        return LtreeShim.ltree(String(args[0]));
      case 'ltree2text':
        return LtreeShim.ltree2text(args[0] as LtreePath);
      case 'nlevel':
        return LtreeShim.nlevel(args[0] as LtreePath);
      case 'subltree':
        return LtreeShim.subltree(
          args[0] as LtreePath,
          Number(args[1]),
          args[2] !== undefined ? Number(args[2]) : undefined,
        );
      case 'subpath':
        return LtreeShim.subltree(
          args[0] as LtreePath,
          Number(args[1]),
          args[2] !== undefined ? Number(args[2]) : undefined,
        );
      case 'lca':
        return LtreeShim.lca(args[0] as LtreePath, args[1] as LtreePath);
      case 'lquery':
        // lquery is pattern-based; we store it as string for match()
        return String(args[0]);
      case 'ltxtquery': {
        const s = String(args[0]);
        const words = s.match(/[a-zA-Z0-9_]+/g) || [];
        return { search: s, labels: words };
      }
      default:
        throw new Error('Unknown ltree function: ' + fnName);
    }
  }
}

// ── Types for backward compatibility ──────────────────────────────

/** Legacy ltree result type that matches the old functional API */
export interface LegacyLtreeResult {
  labels: string[];
  toString(): string;
}

// ── Backward-compatible function exports ──────────────────────────

function toLegacy(path: LtreePath): LegacyLtreeResult {
  const str = path.toString();
  return {
    labels: path.labels.map(l => l.value),
    toString(): string {
      return str;
    },
  };
}

function toLegacyOrError(val: unknown): unknown {
  if (val instanceof LtreePath) {
    return toLegacy(val);
  }
  return val;
}

/** @deprecated Use LtreeShim.ltree() / new LtreePath() instead */
export function ltree(label: string): LegacyLtreeResult {
  return toLegacy(LtreePath.parse(label));
}

/** @deprecated Use LtreeShim.ltree2text() / path.toString() instead */
export function ltree2text(path: LtreePath | LegacyLtreeResult): string {
  if (path instanceof LtreePath) return path.toString();
  return path.toString();
}

/** @deprecated Use LtreeShim.nlevel() / path.depth instead */
export function nlevel(path: LtreePath | LegacyLtreeResult): number {
  if (path instanceof LtreePath) return path.depth;
  return path.labels.length;
}

/** @deprecated Use LtreeShim.subltree() / path.subltree() instead */
export function subltree(path: LtreePath | LegacyLtreeResult, start: number, end?: number): LegacyLtreeResult {
  const p = path instanceof LtreePath ? path : LtreePath.parse(path.labels.join('.'));
  return toLegacy(p.subltree(start, end));
}

/** @deprecated Use LtreeShim.subltree() / path.subltree() instead */
export function subpath(path: LtreePath | LegacyLtreeResult, start: number, count: number): LegacyLtreeResult {
  const p = path instanceof LtreePath ? path : LtreePath.parse(path.labels.join('.'));
  return toLegacy(new LtreePath(p.labels.slice(start, start + count)));
}

/** @deprecated Use LtreeShim.ancestorOf() / path.isAncestorOf() instead */
export function ancestorOf(ancestor: LtreePath | LegacyLtreeResult, descendant: LtreePath | LegacyLtreeResult): boolean {
  const a = ancestor instanceof LtreePath ? ancestor : LtreePath.parse(ancestor.labels.join('.'));
  const d = descendant instanceof LtreePath ? descendant : LtreePath.parse(descendant.labels.join('.'));
  return a.isAncestorOf(d);
}

/** @deprecated Use LtreeShim.descendantOf() / path.isDescendantOf() instead */
export function descendantOf(descendant: LtreePath | LegacyLtreeResult, ancestor: LtreePath | LegacyLtreeResult): boolean {
  const d = descendant instanceof LtreePath ? descendant : LtreePath.parse(descendant.labels.join('.'));
  const a = ancestor instanceof LtreePath ? ancestor : LtreePath.parse(ancestor.labels.join('.'));
  return d.isDescendantOf(a);
}

/** @deprecated Use LtreeShim.concat() instead */
export function concat(a: LtreePath | LegacyLtreeResult, b: LtreePath | LegacyLtreeResult): LegacyLtreeResult {
  const p1 = a instanceof LtreePath ? a : LtreePath.parse(a.labels.join('.'));
  const p2 = b instanceof LtreePath ? b : LtreePath.parse(b.labels.join('.'));
  return toLegacy(new LtreePath([...p1.labels, ...p2.labels]));
}

/** @deprecated Use LtreeShim.match() instead */
export function ltreeMatch(path: LtreePath | LegacyLtreeResult, pattern: string | { pattern: string }): boolean {
  const p = path instanceof LtreePath ? path : LtreePath.parse(path.labels.join('.'));
  const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
  return LtreeShim.match(p, pat);
}

/** @deprecated Use LtreeShim.anyLabelMatch() instead */
export function anyLabelMatch(path: LtreePath | LegacyLtreeResult, label: string): boolean {
  const p = path instanceof LtreePath ? path : LtreePath.parse(path.labels.join('.'));
  return LtreeShim.anyLabelMatch(p, label);
}

/** @deprecated Use LtreeShim.anyLabelMatch() instead */
export function textSearch(path: LtreePath | LegacyLtreeResult, search: { labels: string[] }): boolean {
  const p = path instanceof LtreePath ? path : LtreePath.parse(path.labels.join('.'));
  return search.labels.every(l => p.labels.some(pl => pl.value === l));
}

/** @deprecated Use LtreeShim.match() for pattern matching */
export function lquery(pattern: string): { pattern: string } {
  return { pattern: pattern };
}

/** @deprecated For backward compatibility */
export function ltxtquery(textSearch: string): { search: string; labels: string[] } {
  if (!textSearch) {
    throw new Error('ltxtquery: empty text search query');
  }
  const words = textSearch.match(/[a-zA-Z0-9_]+/g) || [];
  return { search: textSearch, labels: words };
}

/** @deprecated Use LtreeShim.isModuleEnabled() instead */
export function isLtreeModuleEnabled(): boolean {
  return true;
}

/** @deprecated Use LtreeShim.detectFunctions() instead */
export function detectLtreeFunctions(sql: string): boolean {
  return LtreeShim.detectFunctions(sql);
}

/** @deprecated Use LtreeShim.evaluateFunction() instead */
export function evaluateLtreeFunction(fnName: string, args: unknown[]): unknown {
  const name = fnName.toLowerCase();
  switch (name) {
    case 'ltree':
    case 'ltree_in':
      return toLegacy(LtreePath.parse(String(args[0])));
    case 'ltree2text':
      return ltree2text(args[0] as LtreePath | LegacyLtreeResult);
    case 'nlevel':
      return nlevel(args[0] as LtreePath | LegacyLtreeResult);
    case 'subltree':
      return subltree(args[0] as LtreePath | LegacyLtreeResult, Number(args[1]), args[2] !== undefined ? Number(args[2]) : undefined);
    case 'subpath':
      return subpath(args[0] as LtreePath | LegacyLtreeResult, Number(args[1]), Number(args[2]));
    case 'lquery':
      return String(args[0]);
    case 'ltxtquery': {
      const s = String(args[0]);
      if (!s) throw new Error('ltxtquery: empty text search query');
      const words = s.match(/[a-zA-Z0-9_]+/g) || [];
      return { search: s, labels: words };
    }
    default:
      return LtreeShim.evaluateFunction(fnName, args);
  }
}
