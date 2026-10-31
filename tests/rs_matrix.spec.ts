// P0002-T008 QA_ALGORITHM test for RS matrix construction, inversion trace, matMul
// Independent oracle: bitwise polynomial multiply (shift + XOR, reduce by 0x11D).
// Matrix products verified with matMul(G_S, R) === I; never trusting the same
// implementation to confirm itself.

import { describe, it, expect } from 'vitest';
import {
  buildVandermonde,
  buildSystematicMatrix,
  invertWithTrace,
  matMul,
} from '../src/core/rs_matrix';
import type { Matrix } from '../src/core/types';

const PRIMITIVE_POLY = 0x11D;

// Independent GF(2^8) oracle (no production log/exp tables).
function polyMul(a: number, b: number): number {
  let result = 0;
  let aa = a & 0xFF;
  let bb = b & 0xFF;
  while (bb !== 0) {
    if (bb & 1) result ^= aa;
    aa <<= 1;
    if (aa & 0x100) aa ^= PRIMITIVE_POLY;
    bb >>= 1;
  }
  return result & 0xFF;
}

// Independent matrix multiply over GF(256) using the oracle only.
function oracleMatMul(A: Matrix, B: Matrix): Matrix {
  const rows = A.length;
  const colsA = A[0]!.length;
  const colsB = B[0]!.length;
  expect(B.length).toBe(colsA);
  const out: Matrix = [];
  for (let i = 0; i < rows; i++) {
    const row: number[] = [];
    for (let j = 0; j < colsB; j++) {
      let acc = 0;
      for (let p = 0; p < colsA; p++) {
        acc ^= polyMul(A[i]![p]!, B[p]![j]!);
      }
      row.push(acc);
    }
    out.push(row);
  }
  return out;
}

function identity(k: number): Matrix {
  const I: Matrix = [];
  for (let i = 0; i < k; i++) {
    const row: number[] = [];
    for (let j = 0; j < k; j++) row.push(i === j ? 1 : 0);
    I.push(row);
  }
  return I;
}

// Expected RS(6,4) systematic matrix, PROJECT_BOOK §12.1 — fixed spec numbers.
const EXPECTED_G: Matrix = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
  [64, 120, 54, 15],
  [231, 210, 87, 99],
];

