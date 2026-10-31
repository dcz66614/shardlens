// P0002 ShardLens — 全字节来源计算引擎（PROJECT_BOOK §8，ALGORITHM_EVIDENCE）。
//
// 反作弊不变式：
// - 求解输入只有 decoded.inverse 的系数行（R = Gs⁻¹）与存活分片在 shard_offset 处的
//   真实字节；encoded.original 只用于事后比对（expected_byte / equal），绝不参与求解。
// - result_byte 必须等于 decoded.recovered[offset]，否则抛错，不得伪造。

import { mul } from './gf256';
import type {
  ByteEvidence,
  ByteTerm,
  DecodeResult,
  EncodeResult,
} from './types';

/** generateAllByteProvenance 的分批选项。 */
export interface ProvenanceOptions {
  /** 每批生成的字节数，默认 256。 */
  batchSize?: number
  /** 取消信号：每批开始前检查；取消后停止且不再生成后续项。 */
  signal?: AbortSignal
  /** 每批完成后的回调（参数为本批生成的证据）。 */
  onBatch?: (batch: ByteEvidence[]) => void
}

/** generateAllByteProvenance 的结果。 */
export interface ProvenanceResult {
  /** 生成的证据；stale 为 true 时为空（结果已丢弃，不覆盖新一轮调用）。 */
  items: ByteEvidence[]
  /** 被新一轮调用作废（陈旧结果）。 */
  stale: boolean
  /** 被 AbortSignal 取消。 */
  cancelled: boolean
}

// 模块级 generation 计数：新一轮 generateAllByteProvenance 开始后，
// 旧调用在下一个批次边界即作废，其结果被丢弃，不得覆盖新结果。
let generationCounter = 0;

function requireInt(v: number, name: string): void {
  if (!Number.isInteger(v)) {
    throw new RangeError(`${name} must be an integer: ${String(v)}`);
  }
}

function fail(decoded: DecodeResult, message: string): never {
  const reason = decoded.failureReason ? ` (${decoded.failureReason})` : '';
  throw new Error(`evidence: ${message}${reason}`);
}

/** 校验解码结果可用于逐字节证据生成，返回 k 与 R。 */
function validateDecoded(decoded: DecodeResult): { k: number; R: number[][] } {
  if (!decoded.recoverable) {
    fail(decoded, 'decoded result is not recoverable');
  }
  if (decoded.inverse === null) {
    fail(decoded, 'inverse matrix is null');
  }
  if (decoded.recovered === null) {
    fail(decoded, 'recovered bytes are null');
  }
  if (decoded.selectedIndices.length !== decoded.inverse[0]?.length) {
    fail(
      decoded,
      `selectedIndices length ${decoded.selectedIndices.length} does not match k`,
    );
  }
  return { k: decoded.selectedIndices.length, R: decoded.inverse };
}

/** 校验编码结果与解码结果相容（同一个实验）。 */
function validateEncoded(
  encoded: EncodeResult,
  decoded: DecodeResult,
  R: number[][],
): void {
  if (!Number.isInteger(encoded.shardLen) || encoded.shardLen <= 0) {
    throw new RangeError(
      `evidence: shardLen must be a positive integer: ${String(encoded.shardLen)}`,
    );
  }
  const k = R.length;
  if (encoded.k !== k) {
    throw new Error(
      `evidence: encoded.k (${encoded.k}) does not match k from decoded (${k})`,
    );
  }
  for (const idx of decoded.selectedIndices) {
    const shard = encoded.shards[idx];
    if (!shard || !(shard.bytes instanceof Uint8Array)) {
      throw new Error(
        `evidence: selected survivor shard ${String(idx)} is missing from encoded.shards`,
      );
    }
    if (shard.bytes.length !== encoded.shardLen) {
      throw new Error(
        `evidence: survivor shard ${String(idx)} length ${shard.bytes.length} != shardLen`,
      );
    }
  }
}

/**
 * 生成单个恢复字节的完整代数来源证据（PROJECT_BOOK §8.1–8.4）。
 *
 * 求解输入：R[data_shard_index] 的系数与存活片真实字节。
 * expected_byte 仅用于事后比对显示。
 */
