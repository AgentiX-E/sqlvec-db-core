import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FtsTranslator, expandSynonyms, unaccent } from '../query/FtsTranslator';

// The thesaurus is loaded lazily from `data/fts_thesaurus.json`, which is
// ignored by git (it is a deployment-provided optional configuration). We
// materialise a minimal fixture before the suite runs so the synonym-expansion
// path is exercised deterministically, then remove it afterwards to leave the
// working tree clean.
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const THESAURUS_PATH = path.join(DATA_DIR, 'fts_thesaurus.json');

beforeAll(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    THESAURUS_PATH,
    JSON.stringify({ happy: ['glad', 'joyful'], quick: ['fast'] }),
  );
});

afterAll(() => {
  try {
    fs.unlinkSync(THESAURUS_PATH);
  } catch {
    /* already removed */
  }
  try {
    fs.rmdirSync(DATA_DIR);
  } catch {
    /* directory may contain other files */
  }
});

describe('expandSynonyms', () => {
  it('returns the term itself when no synonym exists', () => {
    expect(expandSynonyms('hello')).toEqual(['hello']);
  });

  it('expands a term whose key matches the thesaurus', () => {
    expect(expandSynonyms('happy')).toEqual(['happy', 'glad', 'joyful']);
  });

  it('expands a term that appears as a synonym of another key', () => {
    expect(expandSynonyms('glad')).toEqual(['glad', 'happy', 'joyful']);
  });
});

describe('unaccent', () => {
  it('removes diacritics via NFKD normalization', () => {
    expect(unaccent('café')).toBe('cafe');
    expect(unaccent('résumé')).toBe('resume');
    expect(unaccent('plain')).toBe('plain');
  });
});

describe('FtsTranslator.tsquery', () => {
  const f = new FtsTranslator();
  it('converts & | ! operators', () => {
    expect(f.tsquery('hello & world')).toBe('hello AND world');
    expect(f.tsquery('hello | world')).toBe('hello OR world');
    expect(f.tsquery('hello & !world')).toBe('hello AND NOT world');
  });

  it('converts the phrase operator <-> (BUG #451)', () => {
    expect(f.tsquery('a <-> b')).toBe('a b');
    expect(f.tsquery('hello <-> world & foo')).toBe('hello world AND foo');
  });

  it('strips surrounding quotes', () => {
    expect(f.tsquery("'hello & world'")).toBe('hello AND world');
    expect(f.tsquery('"hello & world"')).toBe('hello AND world');
  });

  it('handles prefix wildcard', () => {
    expect(f.tsquery('foo:* & bar')).toBe('foo* AND bar');
  });

  it('returns empty for empty / quoted-empty', () => {
    expect(f.tsquery('')).toBe('');
    expect(f.tsquery("''")).toBe('');
  });

  it('preserves boolean keywords as-is (not stemmed)', () => {
    expect(f.tsquery('hello AND world')).toBe('hello AND world');
  });
});

describe('FtsTranslator.plaintoTsquery', () => {
  const f = new FtsTranslator();
  it('joins words with AND', () => {
    expect(f.plaintoTsquery('hello world foo')).toBe('hello AND world AND foo');
  });
  it('strips quotes', () => {
    expect(f.plaintoTsquery("'hello world'")).toBe('hello AND world');
    expect(f.plaintoTsquery('"hello world"')).toBe('hello AND world');
  });
  it('returns empty for empty input', () => {
    expect(f.plaintoTsquery('')).toBe('');
  });
});

describe('FtsTranslator.rank', () => {
  const f = new FtsTranslator();
  it('returns 1.0 for full overlap (BUG #452)', () => {
    expect(f.rank("'hello':1 'world':2", 'hello & world')).toBe(1);
  });
  it('returns fractional for partial overlap', () => {
    expect(f.rank("'hello':1 'world':2", 'hello & foo')).toBe(0.5);
  });
  it('ignores operators (BUG #458)', () => {
    expect(f.rank("'hello':1 'world':2", 'hello | world')).toBe(1);
  });
  it('returns 0 for empty query', () => {
    expect(f.rank("'hello':1", '')).toBe(0);
  });
});

describe('FtsTranslator.phrasetoTsquery', () => {
  const f = new FtsTranslator();
  it('wraps multiple tokens in a phrase', () => {
    expect(f.phrasetoTsquery('hello world')).toBe('"hello world"');
  });
  it('returns a single token bare', () => {
    expect(f.phrasetoTsquery('hello')).toBe('hello');
  });
  it('strips quotes', () => {
    expect(f.phrasetoTsquery("'hello world'")).toBe('"hello world"');
    expect(f.phrasetoTsquery('"hello world"')).toBe('"hello world"');
  });
  it('returns empty for empty input', () => {
    expect(f.phrasetoTsquery('')).toBe('');
  });
});

