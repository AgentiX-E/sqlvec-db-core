import { describe, it, expect } from 'vitest';
import { detectXmlFunc, rewriteXmlFunc } from '../query/XmlShim';

describe('detectXmlFunc', () => {
  it('returns false for empty or non-string input', () => {
    expect(detectXmlFunc('')).toBe(false);
    expect(detectXmlFunc(null as unknown as string)).toBe(false);
    expect(detectXmlFunc(42 as unknown as string)).toBe(false);
  });

  it('detects each supported XML function', () => {
    expect(detectXmlFunc('SELECT xmlelement(name foo, bar)')).toBe(true);
    expect(detectXmlFunc('SELECT xmlforest(a, b)')).toBe(true);
    expect(detectXmlFunc('SELECT xmlconcat(x1, x2)')).toBe(true);
    expect(detectXmlFunc('SELECT xmlagg(expr)')).toBe(true);
    expect(detectXmlFunc("SELECT xmlcomment('hello')")).toBe(true);
    expect(detectXmlFunc("SELECT xmlpi(name target, 'str')")).toBe(true);
    expect(detectXmlFunc("SELECT xmlroot(x, version '1.0')")).toBe(true);
    expect(detectXmlFunc('SELECT xmlserialize(document x as text)')).toBe(true);
    expect(detectXmlFunc("SELECT xmlparse(document '<x/>')")).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectXmlFunc('SELECT XMLELEMENT(name foo)')).toBe(true);
    expect(detectXmlFunc('SELECT XmlComment(1)')).toBe(true);
  });

  it('does not match a function name embedded in an identifier', () => {
    expect(detectXmlFunc('SELECT my_xmlelement(1)')).toBe(false);
    expect(detectXmlFunc('SELECT xmllement_x(1)')).toBe(false);
  });

  it('returns false for plain SQL', () => {
    expect(detectXmlFunc('SELECT 1')).toBe(false);
    expect(detectXmlFunc('SELECT x FROM t')).toBe(false);
  });
});

describe('rewriteXmlFunc', () => {
  it('returns unchanged for empty or non-string input', () => {
    expect(rewriteXmlFunc('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteXmlFunc(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns unchanged when no XML function is present', () => {
    expect(rewriteXmlFunc('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites a simple xmlcomment call', () => {
    expect(rewriteXmlFunc("SELECT xmlcomment('hello') FROM t")).toEqual({
      sql: "SELECT '<xml/>' FROM t",
      rewritten: true,
    });
  });

  it('rewrites xmlelement with attributes', () => {
    expect(rewriteXmlFunc('SELECT xmlelement(name foo, bar)')).toEqual({
      sql: "SELECT '<xml/>'",
      rewritten: true,
    });
  });

  it('rewrites case-insensitively', () => {
    expect(rewriteXmlFunc('SELECT XMLELEMENT(name foo)')).toEqual({
      sql: "SELECT '<xml/>'",
      rewritten: true,
    });
  });

  it('rewrites nested XML function calls to a single replacement', () => {
    const r = rewriteXmlFunc("SELECT xmlconcat(xmlparse('<a/>'), xmlcomment('hi'))");
    expect(r.sql).toBe("SELECT '<xml/>'");
    expect(r.rewritten).toBe(true);
  });

  it('handles a closing parenthesis inside a string literal', () => {
    // The `)` inside the literal must not prematurely close the call.
    expect(rewriteXmlFunc("SELECT xmlparse('a)b')")).toEqual({
      sql: "SELECT '<xml/>'",
      rewritten: true,
    });
  });

  it('handles an opening parenthesis inside a string literal', () => {
    expect(rewriteXmlFunc("SELECT xmlcomment('a(b')")).toEqual({
      sql: "SELECT '<xml/>'",
      rewritten: true,
    });
  });

  it('handles doubled single quotes inside a literal', () => {
    expect(rewriteXmlFunc("SELECT xmlcomment('it''s')")).toEqual({
      sql: "SELECT '<xml/>'",
      rewritten: true,
    });
  });

  it('handles a doubled-quote identifier as an argument', () => {
    expect(rewriteXmlFunc('SELECT xmlserialize(document "x(y)")')).toEqual({
      sql: "SELECT '<xml/>'",
      rewritten: true,
    });
  });

  it('handles a dollar-quoted string argument', () => {
    expect(rewriteXmlFunc("SELECT xmlcomment($$has ( paren$$)")).toEqual({
      sql: "SELECT '<xml/>'",
      rewritten: true,
    });
  });

  it('handles a line comment containing a parenthesis', () => {
    expect(rewriteXmlFunc("SELECT xmlcomment('a') -- )\nFROM t")).toEqual({
      sql: "SELECT '<xml/>' -- )\nFROM t",
      rewritten: true,
    });
  });

  it('handles a block comment containing a parenthesis', () => {
    expect(rewriteXmlFunc("SELECT xmlcomment('a') /* ) */")).toEqual({
      sql: "SELECT '<xml/>' /* ) */",
      rewritten: true,
    });
  });

  it('skips an unmatched parenthesis and leaves SQL unchanged', () => {
    const r = rewriteXmlFunc('SELECT xmlelement(name foo, 1');
    expect(r.sql).toBe('SELECT xmlelement(name foo, 1');
    expect(r.rewritten).toBe(false);
  });

  it('rewrites multiple independent XML function calls', () => {
    const r = rewriteXmlFunc("SELECT xmlcomment('a'), xmlcomment('b')");
    expect(r.sql).toBe("SELECT '<xml/>', '<xml/>'");
    expect(r.rewritten).toBe(true);
  });

  it('keeps non-XML text around the rewritten call intact', () => {
    expect(rewriteXmlFunc("SELECT xmlcomment('a') + 'suffix'")).toEqual({
      sql: "SELECT '<xml/>' + 'suffix'",
      rewritten: true,
    });
  });
});
