/**
 * PgFunctions unit tests — math section.
 *
 * Exercises the PostgreSQL math functions registered by `buildPgFunctions`.
 * Focuses on boundary cases (negative operands, zero divisor, NaN, rounding
 * ties) to surface behavior that diverges from PostgreSQL semantics.
 */
import { describe, it, expect } from 'vitest';
import { buildPgFunctions } from '../system/PgFunctions';

const map = buildPgFunctions();
const call = (name: string, ...args: any[]) => map.get(name)!.fn(...args);

describe('math — abs', () => {
  it('returns the absolute value', () => {
    expect(call('abs', -5)).toBe(5);
    expect(call('abs', 5)).toBe(5);
    expect(call('abs', -3.14)).toBeCloseTo(3.14);
  });

  it('returns null for null and non-numeric input', () => {
    expect(call('abs', null)).toBeNull();
    expect(call('abs', 'abc')).toBeNull();
  });
});

describe('math — round', () => {
  it('rounds to nearest integer without a second arg', () => {
    expect(call('round', 3.5)).toBe(4);
    expect(call('round', 3.49)).toBe(3);
    expect(call('round', -3.5)).toBe(-3); // JS Math.round rounds -3.5 to -3
  });

  it('rounds to a specified number of decimals', () => {
    expect(call('round', 3.14159, 2)).toBeCloseTo(3.14);
    expect(call('round', 3.14159, 0)).toBe(3);
    expect(call('round', 123.456, -2)).toBeCloseTo(100);
  });

  it('returns null for null and NaN input', () => {
    expect(call('round', null)).toBeNull();
    expect(call('round', 'abc')).toBeNull();
  });
});

describe('math — mod (PostgreSQL semantics)', () => {
  it('computes the remainder', () => {
    expect(call('mod', 10, 3)).toBe(1);
    expect(call('mod', 10, 2)).toBe(0);
  });

  it('returns null when the divisor is zero', () => {
    expect(call('mod', 10, 0)).toBeNull();
  });

  it('follows PostgreSQL sign semantics (sign of divisor)', () => {
    // PostgreSQL mod(y, x) = y - floor(y/x) * x, so the result carries the
    // sign of the divisor x.
    expect(call('mod', -5, 3)).toBe(1);   // -5 - floor(-5/3)*3 = -5 - (-6) = 1
    expect(call('mod', 5, -3)).toBe(-1);  // 5 - floor(5/-3)*(-3) = 5 - (-6) = -1
  });
});

describe('math — div (PostgreSQL floor division)', () => {
  it('truncates toward zero', () => {
    expect(call('div', 10, 3)).toBe(3);
    expect(call('div', -10, 3)).toBe(-3);
  });

  it('returns null on zero divisor', () => {
    expect(call('div', 10, 0)).toBeNull();
  });
});

describe('math — sqrt / exp / ln / log', () => {
  it('computes sqrt for non-negative values', () => {
    expect(call('sqrt', 16)).toBe(4);
    expect(call('sqrt', 0)).toBe(0);
    expect(call('sqrt', -1)).toBeNull();
  });

  it('computes exp', () => {
    expect(call('exp', 0)).toBe(1);
    expect(call('exp', 1)).toBeCloseTo(Math.E);
  });

  it('returns null for ln of non-positive values', () => {
    expect(call('ln', 1)).toBe(0);
    expect(call('ln', 0)).toBeNull();
    expect(call('ln', -1)).toBeNull();
  });

  it('computes log base b of n, rejecting invalid bases', () => {
    expect(call('log', 10, 100)).toBeCloseTo(2);
    expect(call('log', 1, 100)).toBeNull();  // base 1 is invalid
    expect(call('log', 10, 0)).toBeNull();    // n <= 0
  });
});

describe('math — ceil / floor / trunc', () => {
  it('computes ceil and floor', () => {
    expect(call('ceil', 3.1)).toBe(4);
    expect(call('floor', 3.9)).toBe(3);
    expect(call('ceiling', 3.1)).toBe(4);
  });

  it('trunc truncates toward zero by default', () => {
    expect(call('trunc', 3.9)).toBe(3);
    expect(call('trunc', -3.9)).toBe(-3);
  });

  it('trunc honors a decimals argument', () => {
    expect(call('trunc', 3.14159, 2)).toBeCloseTo(3.14);
  });
});

describe('math — sign / scale / power / cbrt', () => {
  it('computes sign', () => {
    expect(call('sign', 5)).toBe(1);
    expect(call('sign', -5)).toBe(-1);
    expect(call('sign', 0)).toBe(0);
    expect(call('sign', null)).toBeNull();
  });

  it('computes scale (fractional digit count)', () => {
    expect(call('scale', 3.14)).toBe(2);
    expect(call('scale', 3)).toBe(0);
    expect(call('scale', '3.1400')).toBe(4);
  });

  it('computes power and cbrt', () => {
    expect(call('power', 2, 10)).toBe(1024);
    expect(call('cbrt', 27)).toBeCloseTo(3);
    expect(call('cbrt', -8)).toBeCloseTo(-2);
  });
});