describe('FtsTranslator.websearchToTsquery', () => {
  const f = new FtsTranslator();
  it('converts -term to NOT term', () => {
    expect(f.websearchToTsquery('hello -world OR foo')).toBe('hello NOT world OR foo');
  });
  it('preserves quoted phrases', () => {
    expect(f.websearchToTsquery('"hello world" -foo')).toBe('"hello world" NOT foo');
  });
  it('strips surrounding quotes', () => {
    expect(f.websearchToTsquery("'hello -world'")).toBe('hello NOT world');
  });
});

describe('FtsTranslator.rewriteSql', () => {
  const f = new FtsTranslator();

  it('rewrites @@ to_tsquery to MATCH (BUG #454)', () => {
    expect(f.rewriteSql("SELECT * FROM t WHERE body @@ to_tsquery('hello & world')")).toBe(
      "SELECT * FROM t WHERE body MATCH 'hello AND world'",
    );
  });

  it('rewrites @@ plainto_tsquery', () => {
    expect(f.rewriteSql("SELECT * FROM t WHERE body @@ plainto_tsquery('hello world')")).toBe(
      "SELECT * FROM t WHERE body MATCH 'hello AND world'",
    );
  });

  it('handles quoted and schema-qualified column references', () => {
    expect(f.rewriteSql('SELECT * FROM t WHERE "Body" @@ to_tsquery(\'x\')')).toBe(
      "SELECT * FROM t WHERE \"Body\" MATCH 'x'",
    );
    expect(f.rewriteSql("SELECT * FROM t WHERE t.body @@ to_tsquery('x')")).toBe(
      "SELECT * FROM t WHERE t.body MATCH 'x'",
    );
  });

  it('replaces to_tsvector with NULL (BUG #456)', () => {
    expect(f.rewriteSql('SELECT to_tsvector(body) FROM t')).toBe('SELECT NULL FROM t');
  });

  it('unwraps to_tsvector(config, col) as a @@ left operand instead of NULL', () => {
    // The canonical PostgreSQL full-text idiom is
    //   `to_tsvector(config, col) @@ to_tsquery(...)`.
    // The vector call has no FTS5 query-time equivalent, so the MATCH column
    // must be the vector's column argument — not a literal NULL. Previously
    // this produced `NULL @@ '...'` with a dangling `@@`.
    expect(f.rewriteSql("SELECT * FROM t WHERE to_tsvector('english', body) @@ to_tsquery('hello')")).toBe(
      "SELECT * FROM t WHERE body MATCH 'hello'",
    );
    expect(f.rewriteSql("SELECT * FROM t WHERE to_tsvector('simple', title) @@ phraseto_tsquery('hello world')")).toBe(
      "SELECT * FROM t WHERE title MATCH '\"hello world\"'",
    );
  });

  it('replaces ts_rank with 1.0 and ts_headline with empty string', () => {
    expect(f.rewriteSql('SELECT ts_rank(tv, q) FROM t')).toBe('SELECT 1.0 FROM t');
    expect(f.rewriteSql('SELECT ts_headline(body, q) FROM t')).toBe("SELECT '' FROM t");
  });

  it('leaves string literals untouched (BUG #455)', () => {
    expect(f.rewriteSql("SELECT 'to_tsvector(body)' FROM t")).toBe(
      "SELECT 'to_tsvector(body)' FROM t",
    );
  });

  it('leaves a comment untouched', () => {
    expect(f.rewriteSql('SELECT * FROM t -- to_tsvector(x)\n')).toBe(
      'SELECT * FROM t -- to_tsvector(x)\n',
    );
  });

  it('returns unchanged when no FTS construct is present', () => {
    expect(f.rewriteSql('SELECT * FROM t WHERE x = 1')).toBe('SELECT * FROM t WHERE x = 1');
  });

  it('rewrites standalone to_tsquery / phraseto_tsquery without @@', () => {
    expect(f.rewriteSql("SELECT to_tsquery('hello & world')")).toBe("SELECT 'hello AND world'");
    expect(f.rewriteSql("SELECT phraseto_tsquery('hello world')")).toBe('SELECT \'"hello world"\'');
    expect(f.rewriteSql("SELECT websearch_to_tsquery('hello -world')")).toBe(
      "SELECT 'hello NOT world'",
    );
  });

  it('handles nested function-call arguments in a match', () => {
    expect(f.rewriteSql("SELECT * FROM t WHERE body @@ to_tsquery(lower('HELLO'))")).toBe(
      "SELECT * FROM t WHERE body MATCH 'lower(''hello'')'",
    );
  });

  it('leaves a @@ whose right side is not an FTS function', () => {
    expect(f.rewriteSql('SELECT * FROM t WHERE body @@ foo')).toBe(
      'SELECT * FROM t WHERE body @@ foo',
    );
  });

  it('leaves a leading @@ with no left operand (only the bare @@ survives)', () => {
    // A leading `@@` has no left operand, so it cannot become `MATCH`; the
    // trailing `to_tsquery(...)` is still translated as a standalone function.
    expect(f.rewriteSql("@@ to_tsquery('x')")).toBe("@@ 'x'");
  });

  it('rewrites multiple matches in one statement', () => {
    expect(f.rewriteSql("SELECT a @@ to_tsquery('x'), b @@ to_tsquery('y') FROM t")).toBe(
      "SELECT a MATCH 'x', b MATCH 'y' FROM t",
    );
  });

  it('leaves a @@ with a bare (no-paren) function reference', () => {
    expect(f.rewriteSql('SELECT * FROM t WHERE body @@ to_tsquery')).toBe(
      'SELECT * FROM t WHERE body @@ to_tsquery',
    );
  });

  it('replaces ts_rank with 1.0 for multi-arg as well', () => {
    expect(f.rewriteSql('SELECT ts_rank(x, y, z) FROM t')).toBe('SELECT 1.0 FROM t');
  });

  it('stems boolean-keyword query text through processQueryText', () => {
    expect(f.rewriteSql("SELECT * FROM t WHERE body @@ to_tsquery('hello AND world')")).toBe(
      "SELECT * FROM t WHERE body MATCH 'hello AND world'",
    );
  });

  it('handles a match with an unclosed function paren', () => {
    expect(f.rewriteSql("SELECT * FROM t WHERE body @@ to_tsquery('x'")).toBe(
      "SELECT * FROM t WHERE body @@ to_tsquery('x'",
    );
  });

  it('handles a two-arg @@ to_tsquery (config + query)', () => {
    expect(f.rewriteSql("SELECT * FROM t WHERE body @@ to_tsquery('english', 'hello & world')")).toBe(
      "SELECT * FROM t WHERE body MATCH 'hello AND world'",
    );
  });

  it('handles an empty-args @@ to_tsquery', () => {
    expect(f.rewriteSql('SELECT * FROM t WHERE body @@ to_tsquery()')).toBe(
      "SELECT * FROM t WHERE body MATCH ''",
    );
  });

  it('handles a standalone empty-args to_tsquery', () => {
    expect(f.rewriteSql('SELECT to_tsquery()')).toBe("SELECT ''");
  });

  it('leaves a @@ with a non-ident left operand (leading paren)', () => {
    expect(f.rewriteSql("(@@ to_tsquery('x')")).toBe("(@@ 'x'");
  });
});

