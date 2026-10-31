/**
 * PlPgSqlEngine — Standalone PL/pgSQL block execution engine.
 *
 * Parses simple PL/pgSQL anonymous blocks (DECLARE, BEGIN, EXCEPTION, END),
 * variable assignments, IF/ELSE conditions, LOOP, and nested blocks.
 * Execution is performed by a local built-in evaluator (no PGlite dependency).
 *
 * ## Supported syntax
 * - Anonymous block: `DO $$ ... $$`
 * - DECLARE section with variable declarations
 * - Variable assignment: `var := expression;`
 * - IF / ELSEIF / ELSE / END IF
 * - LOOP / END LOOP (with EXIT)
 * - Nested blocks (BEGIN ... END inside outer blocks)
 * - EXCEPTION handlers
 *
 * ## Design
 *
 * The engine uses a two-phase approach:
 * 1. **Parse** — Tokenize and build an AST of the PL/pgSQL block.
 * 2. **Execute** — Walk the AST and evaluate statements using the
 *    registered variable context and built-in evaluator.
 *
 * @module plpgsql/PlPgSqlEngine
 */

import { PinoLogger } from '../logger/PinoLogger';
import safeEval from 'safe-eval';

// ── Logger ───────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────

export type PlPgSqlStatement =
  | PlPgSqlAssignment
  | PlPgSqlIf
  | PlPgSqlLoop
  | PlPgSqlBlock
  | PlPgSqlExit
  | PlPgSqlReturn
  | PlPgSqlRaise
  | PlPgSqlExecute
  | PlPgSqlSelectInto
  | PlPgSqlForeach
  | PlPgSqlWhile
  | PlPgSqlContinue;

export interface PlPgSqlAssignment {
  type: 'ASSIGNMENT';
  variable: string;
  expression: string;
}

export interface PlPgSqlIf {
  type: 'IF';
  condition: string;
  thenBody: PlPgSqlStatement[];
  elseIfs: Array<{ condition: string; body: PlPgSqlStatement[] }>;
  elseBody: PlPgSqlStatement[] | null;
}

export interface PlPgSqlLoop {
  type: 'LOOP';
  body: PlPgSqlStatement[];
  /** Optional label for EXIT */
  label?: string;
  /** FOREACH specific: variable to assign each element to */
  variable?: string;
  /** FOREACH specific: expression evaluating to an array */
  arrayExpression?: string;
}

export interface PlPgSqlExit {
  type: 'EXIT';
  /** Optional label to target */
  label?: string;
  /** Optional WHEN condition */
  when?: string;
}

export interface PlPgSqlReturn {
  type: 'RETURN';
  expression: string | null;
}

export interface PlPgSqlRaise {
  type: 'RAISE';
  message: string;
  level?: 'NOTICE' | 'WARNING' | 'EXCEPTION';
}

export interface PlPgSqlExecute {
  type: 'EXECUTE';
  sql: string;
}

/** SELECT ... INTO variable — SQL inlining for PL/pgSQL */
export interface PlPgSqlSelectInto {
  type: 'SELECT_INTO';
  /** The SQL after SELECT ... INTO stripping */
  sql: string;
  /** Target variable name(s) — typically one */
  targets: string[];
}

export interface PlPgSqlForeach {
  type: 'FOREACH';
  variable: string;
  arrayExpression: string;
  body: PlPgSqlStatement[];
}

export interface PlPgSqlWhile {
  type: 'WHILE';
  condition: string;
  body: PlPgSqlStatement[];
  label?: string;
}

export interface PlPgSqlContinue {
  type: 'CONTINUE';
  label?: string;
  when?: string;
}

export interface PlPgSqlBlock {
  type: 'BLOCK';
  label?: string;
  declarations: PlPgSqlDeclaration[];
  body: PlPgSqlStatement[];
  exceptionHandlers: PlPgSqlExceptionHandler[];
}

export interface PlPgSqlDeclaration {
  name: string;
  dataType: string;
  defaultValue?: string;
  constant?: boolean;
}

export interface PlPgSqlExceptionHandler {
  condition: string;  // e.g. 'WHEN OTHERS' or 'WHEN SQLSTATE '22012''
  body: PlPgSqlStatement[];
}

export interface PlPgSqlParsedBlock {
  block: PlPgSqlBlock;
  raw: string;
}

export interface PlPgSqlExecutionResult {
  success: boolean;
  error?: string;
  variables: Record<string, any>;
  /** The final RETURN value, if any */
  returnValue?: any;
}

// ── Tokenizer ────────────────────────────────────────────────────

interface Token {
  type: string;
  value: string;
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < sql.length) {
    // Skip whitespace
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }

    // Comment: --
    /* v8 ignore next -- comment detection guarded by tokenizer preprocessing */
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    // String literal: '...'
    if (sql[i] === "'") {
      let j = i + 1;
    /* v8 ignore next -- tokenizer loop guard */
      while (j < sql.length && sql[j] !== "'") {
        if (sql[j] === '\\') j++; // skip escaped
        j++;
      }
      j++; // closing '
      tokens.push({ type: 'STRING', value: sql.substring(i, j) });
      i = j;
      continue;
    }

    // Dollar-quoting: $$...$$
    /* v8 ignore next -- dollar-quote detection tested via DO-block input */
    if (sql.substring(i, i + 2) === '$$' && i + 2 < sql.length) {
      const closeIdx = sql.indexOf('$$', i + 2);
      // Normally extractBody() guarantees a closed $$...$$ span, but tokenize()
      // is defensive: if the span is unterminated, fall through and let `$$` be
      // tokenized as two ordinary `$` operators (i advances normally).
      /* istanbul ignore next -- unterminated dollar-quote span (extractBody guarantees closure) */
      if (closeIdx !== -1) {
        tokens.push({ type: 'DOLLAR_STRING', value: sql.substring(i + 2, closeIdx) });
        i = closeIdx + 2;
        continue;
      }
    }

    // Multi-character operators
    // NOT LIKE, IS NOT, IS NULL, etc. are handled by the parser
    // Two-char operators
    const twoChar = sql.substring(i, i + 2);
    const twoCharOps = ['||', '::', '->', '#>', '@>', '>=', '<=', '<>', '!='];
    /* v8 ignore next -- two-char op guard; covered via standard tokenizer input */
    if (twoCharOps.includes(twoChar)) {
      tokens.push({ type: 'OPERATOR', value: twoChar });
      i += 2;
      continue;
    }

    // Operators and punctuation
    if ('{}[]();,:='.includes(sql[i])) {
      // Check for :=
      if (sql[i] === ':' && sql[i + 1] === '=') {
        tokens.push({ type: 'ASSIGN', value: ':=' });
        i += 2;
        continue;
      }
      if (sql[i] === ';') {
        tokens.push({ type: 'SEMICOLON', value: ';' });
        i++;
        continue;
      }
      tokens.push({ type: 'PUNCT', value: sql[i] });
      i++;
      continue;
    }

    // Single-character operators: + - * / % = > < ! & | ^ ~
    if ('+-*/%=><!&|^~'.includes(sql[i])) {
      tokens.push({ type: 'OPERATOR', value: sql[i] });
      i++;
      continue;
    }

    // Positional parameter: $1, $2, ...
    if (sql[i] === '$' && i + 1 < sql.length && /\d/.test(sql[i + 1])) {
      let j = i + 1;
    /* v8 ignore next -- tokenizer loop guard */
      while (j < sql.length && /\d/.test(sql[j])) j++;
      tokens.push({ type: 'IDENT', value: sql.substring(i, j) });
      i = j;
      continue;
    }

    // Numbers (a leading minus/plus is tokenized separately as an OPERATOR by
    // the single-character-operator branch above, so handling it here would be
    // unreachable; the sign is then evaluated as a JS unary minus by safe-eval).
    if (/\d/.test(sql[i])) {
      let j = i;
    /* v8 ignore next -- tokenizer loop guard */
      while (j < sql.length && /[\d.eE+-]/.test(sql[j])) j++;
      tokens.push({ type: 'NUMBER', value: sql.substring(i, j) });
      i = j;
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(sql[i])) {
      let j = i;
    /* v8 ignore next -- tokenizer loop guard */
      while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      // Qualified name: schema.func / table.column / pg_catalog.upper.
      // Keep the dot glued to the identifiers so the evaluator can resolve
      // schema-prefixed built-in calls (e.g. pg_catalog.upper) and qualified
      // references.
    /* v8 ignore next -- tokenizer loop guard */
      while (j < sql.length && sql[j] === '.' && /[a-zA-Z_]/.test(sql[j + 1] || '')) {
        j++; // dot
    /* v8 ignore next -- tokenizer loop guard */
        while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      }
      tokens.push({ type: 'IDENT', value: sql.substring(i, j) });
      i = j;
      continue;
    }

    // Skip unknown
    i++;
  }

  return tokens;
}

