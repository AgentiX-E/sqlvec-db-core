/**
 * ConstraintEvaluator — sandboxed CHECK / domain constraint expression evaluator.
 *
 * PostgreSQL CHECK constraints and DOMAIN constraints are arbitrary boolean SQL
 * expressions over the columns of a row (e.g. `price > 0`,
 * `status IN ('active','idle')`, `a > 0 AND b IS NOT NULL`).  This evaluator
 * parses such an expression and evaluates it against a row (a column-name →
 * value map) without executing any arbitrary code.
 *
 * The evaluation is *pure* and *sandboxed*: it only ever resolves column
 * references against the supplied `row` and applies a fixed set of operators.
 * There is no dynamic code generation, no `eval`, and no filesystem/network
 * access.  SQL three-valued logic (NULL propagation) is honored so that
 * `NULL > 0` is never "true" (it evaluates to NULL, which does not pass a
 * CHECK constraint).
 *
 * @module constraint/ConstraintEvaluator
 */

import { parse } from 'pgsql-ast-parser';
import type {
  Expr,
  ExprBinary,
  ExprCall,
  ExprCase,
  ExprRef,
  ExprTernary,
  ExprUnary,
  SelectFromStatement,
} from 'pgsql-ast-parser';

/** A row is a column-name → value map. */
export type ConstraintRow = Record<string, unknown>;

/**
 * Evaluates a boolean SQL expression against a row.
 *
 * @param expression A SQL boolean expression (e.g. `price > 0`).
 * @param row        Column values referenced by name in the expression.
 * @returns `true` if the expression evaluates to SQL-true, `false` otherwise
 *          (including when it evaluates to NULL — a CHECK constraint that is
 *          NULL is considered satisfied only if the expression opts into it;
 *          a NULL result is treated as *not* satisfied here, matching PG's
 *          CHECK semantics where only TRUE passes).
 */
export class ConstraintEvaluator {
  evaluateCheck(expression: string, row: ConstraintRow): boolean {
    const result = evaluateSqlExpression(expression, row);
    return result === true;
  }
}

/**
 * Evaluate a SQL expression string to a plain JS value / NULL sentinel.
 *
 * Parses `SELECT <expression>` (the parser only accepts full statements) and
 * evaluates the single result column.
 */
function evaluateSqlExpression(expression: string, row: ConstraintRow): unknown {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return true;

  let statements;
  try {
    statements = parse(`SELECT ${trimmed}`);
  } catch {
    // Unparseable expression — treat as not satisfied rather than crash.
    return false;
  }

  // `SELECT <expr>` always yields a single SelectFromStatement.
  const column = (statements[0] as SelectFromStatement).columns?.[0];
  if (!column?.expr) {
    return false;
  }
  return evaluateNode(column.expr, row);
}

// ── AST node evaluators ─────────────────────────────────────────

/** Evaluate a single AST node against the row. */
function evaluateNode(node: Expr, row: ConstraintRow): unknown {
  switch (node.type) {
    // ── Literals (pgsql-ast-parser types: integer/numeric/string/
    //    boolean/null) ──────────────────────────────────────────
    case 'integer':
    case 'numeric':
      return node.value;
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;

    // ── Column / value references ─────────────────────────────
    case 'ref':
      return resolveReference(node, row);

    // ── Lists (IN (...) ) ─────────────────────────────────────
    case 'list':
    case 'array':
      return node.expressions.map((e) => evaluateNode(e, row));

    // ── Unary ─────────────────────────────────────────────────
    case 'unary':
      return evaluateUnary(node, row);

    // ── Binary (comparison / arithmetic / logical / IN) ───────
    case 'binary':
      return evaluateBinary(node, row);

    // ── Ternary (BETWEEN, NOT BETWEEN) ────────────────────────
    case 'ternary':
      return evaluateTernary(node, row);

    // ── Casts — resolve through to the inner value ───────────
    case 'cast':
      return evaluateNode(node.operand, row);

    // ── Function calls — a safe scalar-function subset ───────
    case 'call':
      return evaluateCall(node, row);

    // ── CASE expressions ─────────────────────────────────────
    case 'case':
      return evaluateCase(node, row);

    default:
      // Any remaining node type (subselect, array index, member access,
      // parameter, keyword, overlay, substring, extract, default …) is not
      // part of the supported CHECK-expression surface: refuse to evaluate
      // rather than guess, and treat it as SQL NULL (not satisfied).
      return null;
  }
}

