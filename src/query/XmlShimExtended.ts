/**
 * XmlShimExtended — Extended PostgreSQL XML function shims for SQLite.
 *
 * Extends the basic XmlShim with functions that provide actual XML
 * processing logic (within the limits of a regex-based approach):
 *
 *   - `xmlparse(input)`        — validate and return XML as text
 *   - `xmlserialize(xml)`      — serialize XML to string (passthrough)
 *   - `xmlcomment(text)`       — create XML comment `<!-- text -->`
 *   - `xpath(expr, xml)`       — basic XPath evaluation (regex-based)
 *   - `detectXmlFunction(sql)` — combined detector
 *
 * ⚠️ Important limitations:
 *   - XPath support is limited to simple path expressions (`/root/element`)
 *   - XML validation is basic (checks well-formedness of simple structures)
 *   - Full XPath/XQuery requires an external library
 *
 * @module XmlShimExtended
 */

import { PinoLogger } from '../logger/PinoLogger';
import { detectXmlFunc } from './XmlShim';

const logger = PinoLogger.forComponent('XmlShimExtended');

// ── Types ────────────────────────────────────────────────────────

type XmlResult = { sql: string; rewritten: boolean };

// ── Regex Patterns ───────────────────────────────────────────────

/**
 * Interface for tag entries during XML validation.
 */
interface TagEntry {
  name: string;
  isClose: boolean;
  pos: number;
}

/**
 * Collect all open and close tags in order of appearance in the XML string,
 * using character-by-character scanning to handle complex cases.
 *
 * This avoids V8 regex engine issues with certain patterns (e.g., lookbehind).
 */
function collectTagsInOrder(xml: string): TagEntry[] {
  const tags: TagEntry[] = [];
  let i = 0;

  while (i < xml.length) {
    // Find the next '<'
    const ltPos = xml.indexOf('<', i);
    if (ltPos === -1) break;

    // Peek at the next character
    const nextChar = xml[ltPos + 1];
    if (!nextChar) break;

    // Find the closing '>'
    const gtPos = xml.indexOf('>', ltPos);
    if (gtPos === -1) break;

    const tagContent = xml.slice(ltPos + 1, gtPos).trim();

    if (nextChar === '/') {
      // Close tag: </name ...>
      const nameMatch = tagContent.slice(1).match(/^([A-Za-z_][A-Za-z0-9_:.-]*)/);
      if (nameMatch) {
        tags.push({ name: nameMatch[1], isClose: true, pos: ltPos });
      }
    } else if (tagContent.endsWith('/')) {
      // Self-closing tag: <name ... />
      // Skip — not an open tag
    } else if (nextChar === '?' || nextChar === '!') {
      // Processing instruction or comment — skip
    } else {
      // Open tag: <name ...>
      const nameMatch = tagContent.match(/^([A-Za-z_][A-Za-z0-9_:.-]*)/);
      if (nameMatch) {
        tags.push({ name: nameMatch[1], isClose: false, pos: ltPos });
      }
    }

    i = gtPos + 1;
  }

  return tags;
}

/**
 * Match a simple XPath expression like `/root/element` or `/root/element/sub`.
 * Only supports element name steps separated by `/`.
 */
// eslint-disable-next-line require-unicode-regexp
const SIMPLE_XPATH_RE = /^\/([A-Za-z_][A-Za-z0-9_:.-]*(?:\/[A-Za-z_][A-Za-z0-9_:.-]*)*)$/;

/**
 * Comment validation — must not contain `--`.
 */
const COMMENT_BLOCK_RE = /--/;

// ── Public API ───────────────────────────────────────────────────

/**
 * Parse an XML document and validate its well-formedness.
 *
 * This is a basic validation that checks:
 *   1. Input is a non-empty string
 *   2. Input starts with `<`
 *   3. Has matching opening/closing tags (for simple cases)
 *   4. Self-closing tags are recognized
 *
 * For production use, a proper XML parser should be used.
 *
 * @param input - The XML string to parse
 * @returns The input XML string if well-formed
 * @throws Error if the XML is not well-formed
 *
 * @example
 * ```ts
 * xmlparse('<root><child>text</child></root>')
 * // → '<root><child>text</child></root>'
 *
 * xmlparse('<root/>')
 * // → '<root/>'
 *
 * xmlparse('not xml')
 * // → Error: Invalid XML: must start with '<'
 * ```
 */
