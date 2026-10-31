// P0002-T015 QA_UI — 逐字节证据一致性测试（tests/evidence.spec.ts）。
//
// 反作弊约定：本文件不导入生产 gf256 的 mul / 查表来构造期望值；
// 所有 GF(2^8) 乘法都用独立位移位 + XOR + 0x11D 约简的参考乘法重算，
// XOR 链、Gs×R、恢复字节全部独立复算，绝不"自己证自己"。

import { describe, it, expect } from 'vitest';
import { encode } from '../src/core/encode';
import { decodeSurvivors } from '../src/core/decode';
import {
  explainByte,
  generateAllByteProvenance,
} from '../src/core/evidence';
import type {
  ByteEvidence,
  ByteTerm,
  DecodeInput,
  DecodeResult,
  EncodeResult,
  Matrix,
} from '../src/core/types';

// ---------- 独立参考乘法（bitwise, 0x11D 约简；与生产 log/exp 表无关） ----------
const PRIMITIVE_POLY = 0x11d;
function refMul(a: number, b: number): number {
  let result = 0;
  let aa = a & 0xff;
  let bb = b & 0xff;
  while (bb !== 0) {
    if (bb & 1) result ^= aa;
    aa <<= 1;
    if (aa & 0x100) aa ^= PRIMITIVE_POLY;
    bb >>= 1;
  }
  return result & 0xff;
}

function refMatMul(A: Matrix, B: Matrix): Matrix {
  const out: Matrix = [];
  for (let i = 0; i < A.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < B[0]!.length; j++) {
      let acc = 0;
      for (let p = 0; p < A[0]!.length; p++) {
        acc ^= refMul(A[i]![p]!, B[p]![j]!);
      }
      row.push(acc);
    }
    out.push(row);
  }
  return out;
}

function identity(k: number): Matrix {
  return Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)),
  );
}

function refXorChain(terms: ByteTerm[]): number[] {
  // 独立重算：acc_0 = coef0*byte0；acc_j = acc_{j-1} ^ coefj*bytej
  const chain: number[] = [];
  let acc = 0;
  for (const t of terms) {
    acc ^= refMul(t.coefficient, t.input_byte);
    chain.push(acc);
  }
  return chain;
}

// ---------- 实验构造（DecodeInput 绝不含 original） ----------
function buildDecodeInput(encoded: EncodeResult, survivors: number[]): DecodeInput {
  return {
    k: encoded.k,
    m: encoded.m,
    n: encoded.n,
    originalLen: encoded.original.length,
    paddingLen: encoded.paddingLen,
    shardLen: encoded.shardLen,
    encodingMatrix: encoded.G,
    available: survivors.map((i) => ({ index: i, bytes: encoded.shards[i]!.bytes })),
  };
}

async function runExperimentAsync(
  text: string,
  erased: number[],
): Promise<{ encoded: EncodeResult; decoded: DecodeResult }> {
  const bytes = new TextEncoder().encode(text);
  const encoded = await encode(bytes, 4, 2);
  // DecodeInput 只携带存活片（不含 original）；erased → survivors 补集
  const survivors = [0, 1, 2, 3, 4, 5].filter((i) => !erased.includes(i));
  const decoded = decodeSurvivors(buildDecodeInput(encoded, survivors));
  return { encoded, decoded };
}

const ALL_COMBOS: number[][] = (() => {
  // C(6,4) = 15 个升序存活组合，全枚举。
  const out: number[][] = [];
  for (let a = 0; a < 6; a++)
    for (let b = a + 1; b < 6; b++)
      for (let c = b + 1; c < 6; c++)
        for (let d = c + 1; d < 6; d++) out.push([a, b, c, d]);
  expect(out.length).toBe(15);
  return out;
})();

/** 对单条证据做完全独立复算。 */
function replayEvidence(
  ev: ByteEvidence,
  encoded: EncodeResult,
  decoded: DecodeResult,
  recovered: Uint8Array,
): void {
  const k = decoded.selectedIndices.length;
  expect(ev.terms.length).toBe(k);
  expect(ev.coefficient_row).toEqual(
    (decoded.inverse as Matrix)[ev.data_shard_index],
  );
  expect(ev.offset).toBe(ev.data_shard_index * encoded.shardLen + ev.shard_offset);

  // 每项 product 与 XOR 链独立复算
  const chain = refXorChain(ev.terms);
  ev.terms.forEach((t, j) => {
    expect(t.survivor_index).toBe(decoded.selectedIndices[j]);
    expect(t.product).toBe(refMul(t.coefficient, t.input_byte));
    expect(t.xor_accumulator).toBe(chain[j]);
    // input_byte 必须是真实存活分片在 shard_offset 处的字节
    expect(t.input_byte).toBe(
      encoded.shards[t.survivor_index]!.bytes[ev.shard_offset],
    );
  });
  expect(ev.result_byte).toBe(chain[chain.length - 1]);
  expect(ev.result_byte).toBe(recovered[ev.offset]);
  expect(ev.expected_byte).toBe(encoded.original[ev.offset]);
  expect(ev.equal).toBe(ev.result_byte === ev.expected_byte);
}

