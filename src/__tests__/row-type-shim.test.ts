import { describe, it, expect } from 'vitest';
import { detectRowExpr, rewriteRowExpr } from '../query/RowTypeShim';

describe('RowTypeShim', () => {
  describe('detectRowExpr', () => {
    it('detects a ROW constructor', () => {
      expect(detectRowExpr('SELECT ROW(1, 2)')).toBe(true);
      expect(detectRowExpr('ROW(a, b, c)')).toBe(true);
      expect(detectRowExpr('SELECT row(1, 2)')).toBe(true);
      expect(detectRowExpr('SELECT ROW ( 1, 2 )')).toBe(true);
    });
    it('returns false for non-ROW SQL', () => {
      expect(detectRowExpr('SELECT 1')).toBe(false);
      expect(detectRowExpr('SELECT * FROM t')).toBe(false);
      expect(detectRowExpr('SELECT ROW_NUMBER() OVER ()')).toBe(false);
      expect(detectRowExpr('my_row')).toBe(false);
    });
    it('returns false for empty / non-string', () => {
      expect(detectRowExpr('')).toBe(false);
      expect(detectRowExpr(null as any)).toBe(false);
      expect(detectRowExpr(42 as any)).toBe(false);
    });
    it('does not match ROW inside a string literal', () => {
      expect(detectRowExpr("SELECT 'ROW(1,2)'")).toBe(false);
    });
    it('does not match ROW inside a comment', () => {
      expect(detectRowExpr("SELECT 1 -- ROW(a,b)\n")).toBe(false);
    });
    it('does not match ROW inside a double-quoted identifier', () => {
      expect(detectRowExpr('SELECT "ROW(1,2)"')).toBe(false);
    });
  });

  describe('rewriteRowExpr', () => {
    it('rewrites ROW(...) to json_array(...)', () => {
      expect(rewriteRowExpr("SELECT ROW(1, 'a') AS r")).toEqual({
        sql: "SELECT json_array(1, 'a') AS r", rewritten: true,
      });
      expect(rewriteRowExpr('SELECT ROW(a, b, c)')).toEqual({
        sql: 'SELECT json_array(a, b, c)', rewritten: true,
      });
      expect(rewriteRowExpr('SELECT ROW(1)')).toEqual({
        sql: 'SELECT json_array(1)', rewritten: true,
      });
    });
    it('handles nested parentheses inside ROW args', () => {
      expect(rewriteRowExpr('SELECT ROW(1, (2+3))')).toEqual({
        sql: 'SELECT json_array(1, (2+3))', rewritten: true,
      });
    });
    it('handles commas inside string literals in args', () => {
      expect(rewriteRowExpr("SELECT ROW('a,b', 2)")).toEqual({
        sql: "SELECT json_array('a,b', 2)", rewritten: true,
      });
    });
    it('handles multiple ROW expressions', () => {
      expect(rewriteRowExpr('SELECT ROW(1), ROW(2, 3)')).toEqual({
        sql: 'SELECT json_array(1), json_array(2, 3)', rewritten: true,
      });
    });
    it('does not rewrite ROW inside a string literal', () => {
      expect(rewriteRowExpr("SELECT 'ROW(1,2)'")).toEqual({
        sql: "SELECT 'ROW(1,2)'", rewritten: false,
      });
    });
    it('does not rewrite ROW inside a comment', () => {
      expect(rewriteRowExpr('SELECT 1 -- ROW(a,b)')).toEqual({
        sql: 'SELECT 1 -- ROW(a,b)', rewritten: false,
      });
    });
    it('does not rewrite ROW_NUMBER()', () => {
      expect(rewriteRowExpr('SELECT ROW_NUMBER() OVER ()')).toEqual({
        sql: 'SELECT ROW_NUMBER() OVER ()', rewritten: false,
      });
    });
    it('skips an unbalanced ROW expression', () => {
      expect(rewriteRowExpr('SELECT ROW(1, 2')).toEqual({
        sql: 'SELECT ROW(1, 2', rewritten: false,
      });
    });
    it('passes through non-ROW SQL', () => {
      expect(rewriteRowExpr('SELECT * FROM t')).toEqual({
        sql: 'SELECT * FROM t', rewritten: false,
      });
    });
    it('handles empty / non-string input', () => {
      expect(rewriteRowExpr('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteRowExpr(null as any)).toEqual({ sql: '', rewritten: false });
    });
  });
});