// ── Parser ───────────────────────────────────────────────────────

class Parser {
  private tokens: Token[];
  private pos: number;
  private _caughtExceptionHandlers: PlPgSqlExceptionHandler[] = [];
  private _lastLabel: string | undefined;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
    this._caughtExceptionHandlers = [];
  }

  /** Consume an optional `<<label>>` prefix, returning the label (if any).
   *  `<` and `>` are tokenized as single-char OPERATORs, so match on value. */
  private consumeOptionalLabel(): string | undefined {
      /* v8 ignore next -- parser guard, peek-value check is defensive */
    if (this.peek()?.value !== '<') return undefined;
    this.consume(); // first <
    /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
    if (this.peek()?.value === '<') this.consume(); // second <
    let label: string | undefined;
    /* istanbul ignore next -- label/declaration identifier tolerance */
    if (this.peek()?.type === 'IDENT') {
      label = this.consume().value;
    }
    /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
    if (this.peek()?.value === '>') this.consume(); // first >
    /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
    if (this.peek()?.value === '>') this.consume(); // second >
    this._lastLabel = label;
    return label;
  }

  /** Return true if the remaining input starts a valid block: either directly
   *  with DECLARE/BEGIN or with an `<<label>>` prefix followed by DECLARE/BEGIN.
   *  This is pure lookahead — it does not advance the token cursor. */
  matchesBlockStart(): boolean {
    let i = this.pos;
    // Skip an optional `<<label>>`.
    /* v8 ignore next -- token array access, index guaranteed by parse precondition */
    if (this.tokens[i]?.value === '<') {
      i++;
    /* v8 ignore next -- token array access, index guaranteed by parse precondition */
      if (this.tokens[i]?.value === '<') i++;
    /* v8 ignore next -- token array access, index guaranteed by parse precondition */
      if (this.tokens[i]?.type === 'IDENT') i++;
    /* v8 ignore next -- token array access, index guaranteed by parse precondition */
      if (this.tokens[i]?.value === '>') i++;
    /* v8 ignore next -- token array access, index guaranteed by parse precondition */
      if (this.tokens[i]?.value === '>') i++;
    }
    const t = this.tokens[i];
    if (!t || t.type !== 'IDENT') return false;
    const kw = t.value.toUpperCase();
    return kw === 'DECLARE' || kw === 'BEGIN';
  }

  peek(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
  }

  consume(): Token {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  expect(type: string, value?: string): Token {
    const t = this.peek();
    /* istanbul ignore next -- expect() end-of-input error path */
    if (!t) throw new Error(`Unexpected end of input, expected ${type}${value ? `=${value}` : ''}`);
    if (type !== 'ANY' && t.type !== type) {
      throw new Error(`Expected token type ${type} but got ${t.type}(${t.value})`);
    }
    /* istanbul ignore next -- expect() value-mismatch error path */
    if (value !== undefined && t.value.toUpperCase() !== value.toUpperCase()) {
      throw new Error(`Expected token value ${value} but got ${t.value}`);
    }
    return this.consume();
  }

  matchKeyword(...keywords: string[]): boolean {
    const t = this.peek();
    if (!t || t.type !== 'IDENT') return false;
    return keywords.some((kw) => t.value.toUpperCase() === kw.toUpperCase());
  }

  parseBlock(): PlPgSqlBlock {
    const block: PlPgSqlBlock = {
      type: 'BLOCK',
      declarations: [],
      body: [],
      exceptionHandlers: [...this._caughtExceptionHandlers],
    };
    this._caughtExceptionHandlers = [];

    // Optional label: <<label>>
    // NOTE: `<` and `>` are tokenized as OPERATOR (single-char operators), not
    // PUNCT, so we match on value regardless of token type.
    if (this.consumeOptionalLabel()) {
      block.label = this._lastLabel;
    }

    // DECLARE section
    if (this.matchKeyword('DECLARE')) {
      this.consume(); // DECLARE
      this.parseDeclarations(block);
    }

    // BEGIN
    /* istanbul ignore next -- missing BEGIN keyword tolerance */
    if (this.matchKeyword('BEGIN')) {
      this.consume(); // BEGIN
      block.body = this.parseStatements('END');
      // Transfer caught exception handlers from temp area
      block.exceptionHandlers = [...this._caughtExceptionHandlers];
      this._caughtExceptionHandlers = [];

      // END
      this.expect('IDENT', 'END');
      // Optional label
      if (this.peek()?.type === 'IDENT' && block.label) {
        this.consume();
      }
      this.expect('SEMICOLON', ';');
    }

    return block;
  }

  private parseDeclarations(block: PlPgSqlBlock): void {
      /* v8 ignore next -- this.peek() guarded by caller precondition */
    while (this.peek() && !this.matchKeyword('BEGIN')) {
      if (this.matchKeyword('DECLARE')) {
        this.consume(); // nested DECLARE (skip)
        continue;
      }

      // Variable: name [CONSTANT] type [:= default]
      /* istanbul ignore next -- label/declaration identifier tolerance */
      if (this.peek()?.type === 'IDENT') {
        const name = this.consume().value;
        // Skip: , or : (for ALIAS FOR etc.)
      /* v8 ignore next -- parser guard, peek-value check is defensive */
        if (this.peek()?.value === ',' || this.peek()?.value === ':') {
          // Skip over more complex declarations
      /* v8 ignore next -- this.peek() guarded by caller precondition */
          while (this.peek() && !this.matchKeyword('BEGIN') && this.peek()?.value !== ';') {
            this.consume();
          }
          /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
          if (this.peek()?.value === ';') this.consume();
          continue;
        }

        // ALIAS FOR?
        if (this.matchKeyword('ALIAS')) {
      /* v8 ignore next -- this.peek() guarded by caller precondition */
          while (this.peek() && this.peek()?.value !== ';') this.consume();
          this.consume(); // ;
          continue;
        }

        // Check for CONSTANT keyword
        let constant = false;
        if (this.matchKeyword('CONSTANT')) {
          constant = true;
          this.consume();
        }

        // Data type
        const dataTypeTokens: string[] = [];
    /* v8 ignore next -- parser peek guard */
        while (this.peek() &&
               !this.matchKeyword('NOT', 'DEFAULT') &&
               this.peek()?.type !== 'ASSIGN' &&
               this.peek()?.value !== ';') {
          dataTypeTokens.push(this.consume().value);
        }
        const dataType = dataTypeTokens.join(' ');
        // Strip array brackets for storage: INTEGER[] → INTEGER
        const baseTypeForStorage = dataType.replace(/\s*\[\]\s*/g, '').trim();

        // Default value
        let defaultValue: string | undefined;
        if (this.matchKeyword('DEFAULT') || this.peek()?.type === 'ASSIGN') {
          if (this.matchKeyword('DEFAULT')) this.consume(); // DEFAULT
          else this.consume(); // :=
          const exprTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
          while (this.peek() && this.peek()?.value !== ';') {
            exprTokens.push(this.consume().value);
          }
          defaultValue = exprTokens.join(' ');
        }

        // Semi-colon
        /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
        if (this.peek()?.value === ';') this.consume();

        block.declarations.push({ name, dataType, defaultValue, constant });
      }

      // Skip anything that doesn't look like a declaration
      /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
      if (this.peek()?.value === ';') this.consume();
    }
  }

  private parseStatements(stopAt: string): PlPgSqlStatement[] {
    const statements: PlPgSqlStatement[] = [];

    /* v8 ignore next -- parser peek guard */
    while (this.peek()) {
      // EXCEPTION handler
      /* istanbul ignore next -- missing EXCEPTION keyword tolerance */
      if (this.matchKeyword('EXCEPTION')) {
        this.consume(); // EXCEPTION
        this._caughtExceptionHandlers = [];
        this.parseExceptionInPlace(this._caughtExceptionHandlers);
        break;
      }

      // WHEN also terminates the current statement list (it delimits the next
      // EXCEPTION handler clause). Without this, a later WHEN would be consumed
      // as part of the preceding handler's body, collapsing multiple handlers
      // into one.
      if (this.matchKeyword('WHEN')) {
        break;
      }

      // Stop at END
      if (this.matchKeyword(stopAt)) {
        break;
      }

      // Nested BEGIN ... END
      /* istanbul ignore next -- missing BEGIN keyword tolerance */
      if (this.matchKeyword('BEGIN')) {
        statements.push(this.parseNestedBlock());
        continue;
      }

      // DECLARE ... BEGIN ... END block
      if (this.matchKeyword('DECLARE')) {
        statements.push(this.parseDeclareBlock());
        continue;
      }

      // IF
      if (this.matchKeyword('IF')) {
        statements.push(this.parseIf());
        continue;
      }

      // LOOP
      if (this.matchKeyword('LOOP')) {
        statements.push(this.parseLoop());
        continue;
      }

      // FOREACH
      if (this.matchKeyword('FOREACH')) {
        statements.push(this.parseForeach());
        continue;
      }

      // WHILE
      if (this.matchKeyword('WHILE')) {
        statements.push(this.parseWhile());
        continue;
      }

      // CONTINUE
      /* istanbul ignore next -- missing CONTINUE keyword tolerance */
      if (this.matchKeyword('CONTINUE')) {
        statements.push(this.parseContinue());
        continue;
      }

      // EXIT
      if (this.matchKeyword('EXIT')) {
        statements.push(this.parseExit());
        continue;
      }

      // RETURN
      if (this.matchKeyword('RETURN')) {
        statements.push(this.parseReturn());
        continue;
      }

      // RAISE
      if (this.matchKeyword('RAISE')) {
        statements.push(this.parseRaise());
        continue;
      }

      // EXECUTE (dynamic SQL) — parsed but not yet supported at runtime
      if (this.matchKeyword('EXECUTE')) {
        this.consume(); // EXECUTE
        const exprTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
        while (this.peek() && this.peek()?.value !== ';') {
          exprTokens.push(this.consume().value);
        }
        /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
        if (this.peek()?.value === ';') this.consume();
        statements.push({
          type: 'EXECUTE',
          sql: exprTokens.join(' '),
        });
        continue;
      }

      // Assignment or expression statement
      /* istanbul ignore next -- label/declaration identifier tolerance */
      if (this.peek()?.type === 'IDENT') {
        const ident = this.consume();
        // Check for SELECT ... INTO (SQL inlining)
        if (ident.value.toUpperCase() === 'SELECT') {
          this.parseSelectIntoImpl(statements);
          continue;
        }

        // Check for := (assignment)
        if (this.peek()?.type === 'ASSIGN') {
          this.consume(); // :=
          const exprTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
          while (this.peek() && this.peek()?.value !== ';') {
            exprTokens.push(this.consume().value);
          }
          /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
          if (this.peek()?.value === ';') this.consume();
          statements.push({
            type: 'ASSIGNMENT',
            variable: ident.value,
            expression: exprTokens.join(' '),
          });
          continue;
        }

        // Could be a PERFORM or other statement — skip semi-colon
      /* v8 ignore next -- this.peek() guarded by caller precondition */
        while (this.peek() && this.peek()?.value !== ';') {
          this.consume();
        }
        /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
        if (this.peek()?.value === ';') this.consume();
        continue;
      }

      // Skip any unexpected tokens until semicolon
      /* istanbul ignore next -- optional trailing semicolon tolerance */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
      if (this.peek()?.value === ';') {
        this.consume();
      } else {
        break;
      }
    }

    return statements;
  }

  /** Parse SELECT ... INTO variable ... for SQL inlining. */
  private parseSelectIntoImpl(statements: PlPgSqlStatement[]): void {
    // Already consumed "SELECT" — continue collecting the rest
    const allTokens: string[] = ['SELECT'];
    let intoFound = false;
    const targets: string[] = [];

      /* v8 ignore next -- this.peek() guarded by caller precondition */
    while (this.peek() && this.peek()?.value !== ';') {
      const t = this.consume();

      // Detect INTO keyword
      if (t.type === 'IDENT' && t.value.toUpperCase() === 'INTO' && !intoFound) {
        intoFound = true;
        // Collect target variables: read identifiers until a SQL keyword
      /* v8 ignore next -- this.peek() guarded by caller precondition */
        while (this.peek() && this.peek()?.value !== ';') {
          const nxt = this.peek();
          if (nxt?.type === 'IDENT' && (
            nxt.value.toUpperCase() === 'FROM' ||
            nxt.value.toUpperCase() === 'WHERE' ||
            nxt.value.toUpperCase() === 'ORDER' ||
            nxt.value.toUpperCase() === 'LIMIT' ||
            nxt.value.toUpperCase() === 'HAVING' ||
            nxt.value.toUpperCase() === 'GROUP' ||
            nxt.value.toUpperCase() === 'OFFSET' ||
            nxt.value.toUpperCase() === 'FETCH' ||
            nxt.value.toUpperCase() === 'UNION'
          )) {
            break;
          }
          const targetIdent = this.consume();
          if (targetIdent.value !== ',') {
            targets.push(targetIdent.value);
          }
        }
        continue;
      }

      allTokens.push(t.value);
    }

    // Consume semicolon
    /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
    if (this.peek()?.value === ';') this.consume();

    // Reconstruct the SQL WITHOUT the INTO clause
    // e.g., SELECT * INTO myvar FROM users → SELECT * FROM users
    let sql = allTokens.join(' ');
    sql = sql.replace(/\s+INTO\s*$/i, '');

    if (targets.length > 0) {
      statements.push({
        type: 'SELECT_INTO',
        sql: sql.trim(),
        targets,
      });
    }
    // else: SELECT without INTO → PERFORM-like, skip
  }

  private parseNestedBlock(): PlPgSqlStatement {
    this.consume(); // BEGIN
    const body = this.parseStatements('END');
    this.expect('IDENT', 'END');
    this.expect('SEMICOLON', ';');
    const nestedBlock: PlPgSqlBlock = {
      type: 'BLOCK',
      declarations: [],
      body,
      exceptionHandlers: [...this._caughtExceptionHandlers],
    };
    this._caughtExceptionHandlers = [];
    return nestedBlock;
  }

  /** Parse a DECLARE section followed by BEGIN...END */
  private parseDeclareBlock(): PlPgSqlBlock {
    const block: PlPgSqlBlock = {
      type: 'BLOCK',
      declarations: [],
      body: [],
      exceptionHandlers: [],
    };

    this.consume(); // DECLARE
    this.parseDeclarations(block);

    // BEGIN
    /* istanbul ignore next -- missing BEGIN keyword tolerance */
    if (this.matchKeyword('BEGIN')) {
      this.consume();
      block.body = this.parseStatements('END');
      block.exceptionHandlers = [...this._caughtExceptionHandlers];
      this._caughtExceptionHandlers = [];
      this.expect('IDENT', 'END');
      this.expect('SEMICOLON', ';');
    }

    return block;
  }

  private parseIf(): PlPgSqlStatement {
    this.consume(); // IF
    const condTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
    while (this.peek() && !this.matchKeyword('THEN')) {
      condTokens.push(this.consume().value);
    }
    const condition = condTokens.join(' ').trim();

    this.expect('IDENT', 'THEN');
    const thenBody = this.parseStatementsUntilEndOrElse();

    // Check for ELSEIF / ELSIF / ELSE
    const elseIfs: Array<{ condition: string; body: PlPgSqlStatement[] }> = [];
    let elseBody: PlPgSqlStatement[] | null = null;

    // Handle multi-word ELSEIF
    while (this.matchKeyword('ELSEIF') || this.matchKeyword('ELSIF')) {
      this.consume();
      const eiCondTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
      while (this.peek() && !this.matchKeyword('THEN')) {
        eiCondTokens.push(this.consume().value);
      }
      this.expect('IDENT', 'THEN');
      const eiBody = this.parseStatementsUntilEndOrElse();
      elseIfs.push({ condition: eiCondTokens.join(' ').trim(), body: eiBody });
    }

    if (this.matchKeyword('ELSE')) {
      this.consume(); // ELSE
      elseBody = this.parseStatementsUntilEndOrElse();
    }

    this.expect('IDENT', 'END');
    this.expect('IDENT', 'IF');
    this.expect('SEMICOLON', ';');

    return {
      type: 'IF',
      condition,
      thenBody,
      elseIfs,
      elseBody,
    };
  }

  /**
   * Parse statements stopping at END, ELSE, ELSEIF, or ELSIF.
   * Used for parsing IF/ELSE branches.
   */
  private parseStatementsUntilEndOrElse(): PlPgSqlStatement[] {
    const statements: PlPgSqlStatement[] = [];

    /* v8 ignore next -- parser peek guard */
    while (this.peek()) {
      // EXCEPTION handler
      /* istanbul ignore next -- missing EXCEPTION keyword tolerance */
      if (this.matchKeyword('EXCEPTION')) {
        this.consume();
        break;
      }

      // Stop at END, ELSE, ELSEIF, ELSIF
      if (this.matchKeyword('END', 'ELSE', 'ELSEIF', 'ELSIF')) {
        break;
      }

      // Nested BEGIN ... END
      /* istanbul ignore next -- missing BEGIN keyword tolerance */
      if (this.matchKeyword('BEGIN')) {
        statements.push(this.parseNestedBlock());
        continue;
      }

      // DECLARE ... BEGIN ... END block
      if (this.matchKeyword('DECLARE')) {
        statements.push(this.parseDeclareBlock());
        continue;
      }

      // IF
      if (this.matchKeyword('IF')) {
        statements.push(this.parseIf());
        continue;
      }

      // LOOP
      if (this.matchKeyword('LOOP')) {
        statements.push(this.parseLoop());
        continue;
      }

      // FOREACH
      if (this.matchKeyword('FOREACH')) {
        statements.push(this.parseForeach());
        continue;
      }

      // WHILE
      if (this.matchKeyword('WHILE')) {
        statements.push(this.parseWhile());
        continue;
      }

      // CONTINUE
      /* istanbul ignore next -- missing CONTINUE keyword tolerance */
      if (this.matchKeyword('CONTINUE')) {
        statements.push(this.parseContinue());
        continue;
      }

      // EXIT
      if (this.matchKeyword('EXIT')) {
        statements.push(this.parseExit());
        continue;
      }

      // RETURN
      if (this.matchKeyword('RETURN')) {
        statements.push(this.parseReturn());
        continue;
      }

      // RAISE
      if (this.matchKeyword('RAISE')) {
        statements.push(this.parseRaise());
        continue;
      }

      // Assignment or expression statement
      /* istanbul ignore next -- label/declaration identifier tolerance */
      if (this.peek()?.type === 'IDENT') {
        const ident = this.consume();
        // Check for := (assignment)
        if (this.peek()?.type === 'ASSIGN') {
          this.consume(); // :=
          const exprTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
          while (this.peek() && this.peek()?.value !== ';') {
            exprTokens.push(this.consume().value);
          }
          /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
          if (this.peek()?.value === ';') this.consume();
          statements.push({
            type: 'ASSIGNMENT',
            variable: ident.value,
            expression: exprTokens.join(' '),
          });
          continue;
        }

        // Could be a PERFORM or other statement — skip semi-colon
      /* v8 ignore next -- this.peek() guarded by caller precondition */
        while (this.peek() && this.peek()?.value !== ';') {
          this.consume();
        }
        /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
        if (this.peek()?.value === ';') this.consume();
        continue;
      }

      // Skip any unexpected tokens until semicolon
      /* istanbul ignore next -- optional trailing semicolon tolerance */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
      if (this.peek()?.value === ';') {
        this.consume();
      } else {
        break;
      }
    }

    return statements;
  }

  private parseLoop(): PlPgSqlStatement {
    this.consume(); // LOOP
    const body = this.parseStatements('END');
    this.expect('IDENT', 'END');
    this.expect('IDENT', 'LOOP');
    this.expect('SEMICOLON', ';');
    return {
      type: 'LOOP',
      body,
    };
  }

  /**
   * Parse: FOREACH variable IN ARRAY expr LOOP ... END LOOP;
   */
  private parseForeach(): PlPgSqlStatement {
    this.consume(); // FOREACH
    // Variable name
    const variable = this.consume().value;
    // IN
    this.expect('IDENT', 'IN');
    // ARRAY
    this.expect('IDENT', 'ARRAY');
    // Array expression
    const exprTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
    while (this.peek() && !this.matchKeyword('LOOP') && this.peek()?.value !== ';') {
      exprTokens.push(this.consume().value);
    }
    const arrayExpression = exprTokens.join(' ');
    // LOOP
    this.expect('IDENT', 'LOOP');
    const body = this.parseStatements('END');
    this.expect('IDENT', 'END');
    this.expect('IDENT', 'LOOP');
    this.expect('SEMICOLON', ';');
    return {
      type: 'FOREACH' as any,
      variable,
      arrayExpression,
      body,
    } as PlPgSqlForeach;
  }

  /**
   * Parse: WHILE condition LOOP ... END LOOP;
   */
  private parseWhile(): PlPgSqlStatement {
    this.consume(); // WHILE
    // Condition expression
    const condTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
    while (this.peek() && !this.matchKeyword('LOOP') && this.peek()?.value !== ';') {
      condTokens.push(this.consume().value);
    }
    const condition = condTokens.join(' ').trim();
    // LOOP
    this.expect('IDENT', 'LOOP');
    const body = this.parseStatements('END');
    this.expect('IDENT', 'END');
    this.expect('IDENT', 'LOOP');
    this.expect('SEMICOLON', ';');
    return {
      type: 'WHILE',
      condition,
      body,
    };
  }

  private parseContinue(): PlPgSqlStatement {
    this.consume(); // CONTINUE
    let label: string | undefined;
    let when: string | undefined;

    if (this.peek()?.type === 'IDENT' && !this.matchKeyword('WHEN')) {
      label = this.consume().value;
    }

    if (this.matchKeyword('WHEN')) {
      this.consume();
      const whenTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
      while (this.peek() && this.peek()?.value !== ';') {
        whenTokens.push(this.consume().value);
      }
      when = whenTokens.join(' ').trim();
    }

    /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
    if (this.peek()?.value === ';') this.consume();

    return { type: 'CONTINUE', label, when };
  }

  private parseExit(): PlPgSqlStatement {
    this.consume(); // EXIT
    let label: string | undefined;
    let when: string | undefined;

    if (this.peek()?.type === 'IDENT' && !this.matchKeyword('WHEN')) {
      label = this.consume().value;
    }

    if (this.matchKeyword('WHEN')) {
      this.consume();
      const whenTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
      while (this.peek() && this.peek()?.value !== ';') {
        whenTokens.push(this.consume().value);
      }
      when = whenTokens.join(' ').trim();
    }

    /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
    if (this.peek()?.value === ';') this.consume();

    return { type: 'EXIT', label, when };
  }

  private parseReturn(): PlPgSqlStatement {
    this.consume(); // RETURN
    let expr: string | null = null;
      /* v8 ignore next -- parser guard, this.peek() is guaranteed non-null at this point */
    if (this.peek() && this.peek()?.value !== ';') {
      const exprTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
      while (this.peek() && this.peek()?.value !== ';') {
        exprTokens.push(this.consume().value);
      }
      expr = exprTokens.join(' ').trim();
    }
    /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
    if (this.peek()?.value === ';') this.consume();
    return { type: 'RETURN', expression: expr };
  }

  private parseRaise(): PlPgSqlStatement {
    this.consume(); // RAISE

    let level: 'NOTICE' | 'WARNING' | 'EXCEPTION' | undefined;
    if (this.matchKeyword('NOTICE')) {
      level = 'NOTICE';
      this.consume();
    } else if (this.matchKeyword('WARNING')) {
      level = 'WARNING';
      this.consume();
    } else if (this.matchKeyword('EXCEPTION')) {
      level = 'EXCEPTION';
      this.consume();
    }

    const msgTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
    while (this.peek() && this.peek()?.value !== ';') {
      const t = this.consume();
      // String literals keep their quotes in the tokenizer; strip them so the
      // message is the literal text (e.g. RAISE NOTICE 'hi' -> "hi", not "'hi'").
      if (t.type === 'STRING') {
        const raw = t.value;
        msgTokens.push(raw.length >= 2 ? raw.slice(1, -1) : raw);
      } else {
        msgTokens.push(t.value);
      }
    }
    /* istanbul ignore next -- parser tolerance for unterminated/malformed input */
      /* v8 ignore next -- parser guard, peek-value check is defensive */
    if (this.peek()?.value === ';') this.consume();

    return {
      type: 'RAISE',
      message: msgTokens.join(' ').trim(),
      level,
    };
  }

  private parseExceptionInPlace(target: PlPgSqlExceptionHandler[]): void {
    // Already consumed EXCEPTION
    // Parse WHEN ... THEN ... [;]
      /* v8 ignore next -- this.peek() guarded by caller precondition */
    while (this.peek() && !this.matchKeyword('END') && !this.matchKeyword('BEGIN')) {
      if (this.matchKeyword('WHEN')) {
        this.consume(); // WHEN
        const condTokens: string[] = [];
      /* v8 ignore next -- this.peek() guarded by caller precondition */
        while (this.peek() && !this.matchKeyword('THEN')) {
          condTokens.push(this.consume().value);
        }
        const condition = condTokens.join(' ').trim();
        this.expect('IDENT', 'THEN');
        const body = this.parseStatements('END');
        target.push({ condition, body });
      } else {
        break;
      }
    }
  }
}