function evaluateTernary(node: ExprTernary, row: ConstraintRow): unknown {
  const v = evaluateNode(node.value, row);
  const lo = evaluateNode(node.lo, row);
  const hi = evaluateNode(node.hi, row);
  const left = sqlCompare(v, lo, '>=');
  const right = sqlCompare(v, hi, '<=');
  if (left === null || right === null) return null;
  return node.op === 'BETWEEN' ? left && right : !(left && right);
}

/**
 * Evaluate a scalar function call against a safe whitelist.  Only pure,
 * deterministic scalar functions are allowed; there is no dynamic dispatch to
 * arbitrary code, so the evaluation remains sandboxed.
 */
function evaluateCall(node: ExprCall, row: ConstraintRow): unknown {
  const name = node.function.name;
  const args = node.args.map((a) => evaluateNode(a, row));

  switch (name.toLowerCase()) {
    case 'length':
    case 'char_length':
    case 'character_length':
      return args[0] === null ? null : String(args[0]).length;

    case 'lower':
      return args[0] === null ? null : String(args[0]).toLowerCase();

    case 'upper':
      return args[0] === null ? null : String(args[0]).toUpperCase();

    case 'trim':
    case 'btrim':
      return args[0] === null ? null : String(args[0]).trim();

    case 'abs':
      return args[0] === null ? null : Math.abs(toNumber(args[0])!);

    case 'coalesce': {
      for (const a of args) {
        if (a !== null) return a;
      }
      return null;
    }

    case 'nullif': {
      if (args.length < 2) return null;
      return sqlEquals(args[0], args[1]) ? null : args[0];
    }

    case 'greatest':
    case 'least': {
      const vals = args.filter((a): a is unknown => a !== null);
      if (vals.length === 0) return null;
      const pickGreatest = name.toLowerCase() === 'greatest';
      let acc: unknown = vals[0];
      for (let i = 1; i < vals.length; i++) {
        const v = vals[i];
        const an = toNumber(acc);
        const bn = toNumber(v);
        if (an !== null && bn !== null) {
          acc = pickGreatest ? (an >= bn ? acc : v) : (an <= bn ? acc : v);
        } else {
          const as = String(acc);
          const bs = String(v);
          acc = pickGreatest ? (as >= bs ? acc : v) : (as <= bs ? acc : v);
        }
      }
      return acc;
    }

    default:
      // Unknown function — refuse to evaluate (defensive).
      return null;
  }
}

/** Evaluate a CASE expression (both searched and simple forms). */
function evaluateCase(node: ExprCase, row: ConstraintRow): unknown {
  // Simple CASE: `CASE value WHEN w1 THEN v1 ... END`
  if (node.value != null) {
    const caseValue = evaluateNode(node.value, row);
    for (const when of node.whens) {
      const whenValue = evaluateNode(when.when, row);
      if (caseValue !== null && whenValue !== null && sqlEquals(caseValue, whenValue)) {
        return evaluateNode(when.value, row);
      }
    }
  } else {
    // Searched CASE: `CASE WHEN cond THEN value ... END`
    for (const when of node.whens) {
      const cond = evaluateNode(when.when, row);
      if (cond === true) {
        return evaluateNode(when.value, row);
      }
    }
  }
  // ELSE clause, or NULL when absent.
  return node.else != null ? evaluateNode(node.else, row) : null;
}

/** Resolve a column reference (including qualified `tbl.col`) against the row. */
function resolveReference(node: ExprRef, row: ConstraintRow): unknown {
  const name = node.name;
  if (name === '*') return null;
  // Strip any table/alias qualifier: `t.price` → `price`.
  const col = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  if (Object.prototype.hasOwnProperty.call(row, col)) {
    return row[col];
  }
  // An unknown column is SQL NULL.
  return null;
}

/** Evaluate a unary operator (NOT, unary minus/plus, IS NULL, IS NOT NULL). */
function evaluateUnary(node: ExprUnary, row: ConstraintRow): unknown {
  const op = node.op;
  const operand = node.operand;

  if (op === 'NOT') {
    const v = evaluateNode(operand, row);
    if (v === null) return null; // NOT NULL → NULL in SQL
    return !v;
  }

  if (op === 'IS NULL') {
    return evaluateNode(operand, row) === null;
  }

  if (op === 'IS NOT NULL') {
    return evaluateNode(operand, row) !== null;
  }

  if (op === 'IS TRUE') {
    return evaluateNode(operand, row) === true;
  }

  if (op === 'IS FALSE') {
    return evaluateNode(operand, row) === false;
  }

  if (op === 'IS NOT TRUE') {
    return evaluateNode(operand, row) !== true;
  }

  if (op === 'IS NOT FALSE') {
    return evaluateNode(operand, row) !== false;
  }

  // Arithmetic unary
  if (op === '-') {
    const n = toNumber(evaluateNode(operand, row));
    return n === null ? null : -n;
  }

  // op === '+' (the only remaining UnaryOperator).
  return toNumber(evaluateNode(operand, row));
}

