// P0002-T022 G7 — C(6,4) 穷举与边界全集（tests/exhaustive.spec.ts）。
//
// 反作弊约定：本文件不导入生产 gf256 的 mul / 查表来构造期望值；
// 所有 GF(2^8) 乘法都用独立位移位 + XOR + 0x11D 约简的参考乘法重算，
// SHA-256 用 node:crypto 独立计算（不走生产 verify 的 subtle 封装），
// 恢复字节、Gs×R、消元轨迹首末帧、逐字节证据全部独立复算，绝不“自己证自己”。
//
// 验收日志约定：每个存活组合打印一行
//   G7 combo survivors=[a,b,c,d] byte_equal=true hash_equal=true proof_replayed=true
// 失败情形打印一行
//   G7 failure survivors=[...] failure_reason=INSUFFICIENT_SHARDS recovered=null
// G7_exhaustive.log 必须包含全部 15 行组合日志。

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { encode } from '../src/core/encode';
import { decodeSurvivors } from '../src/core/decode';
import {
  explainByte,
  generateAllByteProvenance,
} from '../src/core/evidence';
import { verifyDecoded } from '../src/core/verify';
import {
  DEFAULT_SEED,
  generateRandomBytes,
  textToBytes,
} from '../src/features/input/generators';
import type {
  ByteEvidence,
  DecodeInput,
  DecodeResult,
  EncodeResult,
  Matrix,
} from '../src/core/types';

// ---------- 独立参考实现（与生产 log/exp 表无关） ----------
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

function sha256Node(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function concatSideBySide(left: Matrix, right: Matrix): Matrix {
  return left.map((row, i) => [...row, ...right[i]!]);
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

// （注：本文件不再需要 complement 辅助——decode 的 ignoredIndices 是 surplus
// 语义，见 runCombo 内的注释；擦除集由调用方自行掌握，不由 decode 返回。）

// C(6,4) = 15 个升序存活组合，全枚举。
const ALL_COMBOS: number[][] = (() => {
  const out: number[][] = [];
  for (let a = 0; a < 6; a++)
    for (let b = a + 1; b < 6; b++)
      for (let c = b + 1; c < 6; c++)
        for (let d = c + 1; d < 6; d++) out.push([a, b, c, d]);
  expect(out.length).toBe(15);
  return out;
})();

/** 对单条证据做完全独立复算。 */
function replayItem(
  ev: ByteEvidence,
  encoded: EncodeResult,
  decoded: DecodeResult,
  recovered: Uint8Array,
): void {
  const k = decoded.selectedIndices.length;
  expect(ev.terms.length).toBe(k);
  expect(ev.coefficient_row).toEqual((decoded.inverse as Matrix)[ev.data_shard_index]);
  expect(ev.offset).toBe(ev.data_shard_index * encoded.shardLen + ev.shard_offset);
  let acc = 0;
  ev.terms.forEach((t, j) => {
    expect(t.survivor_index).toBe(decoded.selectedIndices[j]);
    expect(t.product).toBe(refMul(t.coefficient, t.input_byte));
    acc ^= refMul(t.coefficient, t.input_byte);
    expect(t.xor_accumulator).toBe(acc);
    // input_byte 必须是真实存活分片在 shard_offset 处的字节
    expect(t.input_byte).toBe(
      encoded.shards[t.survivor_index]!.bytes[ev.shard_offset],
    );
  });
  expect(ev.result_byte).toBe(acc);
  expect(ev.result_byte).toBe(recovered[ev.offset]);
  expect(ev.expected_byte).toBe(encoded.original[ev.offset]);
  expect(ev.equal).toBe(ev.result_byte === ev.expected_byte);
}

/**
 * 对一个存活组合做完整一轮：真正 decode → Gs×R=I → 轨迹首末帧 →
 * 字节相等 + SHA 相等 → 全量证据生成与逐项独立重放 → 打印验收行。
 */
async function runCombo(
  encoded: EncodeResult,
  survivors: number[],
  opts: { replayAll: boolean } = { replayAll: true },
): Promise<void> {
  const decoded: DecodeResult = decodeSurvivors(buildDecodeInput(encoded, survivors));
  expect(decoded.recoverable).toBe(true);
  expect(decoded.failureReason).toBeNull();
  expect(decoded.selectedIndices).toEqual(survivors);
  // ignoredIndices 的语义是“传入的存活片中超出前 k 个的 surplus”，不是擦除集
  // （decode 根本看不到已擦除片）；恰好传入 k 片时 ignored 恒为空。
  expect(decoded.ignoredIndices).toEqual([]);
  expect(decoded.recovered).not.toBeNull();
  const recovered = decoded.recovered as Uint8Array;

  // Gs×R = I（独立参考乘法），轨迹首帧 [Gs|I]、末帧 [I|R]
  expect(decoded.Gs).not.toBeNull();
  expect(decoded.inverse).not.toBeNull();
  expect(refMatMul(decoded.Gs as Matrix, decoded.inverse as Matrix)).toEqual(
    identity(encoded.k),
  );
  expect(decoded.steps.length).toBeGreaterThan(0);
  expect(decoded.steps[0]!.before).toEqual(
    concatSideBySide(decoded.Gs as Matrix, identity(encoded.k)),
  );
  expect(decoded.steps[decoded.steps.length - 1]!.after).toEqual(
    concatSideBySide(identity(encoded.k), decoded.inverse as Matrix),
  );

  // 字节相等 + SHA 相等（SHA 用 node:crypto 独立计算）
  const v = await verifyDecoded(decoded, encoded.original);
  expect(v.byteEqual).toBe(true);
  expect(v.shaEqual).toBe(true);
  expect(v.recoveredSha256).toBe(sha256Node(encoded.original));
  // 逐字节比较（不用 toEqual 直比 Uint8Array：jsdom 环境下 TextEncoder 产物与
  // 模块内 new Uint8Array 属不同 realm，toEqual 会因原型不同而误报）
  expect(Array.from(recovered)).toEqual(Array.from(encoded.original));

  // 全量证据：长度严格等于原文长度，逐项独立重放
  const prov = await generateAllByteProvenance(encoded, decoded);
  expect(prov.stale).toBe(false);
  expect(prov.cancelled).toBe(false);
  expect(prov.items.length).toBe(encoded.original.length);
  expect(prov.items.every((it) => it.equal)).toBe(true);
  if (opts.replayAll) {
    for (const item of prov.items) replayItem(item, encoded, decoded, recovered);
  }
  console.log(
    `G7 combo survivors=[${survivors.join(',')}] byte_equal=${v.byteEqual} ` +
      `hash_equal=${v.shaEqual} proof_replayed=true`,
  );
}

// ---------- §12.1 固定样例锚点 ----------
describe('G7 锚点：RS(6,4) §12.1 固定值', () => {
  it('G、ABC 分片、存活 [0,2,3,5] 的 R 与项目书严格相等', async () => {
    const encoded = await encode(textToBytes('ABC'), 4, 2);
    expect(encoded.G).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
      [64, 120, 54, 15],
      [231, 210, 87, 99],
    ]);
    expect(encoded.shards.map((s) => Array.from(s.bytes))).toEqual([
      [65], [66], [67], [0], [77], [2],
    ]);
    expect(encoded.shardLen).toBe(1);
    expect(encoded.paddingLen).toBe(1);
    const decoded = decodeSurvivors(buildDecodeInput(encoded, [0, 2, 3, 5]));
    expect(decoded.recoverable).toBe(true);
    expect(decoded.inverse).toEqual([
      [1, 0, 0, 0],
      [234, 46, 13, 200],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ]);
    expect(sha256Node(encoded.original)).toBe(
      'b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78',
    );
    // 偏移 1 的证据链与 §5.3 一致（由 explainByte 直接验证）
    const ev = explainByte(encoded, decoded, 1);
    expect(ev.terms.map((t) => t.product)).toEqual([242, 61, 0, 141]);
    expect(ev.terms.map((t) => t.xor_accumulator)).toEqual([242, 207, 207, 66]);
    expect(ev.result_byte).toBe(66);
  });
});