export function xmlparse(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new Error('XML parse error: input must be a non-empty string');
  }

  const trimmed = input.trim();
  if (!trimmed.startsWith('<')) {
    throw new Error('Invalid XML: must start with \'<\'');
  }

  // Collect all tags in document order and validate balanced open/close
  // pairing using an explicit stack.
  const openStack: string[] = [];
  const allTags = collectTagsInOrder(trimmed);

  for (const tag of allTags) {
    if (tag.isClose) {
      if (openStack.length === 0) {
        throw new Error(`Invalid XML: unexpected closing tag </${tag.name}>`);
      }
      const lastOpen = openStack.pop()!;
      if (lastOpen !== tag.name) {
        throw new Error(
          `Invalid XML: mismatched tags — expected </${lastOpen}>, got </${tag.name}>`,
        );
      }
    } else {
      openStack.push(tag.name);
    }
  }

  // If there are unclosed tags (self-closing tags don't appear on the stack)
  if (openStack.length > 0) {
    throw new Error(
      `Invalid XML: unclosed tags: ${openStack.join(', ')}`,
    );
  }

  logger.debug({ length: trimmed.length }, 'XML parsed successfully');
  return trimmed;
}

/**
 * Serialize XML to a string.
 *
 * Since XML is already stored as text in SQLite, this is a simple
 * passthrough with a type annotation.
 *
 * @param xml - The XML value to serialize
 * @returns The XML as a string
 *
 * @example
 * ```ts
 * xmlserialize('<root/>')
 * // → '<root/>'
 * ```
 */
export function xmlserialize(xml: string): string {
  if (xml === null || xml === undefined) return '';
  return String(xml);
}

/**
 * Evaluate a simple XPath expression on an XML document.
 *
 * ⚠️ This is a **basic** XPath implementation that only supports:
 *   - Simple path expressions: `/root/element`, `/root/element/sub`
 *   - Single element name per step (no predicates, no attributes, no axes)
 *
 * For full XPath support, use a proper XML/XPath library.
 *
 * @param xpathExpr - The XPath expression to evaluate
 * @param xml - The XML document string
 * @param nsArray - Optional namespace array (ignored in basic implementation)
 * @returns The text content of the matched element, or empty string if not found
 *
 * @example
 * ```ts
 * xpath('/root/element', '<root><element>value</element></root>')
 * // → 'value'
 *
 * xpath('/root/nonexistent', '<root><element>value</element></root>')
 * // → ''
 * ```
 */
export function xpath(
  xpathExpr: string,
  xml: string,
  nsArray?: string[][],
): string {
  if (!xpathExpr || !xml) return '';

  const pathMatch = xpathExpr.trim().match(SIMPLE_XPATH_RE);
  if (!pathMatch) {
    logger.warn(
      { xpathExpr },
      'xpath: only simple path expressions supported (e.g., /root/element)',
    );
    return '';
  }

  const path = pathMatch[1]; // e.g., "root/element/sub"
  const steps = path.split('/');

  // Traverse the XML tree step by step using regex
  let currentXml = xml.trim();

  for (const step of steps) {
    if (!step) continue;

    // Find the content of the matching element
    // eslint-disable-next-line require-unicode-regexp
    const elemRe = new RegExp(
      `<${step}(?:\\s+[^>]*)?>` +
      '([\\s\\S]*?)' +
      `<\\/${step}>`,
    );

    // Also check for self-closing
    // eslint-disable-next-line require-unicode-regexp
    const selfCloseRe = new RegExp(`<${step}(?:\\s+[^>]*)?\\/>`);

    const elemMatch = currentXml.match(elemRe);
    if (elemMatch) {
      currentXml = elemMatch[1]; // Go deeper
    } else if (selfCloseRe.test(currentXml)) {
      return ''; // Self-closing element → no content
    } else {
      return ''; // Element not found
    }
  }

  return currentXml.trim();
}