// ---------- §12.1 固定样例：ABC，k=4，m=2，擦除 [1,4] ----------
describe('evidence: RS(6,4) ABC erased [1,4] 全偏移证据复算', () => {
  it('对全部 original_len=3 个偏移，terms.length=k 且系数行/乘积/XOR 链/结果字节与独立参考一致', async () => {
    const { encoded, decoded } = await runExperimentAsync('ABC', [1, 4]);
    expect(decoded.recoverable).toBe(true);
    const recovered = decoded.recovered as Uint8Array;
    expect(recovered.length).toBe(3);
    // §12.1 求逆阵（与规格样例核对，非生产自证）
    expect(decoded.selectedIndices).toEqual([0, 2, 3, 5]);
    expect(refMatMul(decoded.Gs as Matrix, decoded.inverse as Matrix)).toEqual(identity(4));

    for (let offset = 0; offset < recovered.length; offset++) {
      const ev = explainByte(encoded, decoded, offset);
      replayEvidence(ev, encoded, decoded, recovered);
    }

    // 具体核对 §12.1/T013 指定样例：offset=1
    const ev1 = explainByte(encoded, decoded, 1);
    expect(ev1.data_shard_index).toBe(1);
    expect(ev1.shard_offset).toBe(0); // shardLen=1，数据片 D1 整片即偏移 1
    expect(ev1.coefficient_row).toEqual([234, 46, 13, 200]);
    expect(ev1.terms.map((t) => t.product)).toEqual([242, 61, 0, 141]);
    expect(ev1.terms.map((t) => t.xor_accumulator)).toEqual([242, 207, 207, 66]);
    expect(ev1.result_byte).toBe(66);
    expect(ev1.expected_byte).toBe(66);
    expect(ev1.equal).toBe(true);
  });

  it('generateAllByteProvenance 的 items.length === original_len', async () => {
    const { encoded, decoded } = await runExperimentAsync('ABC', [1, 4]);
    const result = await generateAllByteProvenance(encoded, decoded);
    expect(result.stale).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.items.length).toBe(encoded.original.length);
    // byte_provenance.length === original_len
    expect(result.items.length).toBe(3);
    const recovered = decoded.recovered as Uint8Array;
    result.items.forEach((ev, i) => {
      expect(ev.offset).toBe(i);
      replayEvidence(ev, encoded, decoded, recovered);
    });
  });
});

// ---------- 15 组存活组合 ----------
describe('evidence: 15 组 C(6,4) 存活组合证据一致性', () => {
  for (const survivors of ALL_COMBOS) {
    const erased = [0, 1, 2, 3, 4, 5].filter((i) => !survivors.includes(i));
    it(`存活 [${survivors.join(',')}]（擦除 [${erased.join(',')}]）全部字节证据重放一致`, async () => {
      const { encoded, decoded } = await runExperimentAsync('ABC', erased);
      expect(decoded.recoverable).toBe(true);
      expect(decoded.selectedIndices).toEqual(survivors);
      // 独立验证 Gs×R=I
      expect(refMatMul(decoded.Gs as Matrix, decoded.inverse as Matrix)).toEqual(identity(4));
      const recovered = decoded.recovered as Uint8Array;
      const result = await generateAllByteProvenance(encoded, decoded, { batchSize: 1 });
      expect(result.items.length).toBe(3);
      result.items.forEach((ev) => replayEvidence(ev, encoded, decoded, recovered));
      // 恢复字节必须是 41 42 43
      expect(Array.from(recovered)).toEqual([0x41, 0x42, 0x43]);
    });
  }
});

// ---------- padding / 空输入 / 失败 / 越界 ----------
describe('evidence: 边界情形', () => {
  it('5 字节输入（padding=3）：证据长度严格 5，且不含填充字节', async () => {
    const { encoded, decoded } = await runExperimentAsync('ABCDE', [1, 4]);
    expect(encoded.shardLen).toBe(2);
    expect(encoded.paddingLen).toBe(3);
    const recovered = decoded.recovered as Uint8Array;
    expect(recovered.length).toBe(5);
    const result = await generateAllByteProvenance(encoded, decoded);
    expect(result.items.length).toBe(5);
    // 所有证据偏移 < 5，且结果字节等于真实原文字节（不含 3 个填充字节）
    result.items.forEach((ev, i) => {
      expect(ev.offset).toBe(i);
      expect(ev.offset).toBeLessThan(5);
      replayEvidence(ev, encoded, decoded, recovered);
      expect(ev.result_byte).toBe(encoded.original[i]);
    });
    expect(Array.from(recovered)).toEqual([0x41, 0x42, 0x43, 0x44, 0x45]);
  });

  it('空输入：证据长度 0', async () => {
    const { encoded, decoded } = await runExperimentAsync('', [1, 4]);
    expect(decoded.recoverable).toBe(true);
    expect((decoded.recovered as Uint8Array).length).toBe(0);
    const result = await generateAllByteProvenance(encoded, decoded);
    expect(result.items.length).toBe(0);
  });

  it('存活不足 k：generateAllByteProvenance 抛错且不产出假证据', async () => {
    const bytes = new TextEncoder().encode('ABC');
    const encoded = await encode(bytes, 4, 2);
    const decoded = decodeSurvivors(
      buildDecodeInput(encoded, [0, 1, 2]), // 3 < k=4
    );
    expect(decoded.recoverable).toBe(false);
    expect(decoded.failureReason).toBe('INSUFFICIENT_SHARDS');
    expect(decoded.recovered).toBeNull();
    expect(decoded.recoveredSha256).toBeNull();
    expect(decoded.Gs).toBeNull();
    expect(decoded.inverse).toBeNull();
    await expect(generateAllByteProvenance(encoded, decoded)).rejects.toThrow();
    expect(() => explainByte(encoded, decoded, 0)).toThrow();
  });

  it('explainByte 越界抛错', async () => {
    const { encoded, decoded } = await runExperimentAsync('ABC', [1, 4]);
    expect(() => explainByte(encoded, decoded, 3)).toThrow(RangeError);
    expect(() => explainByte(encoded, decoded, -1)).toThrow(RangeError);
  });
});
