/**
 * P0002 ShardLens — 公共 TypeScript 接口契约（PROJECT_BOOK §11）。
 *
 * SPEC_VERSION 1.0.0
 * T002 仅落盘契约本身：类型、接口与函数签名的类型声明。
 * 本文件不包含任何函数体、GF(2^8) 运算、Reed–Solomon 矩阵或编解码逻辑；
 * 算法实现按实施计划分属 src/core/ 下各模块，并必须符合此处签名。
 *
 * 反作弊不变式（PROJECT_BOOK §14）：
 * DecodeInput 只携带存活分片与编码元数据，不得携带 original 或已擦除片备份。
 */

/** 失败原因码（PROJECT_BOOK §9.3）。 */
export type FailureReason =
  | 'INSUFFICIENT_SHARDS'
  | 'SINGULAR_MATRIX'
  | 'INVALID_EXPERIMENT'
  | 'BYTE_MISMATCH'
  | 'HASH_MISMATCH'

/** GF(256) 矩阵，元素均为 0..255 整数。 */
export type Matrix = number[][]

export interface Shard {
  index: number
  label: string
  kind: 'data' | 'parity'
  bytes: Uint8Array
  sha256: string
}

/** GF 高斯-约当消元的单条轨迹，before/after 为完整增广矩阵快照。 */
export interface GFStep {
  seq: number
  op: 'pivot_select' | 'swap' | 'scale' | 'eliminate'
  pivot_col: number
  row_a: number
  row_b: number | null
  factor: number | null
  before: Matrix
  after: Matrix
}

/** 单个字节恢复链中的一项 GF 乘法贡献。 */
export interface ByteTerm {
  survivor_index: number
  coefficient: number
  input_byte: number
  product: number
  xor_accumulator: number
}

/** 单个恢复字节的完整代数来源证据。 */
export interface ByteEvidence {
  offset: number
  data_shard_index: number
  shard_offset: number
  coefficient_row: number[]
  terms: ByteTerm[]
  result_byte: number
  expected_byte: number
  equal: boolean
}

export interface EncodeResult {
  k: number
  m: number
  n: number
  original: Uint8Array
  shardLen: number
  paddingLen: number
  G: Matrix
  shards: Shard[]
}

/** 解码输入：不得携带 original 或 erased 片备份。 */
export interface DecodeInput {
  k: number
  m: number
  n: number
  originalLen: number
  paddingLen: number
  shardLen: number
  encodingMatrix: Matrix
  available: Array<{ index: number; bytes: Uint8Array }>
}

export interface DecodeResult {
  recoverable: boolean
  failureReason: FailureReason | null
  selectedIndices: number[]
  ignoredIndices: number[]
  Gs: Matrix | null
  inverse: Matrix | null
  steps: GFStep[]
  recovered: Uint8Array | null
  byteEqual: boolean
  recoveredSha256: string | null
}

/*
 * 函数签名契约（仅类型声明，无函数体）。
 * 实现归属：buildSystematicMatrix → rs_matrix；encode → encode；
 * decodeSurvivors → decode；recoverExperiment → state/session 适配器；
 * explainByte → evidence。字节比较与 SHA-256 属于 verify，不在本契约内。
 */
export declare function buildSystematicMatrix(k: number, m: number): Matrix
export declare function encode(
  input: Uint8Array,
  k: number,
  m: number,
): Promise<EncodeResult>
export declare function decodeSurvivors(input: DecodeInput): DecodeResult
export declare function recoverExperiment(
  encoded: EncodeResult,
  erased: number[],
): Promise<DecodeResult>
export declare function explainByte(
  encoded: EncodeResult,
  decoded: DecodeResult,
  offset: number,
): ByteEvidence