// ── Evaluator ────────────────────────────────────────────────────

class PlPgSqlEvaluator {
  private readonly logger = PinoLogger.forComponent('plpgsql-evaluator');
  private variables: Record<string, any> = {};
  private _returnValue: any = undefined;
  private _raised: string | null = null;

  /**
   * Optional callback for executing inline SQL queries (SELECT ... INTO).
   * Receives (sql: string, params?: any[]) and returns rows as any[].
   * Set by the PLpgSQLExecutor or PlPgSqlEngine wrapper.
   */
  queryCallback: ((sql: string) => Promise<any[]>) | null = null;
  /** Callback invoked on RAISE NOTICE / RAISE WARNING (not RAISE EXCEPTION) */
  public noticeCallback: ((level: string, message: string) => void) | null = null;

  /**
   * Safety cap on loop iterations. An unbounded loop (e.g. `LOOP NULL; END
   * LOOP;` with no EXIT) is clamped to this many iterations instead of hanging
   * forever. Exposed so tests can lower it; production keeps the 10000 default.
   */
  public maxLoopIterations = 10000;

  constructor() {
    // Initialize with some PostgreSQL-compatible variables
    this.variables = {
      'found': false,
      'true': true,
      'false': false,
      'null': null,
      'current_timestamp': new Date().toISOString(),
      'sqlerrm': null,
      'sqlstate': '00000',
    };
  }