/** Evaluate a binary operator. */
function evaluateBinary(node: ExprBinary, row: ConstraintRow): unknown {
  const left = evaluateNode(node.left, row);
  const right = evaluateNode(node.right, row);
  const op = node.op;

  switch (op) {
    // ── Logical ───────────────────────────────────────────────
    case 'AND':
      return sqlAnd(left, right);
    case 'OR':
      return sqlOr(left, right);

    // ── Set membership ────────────────────────────────────────
    case 'IN': {
      const list = Array.isArray(right) ? right : [right];
      // NULL not in list, but any NULL either side yields NULL (not false).
      if (left === null) return null;
      let sawNull = false;
      for (const item of list) {
        if (item === null) {
          sawNull = true;
          continue;
        }
        if (sqlEquals(left, item)) return true;
      }
      return sawNull ? null : false;
    }
    case 'NOT IN': {
      const list = Array.isArray(right) ? right : [right];
      if (left === null) return null;
      let sawNull = false;
      for (const item of list) {
        if (item === null) {
          sawNull = true;
          continue;
        }
        if (sqlEquals(left, item)) return false;
      }
      return sawNull ? null : true;
    }

    // ── Comparison ────────────────────────────────────────────
    case '=':
      return sqlEquals(left, right);
    case '!=':
      return sqlNotEquals(left, right);
    case '<':
    case '>':
    case '<=':
    case '>=':
      return sqlCompare(left, right, op);

    // ── Arithmetic ────────────────────────────────────────────
    case '+':
      return arith(left, right, (x, y) => x + y);
    case '-':
      return arith(left, right, (x, y) => x - y);
    case '*':
      return arith(left, right, (x, y) => x * y);
    case '/':
      return arith(left, right, (x, y) => (y === 0 ? null : x / y));
    case '%':
      return arith(left, right, (x, y) => (y === 0 ? null : x % y));

    // ── String concatenation ──────────────────────────────────
    case '||':
      if (left === null || right === null) {
        return null;
      }
      return String(left) + String(right);

    // ── Like / ILike (basic) ──────────────────────────────────
    case 'LIKE':
      return left === null || right === null ? null : sqlLike(String(left), right, false);
    case 'ILIKE':
      return left === null || right === null ? null : sqlLike(String(left), right, true);
    case 'NOT LIKE':
      return left === null || right === null ? null : !sqlLike(String(left), right, false);
    case 'NOT ILIKE':
      return left === null || right === null ? null : !sqlLike(String(left), right, true);

    default:
      // Unknown operator — do not guess.
      return null;
  }
}

// ── SQL three-valued logic helpers ─────────────────────────────

function sqlAnd(a: unknown, b: unknown): unknown {
  // FALSE AND anything → FALSE.
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return Boolean(a) && Boolean(b);
}

function sqlOr(a: unknown, b: unknown): unknown {
  // TRUE OR anything → TRUE.
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return Boolean(a) || Boolean(b);
}

function sqlEquals(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return false;
  return String(a) === String(b);
}

function sqlNotEquals(a: unknown, b: unknown): unknown {
  if (a === null || b === null) return null;
  return String(a) !== String(b);
}

function sqlCompare(a: unknown, b: unknown, op: string): unknown {
  if (a === null || b === null) return null;
  const an = toNumber(a);
  const bn = toNumber(b);
  // Prefer numeric comparison when both sides are numeric; otherwise fall
  // back to lexicographic comparison of their string forms.
  const x = an !== null && bn !== null ? an : String(a);
  const y = an !== null && bn !== null ? bn : String(b);
  return javaScriptCompare(x, y, op);
}

/** Apply a relational operator; `<`/`>`/`<=`/`>=` work for both number and string. */
function javaScriptCompare(a: number | string, b: number | string, op: string): boolean {
  switch (op) {
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    default: return false; // unreachable: op is one of the four above
  }
}

function sqlLike(value: string, pattern: unknown, ignoreCase: boolean): boolean {
  const p = String(pattern);
  const regex = new RegExp(
    '^' +
      p
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
        .replace(/_/g, '.') +
      '$',
    ignoreCase ? 'i' : '',
  );
  return regex.test(value);
}

function arith(
  a: unknown,
  b: unknown,
  op: (x: number, y: number) => number | null,
): unknown {
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an === null || bn === null) return null;
  const result = op(an, bn);
  if (result === null) return null;
  if (Number.isNaN(result)) return null;
  return result;
}

function toNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}
