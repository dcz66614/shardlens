// P0002-T008 QA_ALGORITHM test for decodeSurvivors()
// SEPARATION IS MANDATORY: the original bytes are NEVER passed to
// decodeSurvivors. DecodeInput is built only from encode() output shards and
// metadata; the original text is compared to recovered ONLY after decode
// returns (via verifyRecovered/verifyDecoded or direct comparison).

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { encode } from '../src/core/encode';
import { decodeSurvivors } from '../src/core/decode';
import { verifyRecovered, verifyDecoded } from '../src/core/verify';
import type { DecodeInput, EncodeResult, Matrix } from '../src/core/types';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_SHA256 = 'b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78';

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

// Independent GF(2^8) oracle (bitwise polynomial multiply, reduce by 0x11D).
const PRIMITIVE_POLY = 0x11D;
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

function oracleMatMul(A: Matrix, B: Matrix): Matrix {
  const out: Matrix = [];
  for (let i = 0; i < A.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < B[0]!.length; j++) {
      let acc = 0;
      for (let p = 0; p < A[0]!.length; p++) {
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

// Build a DecodeInput from an EncodeResult and a survivor index set.
// The original bytes are NOT included (anti-cheat invariant, PROJECT_BOOK §14).
function buildDecodeInput(encoded: EncodeResult, survivors: number[]): DecodeInput {
  return {
    k: encoded.k,
    m: encoded.m,
    n: encoded.n,
    originalLen: encoded.original.length,
    paddingLen: encoded.paddingLen,
    shardLen: encoded.shardLen,
    encodingMatrix: encoded.G,
    available: survivors.map((i) => ({
      index: i,
      bytes: new Uint8Array(encoded.shards[i]!.bytes),
    })),
  };
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

describe('decodeSurvivors (T008 QA_ALGORITHM, encode/decode separation)', () => {
  it('T-06 / §12.1: erase [1,4], survivors [0,2,3,5] recover ABC with exact G_S and R', async () => {
    const abc = new Uint8Array([65, 66, 67]);
    const encoded = await encode(abc, 4, 2);
    const input = buildDecodeInput(encoded, [0, 2, 3, 5]);
    const res = decodeSurvivors(input);

    expect(res.recoverable).toBe(true);
    expect(res.failureReason).toBeNull();
    expect(res.selectedIndices).toEqual([0, 2, 3, 5]);
    expect(res.ignoredIndices).toEqual([]);
    expect(res.Gs).toEqual(EXPECTED_GS);
    expect(res.inverse).toEqual(EXPECTED_R);

    // Independent matrix check: G_S x R = I
    expect(oracleMatMul(EXPECTED_GS, res.inverse!)).toEqual(identity(4));

    // Compare to original ONLY after decode returned
    expect(res.recovered).not.toBeNull();
    expect(Array.from(res.recovered!)).toEqual([65, 66, 67]);
    const v = await verifyDecoded(res, abc);
    expect(v.byteEqual).toBe(true);
    expect(v.shaEqual).toBe(true);
    expect(v.recoveredSha256).toBe(ABC_SHA256);
    expect(v.recoveredSha256).toBe(sha256Hex(abc));
  });

  it('T-01: all C(6,4)=15 survivor combinations recover byte-identically with equal SHA-256', async () => {
    const abc = new Uint8Array([65, 66, 67]);
    const encoded = await encode(abc, 4, 2);
    let count = 0;
    for (const combo of combinations([0, 1, 2, 3, 4, 5], 4)) {
      const res = decodeSurvivors(buildDecodeInput(encoded, combo));
      expect(res.recoverable).toBe(true);
      expect(res.Gs).not.toBeNull();
      expect(res.inverse).not.toBeNull();
      // Independent check: G_S x R = I for this combination
      expect(oracleMatMul(res.Gs!, res.inverse!)).toEqual(identity(4));
      expect(Array.from(res.recovered!)).toEqual([65, 66, 67]);
      const v = await verifyDecoded(res, abc);
      expect(v.byteEqual).toBe(true);
      expect(v.shaEqual).toBe(true);
      expect(v.recoveredSha256).toBe(ABC_SHA256);
      count++;
    }
    expect(count).toBe(15);
  });

  it('T-02: fewer than k survivors -> INSUFFICIENT_SHARDS, recovered=null, inverse=null', async () => {
    const abc = new Uint8Array([65, 66, 67]);
    const encoded = await encode(abc, 4, 2);
    const res = decodeSurvivors(buildDecodeInput(encoded, [0, 2, 5]));
    expect(res.recoverable).toBe(false);
    expect(res.failureReason).toBe('INSUFFICIENT_SHARDS');
    expect(res.recovered).toBeNull();
    expect(res.inverse).toBeNull();
    expect(res.Gs).toBeNull();
    expect(res.steps).toEqual([]);
    expect(res.selectedIndices).toEqual([]);
    expect(res.ignoredIndices).toEqual([0, 2, 5]);
    expect(res.byteEqual).toBe(false);
    expect(res.recoveredSha256).toBeNull();
    const v = await verifyDecoded(res, abc);
    expect(v.byteEqual).toBe(false);
    expect(v.recoveredSha256).toBeNull();
  });

  it('T-03: empty input recovers empty Uint8Array with empty SHA-256', async () => {
    const empty = new Uint8Array(0);
    const encoded = await encode(empty, 4, 2);
    const res = decodeSurvivors(buildDecodeInput(encoded, [0, 2, 3, 5]));
    expect(res.recoverable).toBe(true);
    expect(res.recovered).not.toBeNull();
    expect(res.recovered!.length).toBe(0);
    const v = await verifyRecovered(res.recovered!, empty);
    expect(v.byteEqual).toBe(true);
    expect(v.shaEqual).toBe(true);
    expect(v.recoveredSha256).toBe(EMPTY_SHA256);
  });

  it('T-04: 5-byte input recovers exactly 5 bytes (padding excluded)', async () => {
    const five = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = await encode(five, 4, 2);
    expect(encoded.shardLen).toBe(2);
    expect(encoded.paddingLen).toBe(3);
    const res = decodeSurvivors(buildDecodeInput(encoded, [0, 2, 3, 5]));
    expect(res.recoverable).toBe(true);
    expect(res.recovered!.length).toBe(5);
    expect(Array.from(res.recovered!)).toEqual([1, 2, 3, 4, 5]);
    const v = await verifyDecoded(res, five);
    expect(v.byteEqual).toBe(true);
    expect(v.shaEqual).toBe(true);
  });

  it('T-05: erasing only parity [4,5] still goes through the matrix path and recovers identically', async () => {
    const abc = new Uint8Array([65, 66, 67]);
    const encoded = await encode(abc, 4, 2);
    const res = decodeSurvivors(buildDecodeInput(encoded, [0, 1, 2, 3]));
    expect(res.recoverable).toBe(true);
    expect(res.selectedIndices).toEqual([0, 1, 2, 3]);
    // Matrix path: G_S is the identity, its inverse the identity, steps produced
    expect(res.Gs).toEqual(identity(4));
    expect(res.inverse).toEqual(identity(4));
    expect(res.steps.length).toBeGreaterThan(0);
    expect(oracleMatMul(res.Gs!, res.inverse!)).toEqual(identity(4));
    expect(Array.from(res.recovered!)).toEqual([65, 66, 67]);
    const v = await verifyDecoded(res, abc);
    expect(v.byteEqual).toBe(true);
    expect(v.shaEqual).toBe(true);
    expect(v.recoveredSha256).toBe(ABC_SHA256);
  });

  it('extra survivors beyond k: first k (sorted) selected, rest ignored', async () => {
    const abc = new Uint8Array([65, 66, 67]);
    const encoded = await encode(abc, 4, 2);
    const res = decodeSurvivors(buildDecodeInput(encoded, [0, 1, 2, 3, 4, 5]));
    expect(res.recoverable).toBe(true);
    expect(res.selectedIndices).toEqual([0, 1, 2, 3]);
    expect(res.ignoredIndices).toEqual([4, 5]);
    expect(Array.from(res.recovered!)).toEqual([65, 66, 67]);
  });

  it('T-09/T-10 style: invalid experiment inputs yield INVALID_EXPERIMENT (as implemented)', async () => {
    const abc = new Uint8Array([65, 66, 67]);
    const encoded = await encode(abc, 4, 2);
    const base = buildDecodeInput(encoded, [0, 2, 3, 5]);

    // duplicate survivor index
    const dup = decodeSurvivors({
      ...base,
      available: [
        { index: 0, bytes: new Uint8Array(1) },
        { index: 0, bytes: new Uint8Array(1) },
        { index: 2, bytes: new Uint8Array(1) },
        { index: 3, bytes: new Uint8Array(1) },
      ],
    });
    expect(dup.recoverable).toBe(false);
    expect(dup.failureReason).toBe('INVALID_EXPERIMENT');
    expect(dup.recovered).toBeNull();
    expect(dup.inverse).toBeNull();

    // survivor index out of range
    const oob = decodeSurvivors({
      ...base,
      available: [{ index: 6, bytes: new Uint8Array(1) }],
    });
    expect(oob.recoverable).toBe(false);
    expect(oob.failureReason).toBe('INVALID_EXPERIMENT');

    // shard bytes of wrong length
    const wrongLen = decodeSurvivors({
      ...base,
      available: [
        { index: 0, bytes: new Uint8Array(2) },
        { index: 2, bytes: new Uint8Array(1) },
        { index: 3, bytes: new Uint8Array(1) },
        { index: 5, bytes: new Uint8Array(1) },
      ],
    });
    expect(wrongLen.recoverable).toBe(false);
    expect(wrongLen.failureReason).toBe('INVALID_EXPERIMENT');

    // encodingMatrix wrong shape (tampered, T-10)
    const badMatrix = decodeSurvivors({ ...base, encodingMatrix: [[1, 0], [0, 1]] });
    expect(badMatrix.recoverable).toBe(false);
    expect(badMatrix.failureReason).toBe('INVALID_EXPERIMENT');

    // n inconsistent with k + m
    const badN = decodeSurvivors({ ...base, n: 5 });
    expect(badN.recoverable).toBe(false);
    expect(badN.failureReason).toBe('INVALID_EXPERIMENT');

    // non-array available
    const badAvail = decodeSurvivors({ ...base, available: null as unknown as [] });
    expect(badAvail.recoverable).toBe(false);
    expect(badAvail.failureReason).toBe('INVALID_EXPERIMENT');
  });
});