/**
 * Create an XML comment.
 *
 * PG function: `xmlcomment(text)` → `<!-- text -->`
 *
 * @param text - The comment text
 * @returns The XML comment string
 * @throws Error if the text contains `--` (invalid in XML comments)
 *
 * @example
 * ```ts
 * xmlcomment('hello')
 * // → '<!-- hello -->'
 *
 * xmlcomment('a -- b')
 * // → Error: XML comment cannot contain '--'
 * ```
 */
export function xmlcomment(text: string): string {
  if (!text || typeof text !== 'string') {
    throw new Error('XML comment text must be a non-empty string');
  }

  if (COMMENT_BLOCK_RE.test(text)) {
    throw new Error('XML comment cannot contain \'--\'');
  }

  return `<!--${text}-->`;
}

// ────────────────────────────────────────────────────────────────
//  Extended XML Functions
// ────────────────────────────────────────────────────────────────

/**
 * Regex matching extended XML function calls.
 */
const TABLE_TO_XML_RE = /\btable_to_xml\s*\(([^)]+)\)/gi;
const QUERY_TO_XML_RE = /\bquery_to_xml\s*\(([^)]+)\)/gi;
const SCHEMA_TO_XML_RE = /\bschema_to_xml\s*\(([^)]+)\)/gi;
const DATABASE_TO_XML_RE = /\bdatabase_to_xml\s*\(([^)]+)\)/gi;
const XPATH_EXISTS_RE = /\bxpath_exists\s*\(([^)]+)\)/gi;
const XML_IS_WELL_FORMED_RE = /\bxml_is_well_formed\s*\(([^)]+)\)/gi;