export function explainByte(
  encoded: EncodeResult,
  decoded: DecodeResult,
  offset: number,
): ByteEvidence {
  requireInt(offset, 'offset');

  const { k, R } = validateDecoded(decoded);
  const recovered = decoded.recovered as Uint8Array;
  const originalLen = recovered.length;

  if (offset < 0 || offset >= originalLen) {
    throw new RangeError(
      `evidence: offset ${offset} out of range [0, ${originalLen})`,
    );
  }
  if (encoded.shardLen <= 0 && originalLen > 0) {
    throw new Error('evidence: shardLen is 0 while original_len > 0');
  }
  validateEncoded(encoded, decoded, R);

  const dataShardIndex = Math.floor(offset / encoded.shardLen);
  const shardOffset = offset % encoded.shardLen;
  if (dataShardIndex >= k) {
    throw new Error(
      `evidence: data_shard_index ${dataShardIndex} out of range for k=${k}`,
    );
  }

  const coefficientRow = R[dataShardIndex]!.slice();

  const terms: ByteTerm[] = [];
  let accumulator = 0;
  for (let j = 0; j < k; j++) {
    const survivorIndex = decoded.selectedIndices[j]!;
    const coefficient = R[dataShardIndex]![j]!;
    const inputByte = encoded.shards[survivorIndex]!.bytes[shardOffset]!;
    const product = mul(coefficient, inputByte);
    accumulator = accumulator ^ product;
    terms.push({
      survivor_index: survivorIndex,
      coefficient,
      input_byte: inputByte,
      product,
      xor_accumulator: accumulator,
    });
  }

  const resultByte = terms.length > 0 ? terms[terms.length - 1]!.xor_accumulator : 0;
  const recoveredByte = recovered[offset]!;
  if (resultByte !== recoveredByte) {
    throw new Error(
      `evidence: recomputed byte ${resultByte} at offset ${offset} does not match ` +
        `recovered byte ${recoveredByte}; refusing to fabricate evidence`,
    );
  }

  const expectedByte = encoded.original[offset]!;
  return {
    offset,
    data_shard_index: dataShardIndex,
    shard_offset: shardOffset,
    coefficient_row: coefficientRow,
    terms,
    result_byte: resultByte,
    expected_byte: expectedByte,
    equal: resultByte === expectedByte,
  };
}

/**
 * 分批遍历 0..original_len-1，生成全部 ByteEvidence（PROJECT_BOOK §8.5）。
 *
 * - batchSize 控制每批字节数（默认 256）；批与批之间让出事件循环，
 *   便于 UI 渲染与取消。
 * - 每批开始前检查 AbortSignal；取消后停止且不再生成后续项。
 * - 模块级 generation 计数：新一轮调用开始后，旧调用后续批次直接作废，
 *   返回结果标明 stale 且丢弃其结果，不让旧结果覆盖新结果。
 * - 空输入返回空数组（完成态）。
 * - 任何失败情形（不可恢复、inverse/recovered 为 null、selectedIndices
 *   长度不等于 k、offset 越界、shard_len 为 0 等）一律抛错，不生成任何
 *   成功字节证据。
 */
export async function generateAllByteProvenance(
  encoded: EncodeResult,
  decoded: DecodeResult,
  options: ProvenanceOptions = {},
): Promise<ProvenanceResult> {
  const generation = ++generationCounter;

  const batchSize =
    options.batchSize === undefined ? 256 : (options.batchSize | 0);
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(
      `evidence: batchSize must be a positive integer: ${String(options.batchSize)}`,
    );
  }

  const { R } = validateDecoded(decoded);
  const recovered = decoded.recovered as Uint8Array;
  const originalLen = recovered.length;

  // 空输入：没有字节需要解释，直接完成态返回空数组（避免除以 shard_len=0）。
  if (originalLen === 0) {
    return { items: [], stale: false, cancelled: false };
  }

  if (encoded.shardLen <= 0) {
    throw new Error('evidence: shardLen is 0 while original_len > 0');
  }
  validateEncoded(encoded, decoded, R);

  const items: ByteEvidence[] = [];

  for (let offset = 0; offset < originalLen; offset += batchSize) {
    // 陈旧检查：新一轮调用已开始，本调用的后续批次全部作废。
    if (generation !== generationCounter) {
      return { items: [], stale: true, cancelled: false };
    }
    // 取消检查：每批开始前；取消后停止且不再生成后续项。
    if (options.signal?.aborted) {
      return { items: [], stale: false, cancelled: true };
    }

    const end = Math.min(offset + batchSize, originalLen);
    const batch: ByteEvidence[] = [];
    for (let p = offset; p < end; p++) {
      batch.push(explainByte(encoded, decoded, p));
    }

    // 批间让出事件循环，之后再次确认本调用仍然是最新的。
    await Promise.resolve();
    if (generation !== generationCounter) {
      return { items: [], stale: true, cancelled: false };
    }
    if (options.signal?.aborted) {
      return { items: [], stale: false, cancelled: true };
    }

    items.push(...batch);
    options.onBatch?.(batch);
  }

  return { items, stale: false, cancelled: false };
}