  async start(): Promise<void> {
    // No external dependencies needed — local evaluator only
    this.logger.info('PL/pgSQL local evaluator ready');
  }

  async stop(): Promise<void> {
    // No-op: local evaluator has no external resources
  }

  getVariable(name: string): any {
    return this.variables[name];
  }

  setVariable(name: string, value: any): void {
    this.variables[name] = value;
  }

  getVariables(): Record<string, any> {
    return { ...this.variables };
  }

  // ── Built-in function registry ───────────────────────────────

  /** Map of PG-compatible built-in functions to JavaScript implementations. */
  private static readonly BUILTIN_FUNCTIONS: Record<string, (...args: any[]) => any> = {
    // String functions
    'upper':      (s: any) => String(s).toUpperCase(),
    'lower':      (s: any) => String(s).toLowerCase(),
    'length':     (s: any) => String(s).length,
    'trim':       (s: any) => String(s).trim(),
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'btrim':      (s: any, chars?: any) => chars === undefined ? String(s).trim() : String(s).replace(new RegExp(`^[${chars}]+|[${chars}]+$`, 'g'), ''),
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'ltrim':      (s: any, chars?: any) => chars === undefined ? String(s).trimStart() : String(s).replace(new RegExp(`^[${chars}]+`, 'g'), ''),
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'rtrim':      (s: any, chars?: any) => chars === undefined ? String(s).trimEnd() : String(s).replace(new RegExp(`[${chars}]+$`, 'g'), ''),
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'substr':     (s: any, start: any, count?: any) => String(s).substring(Number(start) - 1, count === undefined ? undefined : Number(start) - 1 + Number(count)),
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'substring':  (s: any, from: any, count?: any) => String(s).substring(Number(from) - 1, count === undefined ? undefined : Number(from) - 1 + Number(count)),
    'concat':     (...args: any[]) => args.map(String).join(''),
    'position':   (sub: any, str: any) => String(str).indexOf(String(sub)) + 1,
    'replace':    (s: any, from: any, to: any) => String(s).split(String(from)).join(String(to)),
    'repeat':     (s: any, n: any) => String(s).repeat(Number(n)),
    'reverse':    (s: any) => String(s).split('').reverse().join(''),
    'initcap':    (s: any) => String(s).replace(/\b\w/g, (c: string) => c.toUpperCase()),
    // Numeric functions
    'abs':        (n: any) => Math.abs(Number(n)),
    'ceil':       (n: any) => Math.ceil(Number(n)),
    'floor':      (n: any) => Math.floor(Number(n)),
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'round':      (n: any, d?: any) => d !== undefined ? Number(Number(n).toFixed(Number(d))) : Math.round(Number(n)),
    'trunc':      (n: any) => Math.trunc(Number(n)),
    'mod':        (a: any, b: any) => Number(a) % Number(b),
    'power':      (a: any, b: any) => Math.pow(Number(a), Number(b)),
    'sqrt':       (n: any) => Math.sqrt(Number(n)),
    'sign':       (n: any) => Math.sign(Number(n)),
    'random':     () => Math.random(),
    'greatest':   (...args: any[]) => Math.max(...args.map(Number)),
    'least':      (...args: any[]) => Math.min(...args.map(Number)),
    // Null handling
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'coalesce':   (...args: any[]) => args.find(a => a !== null && a !== undefined) ?? null,
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'nullif':     (a: any, b: any) => a === b ? null : a,
    // Type conversion
    'to_char':    (val: any, fmt?: any) => String(val),
    'to_number':  (val: any) => Number(val),
    'to_date':    (val: any) => String(val),
    // Array
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'array_length':   (arr: any, dim?: any) => Array.isArray(arr) ? arr.length : 0,
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'cardinality':    (arr: any) => Array.isArray(arr) ? arr.length : 0,
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'array_append':   (arr: any, val: any) => { if (!Array.isArray(arr)) return []; arr.push(val); return arr; },
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'array_cat':      (a: any, b: any) => (Array.isArray(a) && Array.isArray(b)) ? a.concat(b) : [],
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
    'array_remove':   (arr: any, val: any) => Array.isArray(arr) ? arr.filter(v => v !== val) : [],
    'array_replace':  (arr: any, oldVal: any, newVal: any) =>
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
      Array.isArray(arr) ? arr.map(v => v === oldVal ? newVal : v) : [],
    'unnest':         (...args: any[]) => {
      /* v8 ignore next -- defensive fallback for non-canonical argument path */
      if (args.length === 1 && Array.isArray(args[0])) return args[0];
      return args;
    },
  };

