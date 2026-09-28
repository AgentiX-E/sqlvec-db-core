import { describe, it, expect } from 'vitest';
import {
  xmlparse,
  xmlserialize,
  xpath,
  xmlcomment,
  detectXmlExtendedFunc,
  rewriteXmlExtendedFunc,
  detectXmlFunction,
} from '../query/XmlShimExtended';

describe('xmlparse', () => {
  it('throws on empty or non-string input', () => {
    expect(() => xmlparse('')).toThrow(/non-empty string/);
    expect(() => xmlparse(undefined as unknown as string)).toThrow(/non-empty string/);
    expect(() => xmlparse(42 as unknown as string)).toThrow(/non-empty string/);
  });

  it('throws when input does not start with <', () => {
    expect(() => xmlparse('not xml')).toThrow(/must start with/);
    expect(() => xmlparse('  text')).toThrow(/must start with/);
  });

  it('returns trimmed well-formed XML', () => {
    expect(xmlparse('<root/>')).toBe('<root/>');
    expect(xmlparse('  <root><child>t</child></root>  ')).toBe('<root><child>t</child></root>');
  });

  it('accepts nested different-name tags', () => {
    expect(xmlparse('<a><b><c/></b></a>')).toBe('<a><b><c/></b></a>');
  });

  it('accepts attributes on open tags', () => {
    expect(xmlparse('<root a="1" b="2"><leaf/></root>')).toBe('<root a="1" b="2"><leaf/></root>');
  });

  it('throws on mismatched tags', () => {
    expect(() => xmlparse('<a><b></a></b>')).toThrow(/mismatched tags/);
  });

  it('throws on unexpected close tag', () => {
    expect(() => xmlparse('</a>')).toThrow(/unexpected closing tag/);
  });

  it('throws on unclosed tags', () => {
    expect(() => xmlparse('<a><b>')).toThrow(/unclosed tags/);
  });

  it('skips comments and processing instructions', () => {
    expect(xmlparse('<root><!-- comment --><?pi target?><leaf/></root>')).toBe(
      '<root><!-- comment --><?pi target?><leaf/></root>',
    );
  });

  it('accepts trailing text after the root element', () => {
    // Tag balancing is checked; trailing non-tag text is tolerated.
    expect(xmlparse('<root/>text')).toBe('<root/>text');
  });

  it('accepts a document whose final tag is self-closing then text', () => {
    expect(xmlparse('<a><b/></a> trailing')).toBe('<a><b/></a> trailing');
  });

  it('throws when a bare < has no following >', () => {
    expect(() => xmlparse('<a><')).toThrow(/unclosed tags/);
  });

  it('throws when an inner < has a name but no closing >', () => {
    // `<b` has no `>`; the whole document is therefore unclosed.
    expect(() => xmlparse('<a><b')).toThrow(/unclosed tags/);
  });

  it('ignores tags whose names are not valid XML names', () => {
    // An element name may not start with a digit; such "tags" are not treated
    // as open/close tags by the scanner, leaving the stack empty (no error).
    expect(xmlparse('<123>text</123>')).toBe('<123>text</123>');
  });
});

describe('xmlserialize', () => {
  it('returns empty string for null/undefined', () => {
    expect(xmlserialize(null as unknown as string)).toBe('');
    expect(xmlserialize(undefined as unknown as string)).toBe('');
  });

  it('stringifies non-string values', () => {
    expect(xmlserialize(123 as unknown as string)).toBe('123');
  });

  it('passes through strings', () => {
    expect(xmlserialize('<root/>')).toBe('<root/>');
  });
});

describe('xpath', () => {
  it('returns empty for empty input', () => {
    expect(xpath('', '<root/>')).toBe('');
    expect(xpath('/a', '')).toBe('');
  });

  it('returns empty for complex path expressions', () => {
    expect(xpath('/a[1]/b', '<a><b>v</b></a>')).toBe('');
    expect(xpath('//a', '<a>v</a>')).toBe('');
  });

  it('extracts simple single-step path content', () => {
    expect(xpath('/root', '<root>value</root>')).toBe('value');
  });

  it('extracts nested multi-step path content', () => {
    expect(xpath('/root/element', '<root><element>value</element></root>')).toBe('value');
  });

  it('returns empty when element not found', () => {
    expect(xpath('/root/nonexistent', '<root><element>value</element></root>')).toBe('');
  });

  it('returns empty for self-closing target element', () => {
    expect(xpath('/root/leaf', '<root><leaf/></root>')).toBe('');
  });
});

describe('xmlcomment', () => {
  it('throws on empty input', () => {
    expect(() => xmlcomment('')).toThrow(/non-empty string/);
  });

  it('creates a comment', () => {
    expect(xmlcomment('hello')).toBe('<!--hello-->');
  });

  it('throws when comment contains --', () => {
    expect(() => xmlcomment('a -- b')).toThrow(/cannot contain/);
  });
});

