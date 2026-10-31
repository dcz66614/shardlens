// P0002-T004 QA_ALGORITHM test for GF(2^8) arithmetic
// Reference implementation is INDEPENDENT (bitwise polynomial multiply + reduce by 0x11D)
// No use of production EXP_TABLE/LOG_TABLE; no use of production mul to compute expected values.

import { describe, it, expect } from 'vitest';
import { add, mul, div, inv, pow } from '../src/core/gf256';

const PRIMITIVE_POLY = 0x11D;

// Independent oracle: polynomial multiplication over GF(2) (shift + XOR)
// then reduce modulo primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
function polyMul(a: number, b: number): number {
  let result = 0;
  let aa = a & 0xFF;
  let bb = b & 0xFF;
  while (bb !== 0) {
    if (bb & 1) {
      result ^= aa;
    }
    aa <<= 1;
    if (aa & 0x100) {
      aa ^= PRIMITIVE_POLY;
    }
    bb >>= 1;
  }
  return result & 0xFF;
}

describe('GF(2^8) arithmetic (T004 QA_ALGORITHM)', () => {
  it('add: basic properties and XOR equivalence (sample)', () => {
    expect(add(0, 0)).toBe(0);
    expect(add(5, 5)).toBe(0);
    expect(add(42, 0)).toBe(42);
    expect(add(0, 123)).toBe(123);
    // XOR equivalence for sampled pairs
    for (let a = 0; a < 256; a += 17) {
      for (let b = 0; b < 256; b += 23) {
        expect(add(a, b)).toBe(a ^ b);
      }
    }
  });

  it('mul: exhaustive 256x256 against independent polynomial oracle', () => {
    let count = 0;
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        const got = mul(a, b);
        const expected = polyMul(a, b);
        expect(got).toBe(expected);
        count++;
      }
    }
    expect(count).toBe(65536);
  });

  it('mul/div: zero paths and full ring properties', () => {
    // explicit zero paths
    for (let b = 0; b < 256; b++) {
      expect(mul(0, b)).toBe(0);
    }
    for (let a = 0; a < 256; a++) {
      expect(mul(a, 0)).toBe(0);
    }
    // div(mul(a,b), b) === a for all a, all b != 0
    for (let a = 0; a < 256; a++) {
      for (let b = 1; b < 256; b++) {
        const prod = polyMul(a, b); // use oracle for product construction
        expect(div(prod, b)).toBe(a);
      }
    }
    // mul(div(a,b), b) === a for all a, all b != 0 (verify div correct via multiply)
    for (let a = 0; a < 256; a++) {
      for (let b = 1; b < 256; b++) {
        const dab = div(a, b);
        expect(polyMul(dab, b)).toBe(a);
      }
    }
    // boundary cases
    for (let b = 1; b < 256; b++) {
      expect(div(0, b)).toBe(0);
      expect(div(5, 1)).toBe(5);
    }
    for (let a = 1; a < 256; a++) {
      expect(div(a, a)).toBe(1);
    }
  });

  it('div: throws on zero divisor with GF_DIV_ZERO', () => {
    expect(() => div(5, 0)).toThrow();
    try {
      div(5, 0);
    } catch (e: any) {
      expect(String(e.message)).toContain('GF_DIV_ZERO');
    }
  });

  it('inv: properties for all nonzero and error cases', () => {
    expect(inv(1)).toBe(1);
    for (let a = 1; a < 256; a++) {
      const ia = inv(a);
      expect(polyMul(a, ia)).toBe(1);
    }
  });

  it('inv: throws on zero with GF_INV_ZERO', () => {
    expect(() => inv(0)).toThrow();
    try {
      inv(0);
    } catch (e: any) {
      expect(String(e.message)).toContain('GF_INV_ZERO');
    }
  });

  it('pow: base cases and generator traversal', () => {
    // pow(a,0) === 1 for all a including 0
    for (let a = 0; a < 256; a++) {
      expect(pow(a, 0)).toBe(1);
    }
    // pow(0,e)>0 === 0
    for (let e = 1; e < 20; e++) {
      expect(pow(0, e)).toBe(0);
    }
    // pow(a,1) === a
    for (let a = 0; a < 256; a++) {
      expect(pow(a, 1)).toBe(a);
    }
    // pow(a,2) === mul(a,a) as consistency check only
    for (let a = 0; a < 256; a++) {
      expect(pow(a, 2)).toBe(polyMul(a, a));
    }
    // main assertions via oracle
    expect(pow(2, 8)).toBe(0x1D);
    // pow(2,255) should be 1
    expect(pow(2, 255)).toBe(1);
    // generator 2 traverses all 255 nonzero elements via oracle multiplication then back to 1
    const seen = new Set<number>();
    let val = 1;
    for (let i = 0; i < 255; i++) {
      val = polyMul(val, 2);
      seen.add(val);
    }
    expect(seen.size).toBe(255);
    expect(val).toBe(1); // back to 1
  });

  it('range errors: out of bounds and bad types for all functions', () => {
    const bad = [-1, 256, 1.5, NaN];
    for (const v of bad) {
      expect(() => add(v as any, 1)).toThrow(RangeError);
      expect(() => add(1, v as any)).toThrow(RangeError);
      expect(() => mul(v as any, 1)).toThrow(RangeError);
      expect(() => mul(1, v as any)).toThrow(RangeError);
      expect(() => div(v as any, 1)).toThrow(RangeError);
      expect(() => div(1, v as any)).toThrow(RangeError);
      expect(() => inv(v as any)).toThrow(RangeError);
      expect(() => pow(v as any, 1)).toThrow(RangeError);
    }
  });

  it('pow: negative and non-integer exponents throw RangeError', () => {
    expect(() => pow(2, -1)).toThrow(RangeError);
    expect(() => pow(2, 1.5)).toThrow(RangeError);
    expect(() => pow(2, NaN)).toThrow(RangeError);
    expect(() => pow(0, -5)).toThrow(RangeError);
  });
});