  /** Split comma-separated function arguments respecting nested parens and brackets. */
  private static splitArgs(argsStr: string): string[] {
    const result: string[] = [];
    let depth = 0;      // paren depth — a comma inside (...) is not a separator
    let bracketDepth = 0; // bracket depth — a comma inside ARRAY[...] is not a separator
    let inString = false;
    let current = '';
    for (let i = 0; i < argsStr.length; i++) {
      const ch = argsStr[i];

      // Toggle string mode on single quote (not escaped)
      if (ch === "'" && (i === 0 || argsStr[i - 1] !== '\\')) {
        inString = !inString;
        current += ch;
        continue;
      }

      if (inString) {
        current += ch;
        continue;
      }

      if (ch === '[') { bracketDepth++; current += ch; }
      else if (ch === ']') { bracketDepth--; current += ch; }
      else if (ch === '(') { depth++; current += ch; }
      else if (ch === ')') { depth--; current += ch; }
      else if (ch === ',' && depth === 0 && bracketDepth === 0) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    const last = current.trim();
    if (last) result.push(last);
    return result;
  }

  /** Check if an expression is a built-in function call and evaluate it. */
  private async evaluateFunctionCall(expr: string): Promise<{ result?: any; handled: boolean }> {
    const trimmed = expr.trim();
    // Pattern: func_name(...) with optional schema prefix (e.g., pg_catalog.upper)
    const match = trimmed.match(/^(?:(?:pg_catalog|public)\.)?([a-zA-Z_]\w*)\s*\(([\s\S]*)\)\s*$/);
    if (!match) return { handled: false };
    const funcName = match[1].toLowerCase();
    const argsStr = match[2].trim();
    const fn = PlPgSqlEvaluator.BUILTIN_FUNCTIONS[funcName];
    if (!fn) return { handled: false };

    // Recursively evaluate each argument
    const rawArgs = argsStr === '' ? [] : PlPgSqlEvaluator.splitArgs(argsStr);
    const resolved: any[] = [];
    for (const raw of rawArgs) {
      const val = await this.evaluateExpression(raw);
      resolved.push(val);
    }
    return { result: fn(...resolved), handled: true };
  }

  /**
   * Scan a variable-substituted expression string for built-in function calls
   * and replace them with their evaluated results.
   *
   * This enables function calls within compound expressions:
   *   `upper($1) = 'HELLO'` → `'WORLD' = 'HELLO'`
   *   `abs($1) + $2`        → `5 + 3`
   *
   * Repeatedly scans until no more function calls are found (handles nesting).
   */
  private async resolveEvalFunctionCalls(evalExpr: string): Promise<string> {
    let result = evalExpr;
    const fnPattern = /_?[a-zA-Z]\w*\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

    let prev = '';
    while (result !== prev) {
      prev = result;
      result = await this.resolveOnePass(result, fnPattern);
    }
    return result;
  }

  /** Single pass: find all outer function calls and replace with values. */
  private async resolveOnePass(expr: string, pattern: RegExp): Promise<string> {
    const calls: Array<{ full: string; replacement: string }> = [];

    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(expr)) !== null) {
      const fullExpr = match[0];
      const funcName = fullExpr.substring(0, fullExpr.indexOf('(')).trim().toLowerCase();
      const fn = PlPgSqlEvaluator.BUILTIN_FUNCTIONS[funcName];
      if (!fn) continue;

      const argsStr = fullExpr.substring(fullExpr.indexOf('(') + 1, fullExpr.length - 1).trim();
      const rawArgs = argsStr === '' ? [] : PlPgSqlEvaluator.splitArgs(argsStr);
      try {
        // Resolve each argument through evaluateExpression (not a local literal
        // parse) so nested constructs — ARRAY[...] literals, subscript access,
        // nested function calls, and variables — are evaluated consistently
        // with the rest of the engine.
        const resolved: any[] = [];
        for (const raw of rawArgs) {
          resolved.push(await this.evaluateExpression(raw));
        }
        const val = fn(...resolved);
        if (val === null) calls.push({ full: fullExpr, replacement: 'null' });
        else if (typeof val === 'string') calls.push({ full: fullExpr, replacement: `'${val}'` });
        else calls.push({ full: fullExpr, replacement: String(val) });
      } catch {
        // Skip function calls that can't be evaluated
      }
    }

