/**
 * PgHbaConf — PostgreSQL host-based authentication (HBA) configuration.
 *
 * Parses the contents of a `pg_hba.conf` file into a list of {@link HbaRecord}
 * entries suitable for the `pg_hba_file_rules` system view.  Each non-empty,
 * non-comment line describes one authentication rule of the form
 *
 *     type  database  user  address  auth-method  [options]
 *
 * where `address` is omitted for `local` rules and `options` are optional
 * `key=value` pairs.  The parser is deliberately tolerant: malformed or
 * unsupported lines are skipped rather than aborting the whole file, matching
 * PostgreSQL's behaviour of reporting per-line errors without dropping valid
 * neighbours.
 *
 * @module auth/PgHbaConf
 */

/**
 * A single parsed `pg_hba.conf` rule.
 *
 * Field names mirror the `pg_hba_file_rules` system view columns
 * (`auth_method`, not `method`), which is the contract consumed by
 * `PgSystemViews.hbaRecordToRow`.
 */
export interface HbaRecord {
  /** Connection type: `local`, `host`, `hostssl`, or `hostnossl`. */
  type: string;
  /** Database name (or `all`). */
  database: string;
  /** User/role name (or `all`). */
  user: string;
  /** Client address in CIDR form, or `null` for `local` rules. */
  address: string | null;
  /** Authentication method: `trust`, `md5`, `scram-sha-256`, `cert`, etc. */
  authMethod: string;
  /** Optional `key=value` authentication-method options. */
  options: Record<string, string>;
}

/** Default rules used when no configuration has been loaded. */
const DEFAULT_RULES: HbaRecord[] = [
  { type: 'local', database: 'all', user: 'all', address: null, authMethod: 'trust', options: {} },
  { type: 'host', database: 'all', user: 'all', address: '127.0.0.1/32', authMethod: 'trust', options: {} },
  { type: 'host', database: 'all', user: 'all', address: '::1/128', authMethod: 'trust', options: {} },
];

/** Connection types that carry a client address. */
const ADDRESS_BEARING_TYPES = new Set(['host', 'hostssl', 'hostnossl']);

/**
 * Split a line into whitespace-separated tokens, honouring double/single quotes
 * (so values may contain spaces or `#`).  Unbalanced quotes return `null` to
 * signal a malformed line.
 */
function tokenize(line: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) return null; // unbalanced quote
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parse a single HBA rule line into an {@link HbaRecord}, or `null` if the
 * line is empty/comment/malformed.
 */
function parseRule(line: string): HbaRecord | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length < 4) return null;

  const type = tokens[0].toLowerCase();
  const database = tokens[1];
  const user = tokens[2];

  let address: string | null = null;
  let authMethod: string;
  let options: Record<string, string> = {};

  if (ADDRESS_BEARING_TYPES.has(type)) {
    // host / hostssl / hostnossl: address is required
    if (tokens.length < 5) return null;
    address = tokens[3];
    authMethod = tokens[4];
    options = parseOptions(tokens.slice(5));
  } else if (type === 'local') {
    // local: no address; auth method follows user directly
    authMethod = tokens[3];
    options = parseOptions(tokens.slice(4));
  } else {
    // Unknown connection type — reject the line.
    return null;
  }

  return { type, database, user, address, authMethod, options };
}

/** Parse `key=value` tokens into an options map. */
function parseOptions(tokens: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      options[token.slice(0, eq)] = token.slice(eq + 1);
    }
  }
  return options;
}

/**
 * Host-based authentication configuration.
 *
 * Holds the parsed rules backing the `pg_hba_file_rules` system view.  The
 * configuration is immutable after construction; `load()` creates a fresh
 * instance from raw file contents, and `getRecords()` returns a defensive
 * snapshot.
 */
export class PgHbaConf {
  private readonly rules: HbaRecord[];

  /** @internal Construct directly via {@link PgHbaConf.load}. */
  private constructor(rules: HbaRecord[]) {
    this.rules = rules;
  }

  /**
   * Parse raw `pg_hba.conf` contents into a configuration.  Returns the default
   * rules when the input is empty.
   */
  static load(content?: string): PgHbaConf {
    if (!content || content.trim() === '') {
      return new PgHbaConf(DEFAULT_RULES.map((r) => ({ ...r, options: { ...r.options } })));
    }
    const rules: HbaRecord[] = [];
    for (const line of content.split(/\r?\n/)) {
      const rule = parseRule(line);
      if (rule) rules.push(rule);
    }
    return new PgHbaConf(rules.length > 0 ? rules : DEFAULT_RULES.map((r) => ({ ...r, options: { ...r.options } })));
  }

  /** All parsed rules (snapshot). */
  getRules(): HbaRecord[] {
    return this.rules.map((r) => ({ ...r, options: { ...r.options } }));
  }

  /**
   * Alias for {@link PgHbaConf.getRules}, matching the method name expected by
   * `PgSystemViews.rewritePgHbaFileRules`.
   */
  getRecords(): HbaRecord[] {
    return this.getRules();
  }
}