const ANY_XML_EXTENDED_RE = /\b(table_to_xml|query_to_xml|schema_to_xml|database_to_xml|xpath_exists|xml_is_well_formed)\s*\(/i;

/**
 * Detect whether the given SQL string contains PostgreSQL extended XML
 * functions (table_to_xml, query_to_xml, schema_to_xml, database_to_xml,
 * xpath_exists, xml_is_well_formed) that SQLite does not support.
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if an extended XML function is detected
 *
 * @example
 * ```ts
 * detectXmlExtendedFunc("SELECT table_to_xml('t', true, false, '')"); // true
 * detectXmlExtendedFunc("SELECT xml_is_well_formed('<x/>')");        // true
 * detectXmlExtendedFunc("SELECT 1");                                  // false
 * ```
 */
export function detectXmlExtendedFunc(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  return ANY_XML_EXTENDED_RE.test(sql.trim());
}

/**
 * Rewrite PostgreSQL extended XML function calls to SQLite-compatible
 * stub values.
 *
 * Processing rules:
 *
 * | Function                                     | Output              |
 * |----------------------------------------------|---------------------|
 * | `table_to_xml(...)`                          | `'<tables/>'`      |
 * | `query_to_xml(...)`                          | `'<query/>'`       |
 * | `schema_to_xml(...)`                         | `'<schema/>'`      |
 * | `database_to_xml(...)`                       | `'<database/>'`    |
 * | `xpath_exists(xpath, xml)`                   | xpath-simple check |
 * | `xml_is_well_formed(string)`                 | regex-based check  |
 *
 * @param sql - The raw SQL string to process
 * @returns An XmlResult with the rewritten SQL and rewritten flag
 *
 * @example
 * ```ts
 * rewriteXmlExtendedFunc("SELECT table_to_xml('t', true, false, '') FROM t")
 * // → { sql: "SELECT '<tables/>' FROM t", rewritten: true }
 *
 * rewriteXmlExtendedFunc("SELECT xml_is_well_formed('<x/>') FROM t")
 * // → { sql: "SELECT CASE WHEN '<x/>' LIKE '<%/>%' THEN 1 ELSE 0 END FROM t", rewritten: true }
 * ```
 */
export function rewriteXmlExtendedFunc(sql: string): XmlResult {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  // Quick check first: bail early if no extended XML function is present
  if (!detectXmlExtendedFunc(sql)) {
    return { sql, rewritten: false };
  }

  let working = sql;
  let rewritten = false;

  // ── Phase 1: table_to_xml(...) → '<tables/>' ──
  working = working.replace(TABLE_TO_XML_RE, () => {
    rewritten = true;
    return "'<tables/>'";
  });

  // ── Phase 2: query_to_xml(...) → '<query/>' ──
  working = working.replace(QUERY_TO_XML_RE, () => {
    rewritten = true;
    return "'<query/>'";
  });

  // ── Phase 3: schema_to_xml(...) → '<schema/>' ──
  working = working.replace(SCHEMA_TO_XML_RE, () => {
    rewritten = true;
    return "'<schema/>'";
  });

  // ── Phase 4: database_to_xml(...) → '<database/>' ──
  working = working.replace(DATABASE_TO_XML_RE, () => {
    rewritten = true;
    return "'<database/>'";
  });

  // ── Phase 5: xpath_exists(xpath, xml[, nsarray]) → CASE WHEN ──
  working = working.replace(XPATH_EXISTS_RE, (_match: string, args: string) => {
    rewritten = true;
    // `args` holds everything between the outer parentheses, e.g.
    // `'/a/b', '<a><b/></a>'`. Split on the first top-level comma to separate
    // the XPath expression from the XML document argument (a regex-based stub,
    // so nested commas inside filtered-out subexpressions are not handled).
    const trimmedArgs = args.trim();
    const firstComma = trimmedArgs.indexOf(',');
    const xmlArg = firstComma === -1
      ? trimmedArgs
      : trimmedArgs.slice(firstComma + 1).trim();
    // Stub semantics: the path exists iff the XML document contains at least
    // one element tag. This avoids emitting invalid SQL (the previous rewrite
    // concatenated both operands into a single LIKE, producing `x, y LIKE ...`).
    return `CASE WHEN ${xmlArg} LIKE '%<%>%' THEN 1 ELSE 0 END`;
  });

  // ── Phase 6: xml_is_well_formed(string) → CASE WHEN ──
  working = working.replace(XML_IS_WELL_FORMED_RE, (_match: string, arg: string) => {
    rewritten = true;
    const a = arg.trim();
    // Note: `%` is the SQL LIKE wildcard (SQLite does not use `%%` as an
    // escape); a single `%` already matches zero-or-more characters.
    return `CASE WHEN (${a} LIKE '<%>%' AND ${a} LIKE '%</%>') OR ${a} LIKE '<%/>' THEN 1 ELSE 0 END`;
  });

  if (rewritten) {
    logger.debug({ before: sql, after: working }, 'Extended XML function rewritten');
  }

  return { sql: working, rewritten };
}

/**
 * Combined detector for XML functions.
 *
 * Checks if SQL contains any XML-related function calls:
 *   - xmlelement, xmlforest, xmlconcat, xmlagg, xmlcomment, xmlpi,
 *     xmlroot, xmlserialize, xmlparse, xpath
 *   - table_to_xml, query_to_xml, schema_to_xml, database_to_xml
 *   - xpath_exists, xml_is_well_formed
 *
 * @param sql - The SQL string to inspect
 * @returns `true` if the SQL contains XML function calls
 *
 * @example
 * ```ts
 * detectXmlFunction("SELECT xmlelement(name foo)")  // true
 * detectXmlFunction("SELECT xmlparse('<root/>')")   // true
 * detectXmlFunction("SELECT 1")                     // false
 * ```
 */
export function detectXmlFunction(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;

  // Check basic XML functions
  if (detectXmlFunc(sql)) return true;

  // Check for xpath
  // eslint-disable-next-line require-unicode-regexp
  if (/\bxpath\s*\(/i.test(sql)) return true;

  // Check for extended XML functions
  if (detectXmlExtendedFunc(sql)) return true;

  return false;
}