describe('detectXmlExtendedFunc', () => {
  it('returns false for empty/non-string', () => {
    expect(detectXmlExtendedFunc('')).toBe(false);
    expect(detectXmlExtendedFunc(null as unknown as string)).toBe(false);
  });

  it('detects table_to_xml', () => {
    expect(detectXmlExtendedFunc("SELECT table_to_xml('t', true, false, '')")).toBe(true);
  });

  it('detects query_to_xml', () => {
    expect(detectXmlExtendedFunc('SELECT query_to_xml($1, false, false)')).toBe(true);
  });

  it('detects schema_to_xml', () => {
    expect(detectXmlExtendedFunc('SELECT schema_to_xml($1, false, true)')).toBe(true);
  });

  it('detects database_to_xml', () => {
    expect(detectXmlExtendedFunc('SELECT database_to_xml(false, false)')).toBe(true);
  });

  it('detects xpath_exists', () => {
    expect(detectXmlExtendedFunc("SELECT xpath_exists('/a', '<a/>')")).toBe(true);
  });

  it('detects xml_is_well_formed', () => {
    expect(detectXmlExtendedFunc("SELECT xml_is_well_formed('<x/>')")).toBe(true);
  });

  it('returns false for plain SQL', () => {
    expect(detectXmlExtendedFunc('SELECT 1')).toBe(false);
  });
});

describe('rewriteXmlExtendedFunc', () => {
  it('returns unchanged for empty/non-string', () => {
    expect(rewriteXmlExtendedFunc('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteXmlExtendedFunc(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns unchanged when no extended function present', () => {
    expect(rewriteXmlExtendedFunc('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites table_to_xml to a stub', () => {
    expect(rewriteXmlExtendedFunc("SELECT table_to_xml('t', true, false, '') FROM t")).toEqual({
      sql: "SELECT '<tables/>' FROM t",
      rewritten: true,
    });
  });

  it('rewrites query_to_xml to a stub', () => {
    expect(rewriteXmlExtendedFunc('SELECT query_to_xml($1, false)')).toEqual({
      sql: "SELECT '<query/>'",
      rewritten: true,
    });
  });

  it('rewrites schema_to_xml to a stub', () => {
    expect(rewriteXmlExtendedFunc('SELECT schema_to_xml($1, false)')).toEqual({
      sql: "SELECT '<schema/>'",
      rewritten: true,
    });
  });

  it('rewrites database_to_xml to a stub', () => {
    expect(rewriteXmlExtendedFunc('SELECT database_to_xml(false)')).toEqual({
      sql: "SELECT '<database/>'",
      rewritten: true,
    });
  });

  it('rewrites xpath_exists to valid SQL (separates arguments)', () => {
    const r = rewriteXmlExtendedFunc("SELECT xpath_exists('/a', '<a/>') FROM t");
    expect(r.rewritten).toBe(true);
    // Must NOT contain a bare comma operator between the two args in the LIKE.
    expect(r.sql).not.toContain("'/a', '<a/>' LIKE");
    expect(r.sql).toContain('CASE WHEN');
  });

  it('rewrites xpath_exists with a single (xml-only) argument', () => {
    const r = rewriteXmlExtendedFunc("SELECT xpath_exists('<a/>')");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("CASE WHEN '<a/>' LIKE '%<%>%'");
    expect(r.sql).toContain('THEN 1 ELSE 0 END');
  });

  it('rewrites xml_is_well_formed to valid SQL', () => {
    const r = rewriteXmlExtendedFunc("SELECT xml_is_well_formed('<x/>')");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('CASE WHEN');
    expect(r.sql).toContain('THEN 1 ELSE 0 END');
  });

  it('rewrites multiple extended functions in one statement', () => {
    const sql = "SELECT table_to_xml('t'), xml_is_well_formed('<x/>')";
    const r = rewriteXmlExtendedFunc(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'<tables/>'");
    expect(r.sql).toContain('CASE WHEN');
  });
});

describe('detectXmlFunction', () => {
  it('returns false for empty/non-string', () => {
    expect(detectXmlFunction('')).toBe(false);
    expect(detectXmlFunction(null as unknown as string)).toBe(false);
  });

  it('detects basic xml functions via detectXmlFunc', () => {
    expect(detectXmlFunction('SELECT xmlelement(name foo)')).toBe(true);
  });

  it('detects xpath', () => {
    expect(detectXmlFunction("SELECT xpath('/a', '<a/>')")).toBe(true);
  });

  it('detects extended functions', () => {
    expect(detectXmlFunction("SELECT table_to_xml('t')")).toBe(true);
  });

  it('returns false for plain SQL', () => {
    expect(detectXmlFunction('SELECT 1')).toBe(false);
  });
});
