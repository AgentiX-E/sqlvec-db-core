/**
 * CreateFunctionHandler — parse and register CREATE FUNCTION statements.
 *
 * Parses:
 *   CREATE [OR REPLACE] FUNCTION name(p1 type, p2 type, ...)
 *     RETURNS type
 *     [LANGUAGE plpgsql]
 *     AS $$ body $$;
 *
 * Extracts function metadata and registers it with PLpgSQLExecutor.
 * The function body is then executable via SELECT fn(args).
 *
 * @module query/CreateFunctionHandler
 */

import { PinoLogger } from '../logger/PinoLogger';
import { PLpgSQLExecutor } from './PLpgSQLExecutor';

const logger = PinoLogger.forComponent('CreateFunctionHandler');

export interface ParsedFunction {
  name: string;
  params: string;           // raw param list string
  paramCount: number;
  returnType: string;
  body: string;
  isReplace: boolean;       // CREATE OR REPLACE
}

/**
 * Parse a CREATE FUNCTION statement and extract function metadata.
 *
 * Supports:
 *   CREATE [OR REPLACE] FUNCTION name(params) RETURNS type AS $$ body $$ [LANGUAGE plpgsql]
 *   CREATE [OR REPLACE] FUNCTION name(params) RETURNS type AS $tag$ body $tag$ [LANGUAGE plpgsql]
 *   CREATE [OR REPLACE] FUNCTION name() body-without-wrapper
 *   CREATE [OR REPLACE] FUNCTION name() $$ body $$ (no RETURNS)
 *
 * @param sql - The full CREATE FUNCTION SQL
 * @returns ParsedFunction on success, null on failure
 */
export function parseCreateFunction(sql: string): ParsedFunction | null {
  const trimmed = sql.trim().replace(/;+$/, '').trim();

  // Step 1: Extract the dollar-quoted body and everything around it.
  // Dollar quoting comes in two forms: $$...$$ and $tag$...$tag$
  let name = '';
  let rawParams = '';
  let returnType = 'text';
  let body = '';
  let isReplace = false;

  // Find the dollar-quoted body by scanning for $ which starts a dollar-quote
  const dollarQuoteStart = findDollarQuote(trimmed);
  if (dollarQuoteStart) {
    // Extract body from dollar quotes
    body = dollarQuoteStart.body;

    // Extract everything before the body
    const prefix = trimmed.substring(0, dollarQuoteStart.startIndex).trim();

    // Parse the prefix: CREATE [OR REPLACE] FUNCTION name(params) [RETURNS type] [LANGUAGE lang] [AS]
    const prefixRegex = /^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*\(([^)]*)\)\s*(?:RETURNS\s+(\w+(?:\s*\[\])?)\s*)?(?:LANGUAGE\s+\w+\s*)?(?:AS\s*)?$/i;
    const prefixMatch = prefix.match(prefixRegex);
    if (!prefixMatch) return null;

    name = prefixMatch[2];
    rawParams = prefixMatch[3].trim();
    isReplace = !!prefixMatch[1];
    if (prefixMatch[4]) {
      returnType = prefixMatch[4];
    }
  } else {
    // No dollar quoting — try a simpler approach: strip known keywords
    // This is the bare body approach: CREATE FUNCTION name() body
    const bareRegex = /^\s*CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*\(([^)]*)\)\s*(?:RETURNS\s+(\w+)\s*)?(.*?)\s*$/i;
    const bareMatch = trimmed.match(bareRegex);
    if (!bareMatch) return null;

    name = bareMatch[2];
    rawParams = bareMatch[3].trim();
    isReplace = !!bareMatch[1];
    if (bareMatch[4]) {
      returnType = bareMatch[4];
    }
    body = (bareMatch[5] || '').replace(/LANGUAGE\s+\w+/i, '').trim();
  }

  if (!name) return null;

  const paramCount = rawParams ? rawParams.split(',').filter(p => p.trim().length > 0).length : 0;

  return {
    name,
    params: rawParams,
    paramCount,
    returnType,
    body: body.trim(),
    isReplace,
  };
}

/**
 * Find a dollar-quoted string ($$...$$ or $tag$...$tag$) and return
 * its content and start index.
 */
function findDollarQuote(sql: string): { body: string; startIndex: number } | null {
  // Find the first $ that starts a dollar quote
  // Skip $ that are part of other constructs
  for (let i = 0; i < sql.length - 1; i++) {
    if (sql[i] === '$') {
      // Find the end of the opening tag
      let tagEnd = i + 1;
      while (tagEnd < sql.length && /[a-zA-Z0-9_]/.test(sql[tagEnd])) {
        tagEnd++;
      }
      if (tagEnd < sql.length && sql[tagEnd] === '$') {
        const tag = sql.substring(i + 1, tagEnd);
        const openTag = sql.substring(i, tagEnd + 1);

        // Find closing tag
        const closeTagIdx = sql.indexOf(openTag, tagEnd + 1);
        if (closeTagIdx !== -1) {
          const body = sql.substring(tagEnd + 1, closeTagIdx);
          return { body, startIndex: i };
        }
      }
    }
  }
  return null;
}

/**
 * Detect whether a SQL statement is a CREATE FUNCTION.
 */
export function detectCreateFunction(sql: string): boolean {
  return /^\s*CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i.test(sql.trim());
}

/**
 * Detect whether a SQL statement is a DROP FUNCTION.
 */
export function detectDropFunction(sql: string): boolean {
  return /^\s*DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(\w+)/i.test(sql.trim());
}

/**
 * Extract function name from DROP FUNCTION.
 */
export function extractDropFunctionName(sql: string): string | null {
  const match = sql.trim().match(/^\s*DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
  return match ? match[1] : null;
}