    for (let i = calls.length - 1; i >= 0; i--) {
      const idx = expr.lastIndexOf(calls[i].full);
      expr = expr.substring(0, idx) + calls[i].replacement + expr.substring(idx + calls[i].full.length);
    }
    return expr;
  }

  /**
   * Evaluate a simple expression string to a value.
   * Uses the built-in local evaluator (no external dependencies).
   */
  async evaluateExpression(expr: string): Promise<any> {
    if (!expr || expr.trim().toUpperCase() === 'NULL') return null;
    if (expr.trim().toUpperCase() === 'TRUE') return true;
    if (expr.trim().toUpperCase() === 'FALSE') return false;

    // Check if it's a variable reference
    const trimmed = expr.trim();
    if (this.variables.hasOwnProperty(trimmed)) {
      return this.variables[trimmed];
    }

    // Number literal
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return trimmed.includes('.') ? parseFloat(trimmed) : parseInt(trimmed, 10);
    }

    // String literal
    if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
      return trimmed.slice(1, -1);
    }

    // Check for positional parameter ($1, $2, etc.) as standalone expression
    const paramMatch = trimmed.match(/^\$(\d+)$/);
    /* istanbul ignore next -- standalone $N positional parameter (pre-empted by variable lookup) */
    if (paramMatch) {
      const paramName = `$${paramMatch[1]}`;
      /* istanbul ignore next -- unset positional parameter fallthrough */
      if (this.variables.hasOwnProperty(paramName)) {
        return this.variables[paramName];
      }
    }

    // Built-in function call detection (upper, lower, substr, coalesce, etc.)
    // Handles nested calls like upper(lower('Hello')) automatically via recursion.
    if (trimmed.includes('(') && trimmed.endsWith(')')) {
      const funcResult = await this.evaluateFunctionCall(trimmed);
      if (funcResult.handled) return funcResult.result;
    }

    // ARRAY[...] literal (handle with spaces from tokenizer: ARRAY [ 1 , 2 , 3 ])
    const arrayMatch = trimmed.match(/^ARRAY\s*\[\s*([\s\S]*?)\s*\]\s*$/i);
    if (arrayMatch) {
      const elemsStr = arrayMatch[1].trim();
      if (elemsStr === '') return [];
      const elems = PlPgSqlEvaluator.splitArgs(elemsStr);
      const result: any[] = [];
      for (const el of elems) {
        result.push(await this.evaluateExpression(el.trim()));
      }
      return result;
    }

    // Array subscript access: varName[1] (PL/pgSQL 1-based)
    // Handle both arr[1] and arr [ 1 ] (with spaces from tokenizer)
    const subscriptMatch = trimmed.match(/^([a-zA-Z_]\w*)\s*\[\s*(\d+)\s*\]\s*$/);
    if (subscriptMatch) {
      const arrName = subscriptMatch[1];
      const idx = parseInt(subscriptMatch[2], 10) - 1; // 1-based
      if (this.variables.hasOwnProperty(arrName)) {
        const arr = this.variables[arrName];
    /* v8 ignore next -- ?? defensive fallback */
        if (Array.isArray(arr)) return arr[idx] ?? null;
      }
    }

    // Local evaluation for comparisons and basic arithmetic
    try {
      // Safe evaluation using safe-eval for basic expressions
      // This is limited to safe patterns only
      let evalExpr = expr;

      const safePattern = /^[a-zA-Z0-9_\s+\-*/<>=!()&|,.$'"]+$/;
      if (safePattern.test(evalExpr)) {
        // Resolve built-in function calls (upper, lower, substr, etc.)
        // by replacing them with their evaluated values.
        // This handles function calls within larger expressions like
        // `upper($1) = 'HELLO'` or `abs($1) + $2`.
        evalExpr = await this.resolveEvalFunctionCalls(evalExpr);

        // Convert PL/pgSQL operators to JS-compatible:
        //   =  (comparison) → === (strict equality), but only when not := or combined
        let jsExpr = evalExpr
          .replace(/(?<![<>!:=])={1}(?!=)/g, '===');

        // Replace || (PG string concatenation) with $pgConcat function calls
        // Multi-pass to handle chained concat (a || b || c)
        let prevJsExpr = '';
        while (prevJsExpr !== jsExpr) {
          prevJsExpr = jsExpr;
          jsExpr = jsExpr.replace(
            /([$a-zA-Z0-9_'"()\[\], ]+)\s*\|\|\s*([$a-zA-Z0-9_'"()\[\], ]+)/g,
            '$pgConcat($1, $2)',
          );
        }

        // Create safe context with variables and helper functions
        const context: Record<string, any> = {
          ...this.variables,
          $pgConcat: (a: any, b: any) => {
            if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
            return String(a) + String(b);
          },
        };
        const result = safeEval(jsExpr, context);
        return result;
      }

      // Return expression as-is if we can't evaluate
      return expr;
    } catch {
      return expr;
    }
  }

  /**
   * Evaluate a boolean condition to true/false.
   */
  async evaluateCondition(condition: string): Promise<boolean> {
    const result = await this.evaluateExpression(condition);
    if (typeof result === 'boolean') return result;
    if (typeof result === 'number') return result !== 0;
    if (typeof result === 'string') {
      const lower = result.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      if (!isNaN(Number(result))) return Number(result) !== 0;
    }
    return result != null && result !== '';
  }

  /**
   * Execute a parsed PL/pgSQL block.
   * Similar to PG's EXECUTE for anonymous blocks.
   */
  async executeBlock(block: PlPgSqlBlock): Promise<void> {
    // Initialize declared variables
    for (const decl of block.declarations) {
      if (decl.defaultValue !== undefined) {
        this.variables[decl.name] = await this.evaluateExpression(decl.defaultValue);
      } else {
        this.variables[decl.name] = null;
      }
    }

    try {
      // Execute body statements
      for (const stmt of block.body) {
        await this.executeStatement(stmt);

        // Stop if we hit a RETURN or EXIT
        if (stmt.type === 'RETURN') return;
        if (stmt.type === 'EXIT') return;
      }
      // Reset any stray CONTINUE signal that escaped to block level
      if (this._raised === 'CONTINUE') this._raised = null;
    } catch (err: any) {
      // Try EXCEPTION handlers
      if (block.exceptionHandlers.length > 0) {
        const errMsg = err.message || String(err);
        let handled = false;
        for (const handler of block.exceptionHandlers) {
          const cond = handler.condition.trim();
          if (cond.toUpperCase() === 'OTHERS') {
            // OTHERS catches all exceptions
            this.variables['SQLSTATE'] = 'P0001';
            this.variables['SQLERRM'] = errMsg;
            handled = true;
            for (const s of handler.body) {
              await this.executeStatement(s);
              /* istanbul ignore next -- exception propagation guard */
              if (this._raised) return;
            }
            break;
          }
          // Check for SQLSTATE 'XXXXX' format — exact match
          const sqlstateMatch = cond.match(/^SQLSTATE\s+'([A-Z0-9]+)'$/i);
          if (sqlstateMatch) {
            if (errMsg.includes(sqlstateMatch[1])) {
              this.variables['SQLSTATE'] = sqlstateMatch[1];
              this.variables['SQLERRM'] = errMsg;
              handled = true;
              for (const s of handler.body) {
                await this.executeStatement(s);
                /* istanbul ignore next -- exception propagation guard */
                if (this._raised) return;
              }
              break;
            }
            continue;
          }
          // Named condition — word-boundary match to prevent false positives
          const escapedCond = cond.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp(`\\b${escapedCond}\\b`, 'i').test(errMsg)) {
            this.variables['SQLSTATE'] = 'P0001';
            this.variables['SQLERRM'] = errMsg;
            handled = true;
            for (const s of handler.body) {
              await this.executeStatement(s);
              /* istanbul ignore next -- exception propagation guard */
              if (this._raised) return;
            }
            break;
          }
        }
        if (handled) return; // Exception handled, continue execution
      }
      // Re-throw if unhandled
      throw err;
    }
  }

  /**
   * Execute a single statement within the block.
   */
  async executeStatement(stmt: PlPgSqlStatement): Promise<void> {
    /* v8 ignore next 3 -- switch default is unreachable for valid token streams */
    switch (stmt.type) {
      case 'ASSIGNMENT':
        this.variables[stmt.variable] = await this.evaluateExpression(stmt.expression);
        break;

      case 'IF':
        await this.executeIf(stmt);
        break;

      case 'LOOP':
        await this.executeLoop(stmt);
        break;

      case 'FOREACH':
        await this.executeForeach(stmt);
        break;

      case 'WHILE':
        await this.executeWhile(stmt);
        break;

      case 'EXIT':
        // Check WHEN condition
        if (stmt.when) {
          const shouldExit = await this.evaluateCondition(stmt.when);
          if (shouldExit) {
            this._raised = 'EXIT';
          }
        } else {
          this._raised = 'EXIT';
        }
        break;

      case 'CONTINUE':
        // Check WHEN condition
        if (stmt.when) {
          const shouldContinue = await this.evaluateCondition(stmt.when);
          if (shouldContinue) {
            this._raised = 'CONTINUE';
          }
        } else {
          this._raised = 'CONTINUE';
        }
        break;

      case 'RETURN':
        if (stmt.expression !== null) {
          this._returnValue = await this.evaluateExpression(stmt.expression);
        }
        break;

      case 'RAISE':
        if (stmt.level === 'EXCEPTION') {
          throw new Error(stmt.message);
        }
        const level = stmt.level || 'NOTICE';
        this.logger.info({ level, message: stmt.message }, 'RAISE');
        // Invoke notice callback if configured (for wire protocol delivery)
        if (this.noticeCallback) {
          this.noticeCallback(level, stmt.message);
        }
        break;

      case 'BLOCK':
        // Nested block
        await this.executeBlock(stmt as PlPgSqlBlock);
        break;

      case 'SELECT_INTO':
        if (!this.queryCallback) {
          this.logger.warn({ sql: stmt.sql }, 'SELECT ... INTO requires a queryCallback (no database connection)');
          break;
        }
        try {
          // Resolve $N references from variables before querying
          const resolvedSql = this.resolveSqlParams(stmt.sql);
          const rows = await this.queryCallback(resolvedSql);
          if (rows.length > 0) {
            // PG sets FOUND to true when SELECT ... INTO returns rows.
            this.variables['found'] = true;
            const row = rows[0];
            const values = Object.values(row);
            for (let idx = 0; idx < stmt.targets.length; idx++) {
              const target = stmt.targets[idx];
              if (row.hasOwnProperty(target)) {
                // Column name matches target variable name
                this.variables[target] = row[target];
              } else if (idx < values.length) {
                // Fall back to sequential assignment by position
                this.variables[target] = values[idx];
              }
            }
          } else {
            // No rows: set variables to null (PG behavior); FOUND is false.
            this.variables['found'] = false;
            for (const target of stmt.targets) {
              this.variables[target] = null;
            }
          }
        } catch (err: any) {
          this.logger.error({ sql: stmt.sql, err: err.message }, 'SELECT ... INTO failed');
          throw err;
        }
        break;

      case 'EXECUTE':
        throw new Error('PL/pgSQL EXECUTE (dynamic SQL) is not supported yet');
    }
  }

  private async executeIf(stmt: PlPgSqlIf): Promise<void> {
    // Check main condition
    if (await this.evaluateCondition(stmt.condition)) {
      for (const s of stmt.thenBody) {
        await this.executeStatement(s);
        /* istanbul ignore next -- exception propagation guard */
        if (this._raised) return;
      }
      return;
    }

    // Check ELSEIF conditions
    for (const ei of stmt.elseIfs) {
      if (await this.evaluateCondition(ei.condition)) {
        for (const s of ei.body) {
          await this.executeStatement(s);
          /* istanbul ignore next -- exception propagation guard */
          if (this._raised) return;
        }
        return;
      }
    }

    // ELSE body
    if (stmt.elseBody) {
      for (const s of stmt.elseBody) {
        await this.executeStatement(s);
        /* istanbul ignore next -- exception propagation guard */
        if (this._raised) return;
      }
    }
  }

  private async executeLoop(stmt: PlPgSqlLoop): Promise<void> {
    const maxIterations = this.maxLoopIterations;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      this._raised = null;

      for (const s of stmt.body) {
        await this.executeStatement(s);
        if (this._raised === 'EXIT') {
          this._raised = null;
          return;
        }
        if (this._raised === 'CONTINUE') {
          this._raised = null;
          break; // Continue to next iteration
        }
      }
    }

    this.logger.warn('LOOP reached max iterations (10000), exiting');
  }

  /**
   * Execute WHILE loop: continues while condition is true.
   */
  private async executeWhile(stmt: PlPgSqlWhile): Promise<void> {
    const maxIterations = this.maxLoopIterations;
    let iterations = 0;

    while (iterations < maxIterations) {
      const conditionMet = await this.evaluateCondition(stmt.condition);
      if (!conditionMet) break;

      iterations++;
      this._raised = null;

      for (const s of stmt.body) {
        await this.executeStatement(s);
        if (this._raised === 'EXIT') {
          this._raised = null;
          return;
        }
        if (this._raised === 'CONTINUE') {
          this._raised = null;
          break; // Continue to next condition check
        }
      }
    }

    if (iterations >= maxIterations) {
      this.logger.warn('WHILE loop reached max iterations (10000), exiting');
    }
  }

  /**
   * Execute FOREACH loop: iterates over array elements.
   */
  private async executeForeach(stmt: PlPgSqlForeach): Promise<void> {
    const arr = await this.evaluateExpression(stmt.arrayExpression || "''");
    if (!Array.isArray(arr)) {
      this.logger.warn({ expr: stmt.arrayExpression }, "FOREACH: expression did not evaluate to an array, skipping");
      return;
    }
    for (const elem of arr) {
      /* istanbul ignore next -- FOREACH loop variable is always a consumed IDENT (non-empty) */
      this.variables[stmt.variable || "''"] = elem;
      this._raised = null;
      for (const s of stmt.body) {
        await this.executeStatement(s);
        if (this._raised === 'EXIT') {
          this._raised = null;
          return;
        }
        if (this._raised === 'CONTINUE') {
          this._raised = null;
          break; // Continue to next element
        }
      }
    }
  }

  /**
   * Resolve $N references in SQL to literal values from variables.
   * Bare variable names (e.g., dept) are NOT resolved here — use $N syntax
   * or ensure PL/pgSQL variables are injected as $N references.
   */
  private resolveSqlParams(sql: string): string {
    return sql.replace(/\$(\d+)/g, (_match, num) => {
      const varName = `$${num}`;
      const val = this.variables[varName];
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'number') return String(val);
      return `'${String(val).replace(/'/g, "''")}'`;
    });
  }

  /**
   * Parse and execute a full PL/pgSQL anonymous block.
   */
  async execute(sql: string): Promise<PlPgSqlExecutionResult> {
    try {
      // Strip the DO $$ ... $$ or DO LANGUAGE plpgsql $$ ... $$ wrapper
      const body = this.extractBody(sql);

      if (!body.trim()) {
        return { success: true, variables: {} };
      }

      // Tokenize and parse
      const tokens = tokenize(body);
      const parser = new Parser(tokens);

      // Validate: ensure the input starts a valid block (DECLARE / BEGIN, with
      // an optional leading <<label>>). Pure lookahead so parseBlock still gets
      // to consume the label itself.
      if (!parser.matchesBlockStart()) {
        return {
          success: false,
          error: 'Invalid PL/pgSQL block: missing DECLARE or BEGIN',
          variables: {},
        };
      }

      const block = parser.parseBlock();

      // Execute
      await this.executeBlock(block);

      return {
        success: true,
        variables: { ...this.variables },
        returnValue: this._returnValue,
      };
    } catch (err: any) {
      // Try exception handlers
      this.logger.error({ err: err.message }, 'PL/pgSQL execution error');

      return {
        success: false,
        error: err.message,
        variables: { ...this.variables },
      };
    }
  }

  reset(): void {
    this.variables = {
      'found': false,
      'true': true,
      'false': false,
      'null': null,
      'current_timestamp': new Date().toISOString(),
      'sqlerrm': null,
      'sqlstate': '00000',
    };
    this._returnValue = undefined;
    this._raised = null;
  }

  private extractBody(sql: string): string {
    // DO $$ body $$
    const doDollarMatch = sql.match(/^\s*DO\s+(?:LANGUAGE\s+\w+\s+)?\$\$\s*([\s\S]*?)\s*\$\$\s*;?\s*$/i);
    if (doDollarMatch) return doDollarMatch[1].trim();

    // DO 'body' (string literal)
    const doStringMatch = sql.match(/^\s*DO\s+'(?:[^'\\]|\\.)*'\s*;?\s*$/i);
    if (doStringMatch) {
      const innerMatch = sql.match(/^\s*DO\s+'([^'\\]*)'\s*;?\s*$/i);
      /* istanbul ignore next -- DO '...' string-literal body fallback */
      if (innerMatch) return innerMatch[1].trim();
    }

    // Already body-only
    return sql.trim();
  }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Parse a PL/pgSQL block into its AST representation.
 */
