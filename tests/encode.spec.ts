// P0002-T008 QA_ALGORITHM test for encode()
// Spec numbers from PROJECT_BOOK §12.1 / §12.2 are asserted verbatim; SHA-256
// expectations are recomputed independently via node:crypto.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { encode } from '../src/core/encode';
import { buildSystematicMatrix } from '../src/core/rs_matrix';
import type { Matrix } from '../src/core/types';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const EXPECTED_G: Matrix = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
  [64, 120, 54, 15],
  [231, 210, 87, 99],
];

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// Deterministic seeded LCG (T-07 style generator used for determinism checks).
function lcgBytes(seed: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let state = seed >>> 0;
  for (let i = 0; i < len; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 16) & 0xFF;
  }
  return out;
}

describe('encode (T008 QA_ALGORITHM)', () => {
  it('ABC with k=4,m=2: exact spec shards [65,66,67,0,77,2], lens, sha256 (§12.1)', async () => {
    const res = await encode(new Uint8Array([65, 66, 67]), 4, 2);
    expect(res.k).toBe(4);
    expect(res.m).toBe(2);
    expect(res.n).toBe(6);
    expect(res.shardLen).toBe(1);
    expect(res.paddingLen).toBe(1);
    expect(res.shards.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(res.shards[i]!.bytes.length).toBe(1);
      expect(res.shards[i]!.bytes[0]).toBe([65, 66, 67, 0, 77, 2][i]);
      expect(res.shards[i]!.index).toBe(i);
      // SHA-256 recomputed independently via node:crypto
      expect(res.shards[i]!.sha256).toBe(sha256Hex(res.shards[i]!.bytes));
    }
    expect(res.shards[0]!.kind).toBe('data');
    expect(res.shards[0]!.label).toBe('D0');
    expect(res.shards[4]!.kind).toBe('parity');
    expect(res.shards[4]!.label).toBe('P0');
  });

  it('EncodeResult.G equals buildSystematicMatrix and spec G', async () => {
    const res = await encode(new Uint8Array([65, 66, 67]), 4, 2);
    expect(res.G).toEqual(EXPECTED_G);
    expect(res.G).toEqual(buildSystematicMatrix(4, 2));
  });

  it('empty input: shardLen=0, paddingLen=0, all shards length 0, empty SHA-256 (T-03)', async () => {
    const res = await encode(new Uint8Array(0), 4, 2);
    expect(res.shardLen).toBe(0);
    expect(res.paddingLen).toBe(0);
    for (const s of res.shards) {
      expect(s.bytes.length).toBe(0);
      expect(s.sha256).toBe(EMPTY_SHA256);
      expect(s.sha256).toBe(sha256Hex(new Uint8Array(0)));
    }
  });

  it('5-byte input with k=4: shardLen=2, paddingLen=3, data shards [[1,2],[3,4],[5,0],[0,0]] (T-04)', async () => {
    const res = await encode(new Uint8Array([1, 2, 3, 4, 5]), 4, 2);
    expect(res.shardLen).toBe(2);
    expect(res.paddingLen).toBe(3);
    const expectedData = [
      [1, 2],
      [3, 4],
      [5, 0],
      [0, 0],
    ];
    for (let i = 0; i < 4; i++) {
      expect(Array.from(res.shards[i]!.bytes)).toEqual(expectedData[i]);
      expect(res.shards[i]!.sha256).toBe(sha256Hex(res.shards[i]!.bytes));
    }
    for (let i = 4; i < 6; i++) {
      expect(res.shards[i]!.bytes.length).toBe(2);
      expect(res.shards[i]!.sha256).toBe(sha256Hex(res.shards[i]!.bytes));
    }
  });

  it('16384 bytes passes (T-08), 16385 bytes throws (T-09)', async () => {
    const ok = await encode(lcgBytes(0xC0FFEE11, 16384), 4, 2);
    expect(ok.original.length).toBe(16384);
    expect(ok.shardLen).toBe(4096);
    expect(ok.paddingLen).toBe(0);
    for (const s of ok.shards) {
      expect(s.bytes.length).toBe(4096);
    }
    await expect(encode(lcgBytes(0xC0FFEE11, 16385), 4, 2)).rejects.toThrow(RangeError);
  });

  it('same-seed LCG output is deterministic across runs (T-07)', async () => {
    const a = await encode(lcgBytes(0xC0FFEE11, 4096), 4, 2);
    const b = await encode(lcgBytes(0xC0FFEE11, 4096), 4, 2);
    expect(a.shards.map((s) => s.sha256)).toEqual(b.shards.map((s) => s.sha256));
    for (let i = 0; i < 6; i++) {
      expect(Array.from(a.shards[i]!.bytes)).toEqual(Array.from(b.shards[i]!.bytes));
    }
    expect(a.G).toEqual(b.G);
  });

  it('illegal k/m throw (T-09): k=0, m=0, k+m>16', async () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    await expect(encode(input, 0, 2)).rejects.toThrow(RangeError);
    await expect(encode(input, 4, 0)).rejects.toThrow(RangeError);
    await expect(encode(input, 8, 9)).rejects.toThrow(RangeError);
  });
});