// ---------- C(6,4) 15 组合穷举 ----------
describe('G7 穷举：C(6,4) 全部 15 个存活组合真正 decode', () => {
  it('固定多字节输入：每组逐字节、SHA、全来源证据均过', async () => {
    const input = textToBytes('ShardLens-G7-exhaustive-0123456789');
    const encoded = await encode(input, 4, 2);
    expect(encoded.shardLen).toBeGreaterThan(1); // 多数据片，覆盖多个 data_shard_index
    for (const combo of ALL_COMBOS) {
      await runCombo(encoded, combo);
    }
  }, 120000);

  it('ABC 输入：15 组合全部 byte_equal/hash_equal/proof_replayed', async () => {
    const encoded = await encode(textToBytes('ABC'), 4, 2);
    for (const combo of ALL_COMBOS) {
      await runCombo(encoded, combo);
    }
  });
});

// ---------- 边界全集 ----------
describe('G7 边界：空输入、非整片、仅剩数据片、混合丢失、固定种子、16KiB、少于 k', () => {
  it('空输入：解码往返长度为 0、字节相等', async () => {
    const encoded = await encode(new Uint8Array(0), 4, 2);
    expect(encoded.shardLen).toBe(0);
    expect(encoded.paddingLen).toBe(0);
    const decoded = decodeSurvivors(buildDecodeInput(encoded, [0, 1, 2, 3]));
    expect(decoded.recoverable).toBe(true);
    expect(decoded.recovered?.length).toBe(0);
    const v = await verifyDecoded(decoded, encoded.original);
    expect(v.byteEqual).toBe(true);
    // 空输入无字节可证：证据引擎按设计返回完成态空数组（不产出假证据）
    const prov = await generateAllByteProvenance(encoded, decoded);
    expect(prov.items).toEqual([]);
    expect(prov.stale).toBe(false);
    expect(prov.cancelled).toBe(false);
    console.log('G7 boundary empty_input byte_equal=true proof_items=0');
  });

  it('非整片：5 字节输入 padding=3，证据严格 5 条不含填充', async () => {
    const encoded = await encode(new Uint8Array([1, 2, 3, 4, 5]), 4, 2);
    expect(encoded.shardLen).toBe(2);
    expect(encoded.paddingLen).toBe(3);
    await runCombo(encoded, [0, 2, 3, 5]);
  });

  it('仅剩数据片：擦除全部校验片 [4,5]，R 为单位阵', async () => {
    const encoded = await encode(textToBytes('data-only-survivors'), 4, 2);
    const decoded = decodeSurvivors(buildDecodeInput(encoded, [0, 1, 2, 3]));
    expect(decoded.recoverable).toBe(true);
    expect(decoded.inverse).toEqual(identity(4));
    await runCombo(encoded, [0, 1, 2, 3]);
  });

  it('混合丢失：擦除数据+校验片 [0,4] 与 [2,5] 均可恢复', async () => {
    const encoded = await encode(textToBytes('mixed-loss-cases'), 4, 2);
    await runCombo(encoded, [1, 2, 3, 5]); // 擦除 [0,4]
    await runCombo(encoded, [0, 1, 3, 4]); // 擦除 [2,5]
  });

  it('固定种子：同种子两次生成字节相同，100 字节往返全过', async () => {
    const a = generateRandomBytes(100, DEFAULT_SEED);
    const b = generateRandomBytes(100, DEFAULT_SEED);
    expect(a).toEqual(b);
    const encoded = await encode(a, 4, 2);
    await runCombo(encoded, [0, 2, 3, 5]);
  });

  it('16384 字节边界：全量证据 16384 条，16385 字节被拒绝', async () => {
    const input = generateRandomBytes(16384, DEFAULT_SEED);
    const encoded = await encode(input, 4, 2);
    const decoded = decodeSurvivors(buildDecodeInput(encoded, [0, 2, 3, 5]));
    expect(decoded.recoverable).toBe(true);
    const recovered = decoded.recovered as Uint8Array;
    expect(Array.from(recovered)).toEqual(Array.from(input));
    const v = await verifyDecoded(decoded, input);
    expect(v.byteEqual).toBe(true);
    expect(v.shaEqual).toBe(true);
    const prov = await generateAllByteProvenance(encoded, decoded);
    expect(prov.items.length).toBe(16384);
    expect(prov.items.every((it) => it.equal)).toBe(true);
    // 抽样独立重放：首、尾与固定步长抽点（全量重放成本已由 T019 探针覆盖）
    const sampled = new Set([0, 1, 16383]);
    for (let o = 0; o < 16384; o += 997) sampled.add(o);
    for (const o of sampled) replayItem(prov.items[o]!, encoded, decoded, recovered);
    console.log(
      'G7 boundary 16384_bytes byte_equal=true hash_equal=true proof_items=16384',
    );
    await expect(encode(generateRandomBytes(16385, DEFAULT_SEED), 4, 2)).rejects.toThrow();
  }, 180000);

  it('超量存活：传入 5 片时前 k 片被选、第 5 片进 ignored', async () => {
    const encoded = await encode(textToBytes('ABC'), 4, 2);
    const decoded = decodeSurvivors(buildDecodeInput(encoded, [0, 1, 2, 3, 4]));
    expect(decoded.recoverable).toBe(true);
    expect(decoded.selectedIndices).toEqual([0, 1, 2, 3]);
    expect(decoded.ignoredIndices).toEqual([4]);
    expect(Array.from(decoded.recovered as Uint8Array)).toEqual(
      Array.from(textToBytes('ABC')),
    );
    console.log('G7 boundary oversupply selected=[0,1,2,3] ignored=[4]');
  });

  it('少于 k：存活 3 片触及失败边界，无复原字节', async () => {
    const encoded = await encode(textToBytes('ABC'), 4, 2);
    const decoded = decodeSurvivors(buildDecodeInput(encoded, [0, 1, 2]));
    expect(decoded.recoverable).toBe(false);
    expect(decoded.failureReason).toBe('INSUFFICIENT_SHARDS');
    expect(decoded.recovered).toBeNull();
    expect(decoded.inverse).toBeNull();
    await expect(generateAllByteProvenance(encoded, decoded)).rejects.toThrow();
    console.log(
      'G7 failure survivors=[0,1,2] failure_reason=INSUFFICIENT_SHARDS recovered=null',
    );
  });
});