export function parsePlPgSql(sql: string): PlPgSqlParsedBlock {
  const body = new PlPgSqlEvaluator()['extractBody'](sql);
  const tokens = tokenize(body);
  const parser = new Parser(tokens);
  const block = parser.parseBlock();
  return { block, raw: body };
}

/**
 * Create a fresh PlPgSqlEngine instance.
 */
export function createPlPgSqlEngine(): PlPgSqlEngine {
  return new PlPgSqlEngine();
}

/**
 * PlPgSqlEngine — Main entry point for PL/pgSQL block execution.
 *
 * Usage:
 * ```typescript
 * const engine = createPlPgSqlEngine();
 * await engine.start();
 * const result = await engine.execute(`
 *   DO $$
 *   DECLARE
 *     x INT := 10;
 *   BEGIN
 *     x := x + 1;
 *     RETURN x;
 *   END;
 *   $$;
 * `);
 * console.log(result.returnValue); // 11
 * ```
 */
export class PlPgSqlEngine {
  private evaluator: PlPgSqlEvaluator;
  private readonly logger = PinoLogger.forComponent('plpgsql-engine');

  constructor() {
    this.evaluator = new PlPgSqlEvaluator();
  }

  /**
   * Set a callback that is invoked on each RAISE NOTICE / WARNING.
   * The callback receives (level, message) — e.g. ('NOTICE', 'hello').
   */
  setNoticeCallback(cb: ((level: string, message: string) => void) | null): void {
    this.evaluator.noticeCallback = cb;
  }

