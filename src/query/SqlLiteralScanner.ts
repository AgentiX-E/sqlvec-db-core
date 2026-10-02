/**
 * SqlLiteralScanner — Shared literal-aware scanning primitives for SQL rewriters.
 *
 * Bare parenthesis counting and comma splitting are fooled by `)`, `(`, and
 * `,` characters that appear *inside* string literals, quoted identifiers,
 * dollar-quoted strings, or comments. These helpers let a rewriter skip over
 * such constructs so keyword detection and delimiter parsing see only real SQL
 * tokens.
 *
 * Supported constructs:
 *   - single-quoted string `'...'` (with `''` doubled-quote and `\` backslash
 *     escapes, the latter covering PostgreSQL E'' strings)
 *   - double-quoted identifier `"..."` (with `""` doubled-quote escape)
 *   - backtick-quoted identifier `` `...` `` (with ``` `` ``` doubled-backtick
 *     escape)
 *   - dollar-quoted string `$$ ... $$` or `$tag$ ... $tag$`
 *   - line comment `-- ...`
 *   - block comment `/* ... *​/`
 */

/**
 * Skip over a SQL literal, quoted identifier, dollar-quoted string, or comment
 * starting at `pos`, returning the index just past it (or `-1` if the character
 * at `pos` does not begin one of these constructs).
 *
 * @param sql - The SQL text.
 * @param pos - The index to inspect.
 * @returns The index immediately following the construct, `-1` if `pos` does
 *          not start a construct, or `sql.length` for an unterminated construct.
 */
export function skipSqlLiteral(sql: string, pos: number): number {
  const c = sql[pos];
  const len = sql.length;

  // Line comment: `--` to end of line.
  if (c === '-' && sql[pos + 1] === '-') {
    let j = pos + 2;
    while (j < len && sql[j] !== '\n') j++;
    return j;
  }

  // Block comment: `/*` to `*​/`.
  if (c === '/' && sql[pos + 1] === '*') {
    const end = sql.indexOf('*/', pos + 2);
    return end === -1 ? len : end + 2;
  }

  // Single-quoted string.
  if (c === "'") {
    let j = pos + 1;
    while (j < len) {
      if (sql[j] === '\\' && j + 1 < len) {
        j += 2; // E''-style backslash escape consumes the next char too.
        continue;
      }
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") { j += 2; continue; } // doubled '' escape
        return j + 1;
      }
      j++;
    }
    return len; // unterminated string
  }

  // Double-quoted identifier.
  if (c === '"') {
    let j = pos + 1;
    while (j < len) {
      if (sql[j] === '\\' && j + 1 < len) {
        j += 2; // backslash-escaped char (e.g. \" inside a quoted identifier)
        continue;
      }
      if (sql[j] === '"') {
        if (sql[j + 1] === '"') { j += 2; continue; } // doubled "" escape
        return j + 1;
      }
      j++;
    }
    return len; // unterminated identifier
  }

  // Backtick-quoted identifier.
  if (c === '`') {
    let j = pos + 1;
    while (j < len) {
      if (sql[j] === '`') {
        if (sql[j + 1] === '`') { j += 2; continue; } // doubled `` escape
        return j + 1;
      }
      j++;
    }
    return len; // unterminated identifier
  }

  // Dollar-quoted string: $$ ... $$ or $tag$ ... $tag$.
  if (c === '$') {
    const m = sql.slice(pos).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (m) {
      const tag = m[0];
      const close = sql.indexOf(tag, pos + tag.length);
      return close === -1 ? len : close + tag.length;
    }
    return -1; // a bare $ that is not a dollar-quote opener
  }

  return -1;
}

/**
 * Return true if `pos` is inside a string literal, quoted identifier,
 * dollar-quoted string, or comment (i.e. the character there is not real SQL).
 *
 * @param sql - The SQL text.
 * @param pos - The index to inspect.
 */
export function isInsideLiteral(sql: string, pos: number): boolean {
  let i = 0;
  const len = sql.length;
  while (i < pos && i < len) {
    const skip = skipSqlLiteral(sql, i);
    if (skip === -1) {
      i++;
      continue;
    }
    if (pos < skip) return true;
    i = skip;
  }
  return false;
}