describe('FtsTranslator.containsFts', () => {
  const f = new FtsTranslator();
  it('detects FTS patterns deterministically (BUG #457)', () => {
    expect(f.containsFts('SELECT to_tsquery(x)')).toBe(true);
    expect(f.containsFts('SELECT to_tsquery(x)')).toBe(true);
    expect(f.containsFts('SELECT to_tsquery(x)')).toBe(true);
  });
  it('does not detect a literal or comment', () => {
    expect(f.containsFts("SELECT 'to_tsquery(x)'")).toBe(false);
    expect(f.containsFts('-- to_tsquery(x)\nSELECT 1')).toBe(false);
  });
  it('detects to_tsvector / ts_rank / ts_headline', () => {
    expect(f.containsFts('SELECT to_tsvector(x)')).toBe(true);
    expect(f.containsFts('SELECT ts_rank(x, y)')).toBe(true);
    expect(f.containsFts('SELECT ts_headline(x)')).toBe(true);
  });
});

describe('FtsTranslator.tsvector', () => {
  const f = new FtsTranslator();
  it('tokenizes with positional indices', () => {
    expect(f.tsvector('english', 'The quick brown fox')).toBe("'quick':1 'brown':2 'fox':3");
  });
});

describe('FtsTranslator config / dictionary', () => {
  const f = new FtsTranslator();
  it('returns default config', () => {
    expect(f.getConfig('english')).toBe('stop_words=english');
    expect(f.getConfig('nope')).toBe('tokenize=unicode61');
  });
  it('sets and gets config', () => {
    f.setConfig('xx', 'yy');
    expect(f.getConfig('xx')).toBe('yy');
  });
  it('stems tokens', () => {
    expect(f.stem('running')).toBe('run');
  });
  it('unaccents via the class method', () => {
    expect(f.unaccent('café')).toBe('cafe');
  });
  it('expandSynonyms delegates', () => {
    expect(f.expandSynonyms('hello')).toEqual(['hello']);
  });
});