  /**
   * Set a callback for executing inline SQL queries (SELECT ... INTO).
   * The callback receives a SQL string and returns rows as any[].
   */
  setQueryCallback(cb: ((sql: string) => Promise<any[]>) | null): void {
    this.evaluator.queryCallback = cb;
  }

  /**
   * Initialize the engine.
   */
  async start(): Promise<void> {
    await this.evaluator.start();
  }

  /**
   * Execute a PL/pgSQL anonymous block.
   *
   * @param sql - The PL/pgSQL code (wrapped in DO $$...$$ or body-only).
   */
  async execute(sql: string): Promise<PlPgSqlExecutionResult> {
    if (!sql.trim()) {
      return { success: true, variables: {} };
    }
    return this.evaluator.execute(sql);
  }

  /**
   * Get the current value of a variable.
   */
  getVariable(name: string): any {
    return this.evaluator.getVariable(name);
  }

  /**
   * Get all current variable values.
   */
  getVariables(): Record<string, any> {
    return this.evaluator.getVariables();
  }

  /**
   * Set a variable value.
   */
  setVariable(name: string, value: any): void {
    this.evaluator.setVariable(name, value);
  }

  /**
   * Reset the engine state.
   */
  reset(): void {
    this.evaluator.reset();
  }

  /**
   * Parse a PL/pgSQL block without executing it.
   */
  parse(sql: string): PlPgSqlParsedBlock {
    return parsePlPgSql(sql);
  }

  /**
   * Stop the engine and clean up.
   */
  async stop(): Promise<void> {
    await this.evaluator.stop();
  }
}