const EXPECTED_GS: Matrix = [
  [1, 0, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
  [231, 210, 87, 99],
];

const EXPECTED_R: Matrix = [
  [1, 0, 0, 0],
  [234, 46, 13, 200],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
];

function selectRows(G: Matrix, indices: number[]): Matrix {
  return indices.map((i) => G[i]!.slice());
}

function* combinations(arr: number[], k: number, start = 0, prefix: number[] = []): Generator<number[]> {
  if (prefix.length === k) {
    yield prefix.slice();
    return;
  }
  for (let i = start; i <= arr.length - (k - prefix.length); i++) {
    prefix.push(arr[i]!);
    yield* combinations(arr, k, i + 1, prefix);
    prefix.pop();
  }
}

describe('RS matrix (T008 QA_ALGORITHM, PROJECT_BOOK §12.1)', () => {
  it('buildSystematicMatrix(4,2) equals spec G exactly', () => {
    const G = buildSystematicMatrix(4, 2);
    expect(G).toEqual(EXPECTED_G);
  });

  it('G[0:4] is the identity (systematic form)', () => {
    const G = buildSystematicMatrix(4, 2);
    expect(G.slice(0, 4)).toEqual(identity(4));
  });

  it('buildVandermonde(6,4): shape 6x4, first column all 1, row 1 powers of 2', () => {
    const V = buildVandermonde(6, 4);
    expect(V.length).toBe(6);
    for (const row of V) expect(row.length).toBe(4);
    // column 0: 2^(r*0) = 1 for every row
    for (let r = 0; r < 6; r++) {
      expect(V[r]![0]).toBe(1);
    }
    // row 1: [2^0, 2^1, 2^2, 2^3] = [1, 2, 4, 8]
    expect(V[1]).toEqual([1, 2, 4, 8]);
    // row 2: [1, 2^2=4, 2^4=16, 2^6=64]
    expect(V[2]).toEqual([1, 4, 16, 64]);
    // spot-check every entry against the independent oracle (pow(2, r*c))
    for (let r = 0; r < 6; r++) {
      let val = 1;
      for (let c = 0; c < 4; c++) {
        // pow(2, r*c) = repeated multiply by 2^r
        let expected = 1;
        for (let e = 0; e < r * c; e++) expected = polyMul(expected, 2);
        expect(V[r]![c]).toBe(expected);
        val = polyMul(val, 2);
      }
    }
  });

  it('invertWithTrace on G_S for survivors [0,2,3,5] gives spec R with valid trace', () => {
    const G = buildSystematicMatrix(4, 2);
    const GS = selectRows(G, [0, 2, 3, 5]);
    expect(GS).toEqual(EXPECTED_GS);

    const { inverse, steps } = invertWithTrace(GS);
    expect(inverse).toEqual(EXPECTED_R);

    // Independent check: G_S x R = I via the oracle matmul
    expect(oracleMatMul(GS, inverse)).toEqual(identity(4));

    // Trace invariants: seq chain from 0, contiguous
    expect(steps.length).toBeGreaterThan(0);
    for (let i = 0; i < steps.length; i++) {
      expect(steps[i]!.seq).toBe(i);
    }
    // First step's before snapshot is [G_S | I]
    const aug0 = GS.map((row, i) => row.concat(identity(4)[i]!));
    expect(steps[0]!.before).toEqual(aug0);
    // Last step's after snapshot is [I | R]
    const augLast = identity(4).map((row, i) => row.concat(EXPECTED_R[i]!));
    expect(steps[steps.length - 1]!.after).toEqual(augLast);
    // Each snapshot is a full 4x8 augmented matrix
    for (const s of steps) {
      expect(s.before.length).toBe(4);
      expect(s.after.length).toBe(4);
      for (const row of s.before) expect(row.length).toBe(8);
      for (const row of s.after) expect(row.length).toBe(8);
    }
  });

  it('all C(6,4)=15 survivor combinations: matMul(G_S, R) === I (production and oracle)', () => {
    const G = buildSystematicMatrix(4, 2);
    let count = 0;
    for (const combo of combinations([0, 1, 2, 3, 4, 5], 4)) {
      const GS = selectRows(G, combo);
      const { inverse } = invertWithTrace(GS);
      // Production check per spec
      expect(matMul(GS, inverse)).toEqual(identity(4));
      // Independent oracle check
      expect(oracleMatMul(GS, inverse)).toEqual(identity(4));
      count++;
    }
    expect(count).toBe(15);
  });

  it('matMul: dimension mismatch throws; sample product matches oracle', () => {
    const A: Matrix = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    const B: Matrix = [
      [7, 8],
      [9, 10],
    ];
    expect(() => matMul(A, B)).toThrow();

    const C: Matrix = [
      [7, 8],
      [9, 10],
      [11, 12],
    ];
    expect(matMul(A, C)).toEqual(oracleMatMul(A, C));
    // identity is neutral
    expect(matMul(identity(4), EXPECTED_G.slice(0, 4))).toEqual(EXPECTED_G.slice(0, 4));
  });

  it('illegal parameters throw', () => {
    // k = 0
    expect(() => buildVandermonde(6, 0)).toThrow();
    expect(() => buildSystematicMatrix(0, 2)).toThrow();
    // m = 0
    expect(() => buildSystematicMatrix(4, 0)).toThrow();
    // n > 16
    expect(() => buildVandermonde(17, 4)).toThrow();
    expect(() => buildSystematicMatrix(8, 9)).toThrow();
    // k > n
    expect(() => buildVandermonde(3, 5)).toThrow();
    // singular matrix
    expect(() =>
      invertWithTrace([
        [1, 2],
        [1, 2],
      ]),
    ).toThrow('SINGULAR_MATRIX');
    // non-square inversion
    expect(() =>
      invertWithTrace([
        [1, 0, 0],
        [0, 1, 0],
      ]),
    ).toThrow();
  });
});
