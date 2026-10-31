/**
 * P0002 ShardLens — 完整实验文件 `.shardlens.json` 导出器（PROJECT_BOOK §9，T019）。
 *
 * 本文件含 export（T019）与 import（T020）两部分。
 *
 * 反作弊不变式：
 * - 导出内容全部来自当次真实编码/解码结果：G 由 buildSystematicMatrix 重算核对，
 *   分片 SHA 由 subtle 逐片重算核对，逐字节证据由 generateAllByteProvenance 全量生成，
 *   导出后复核 byte_provenance.length === original_len，任何不一致都抛错，绝不截断、
 *   绝不补假数据。
 * - 求解输入只用存活片：本模块不读取已擦除片参与求解；shards[].data_base64 是当次
 *   编码快照（§9.1 明确允许保留），调用方与导入方必须先按 erased_indices 过滤。
 * - 失败时按 §9.1 置空：recovery_matrix/recovery_submatrix/gauss_jordan_initial_augmented
 *   为 null，gauss_jordan_steps/byte_provenance 为 []，recovered_payload_base64/
 *   recovered_sha256 为 null，selected_survivor_indices 为 []。
 */

import { buildSystematicMatrix } from '../core/rs_matrix'
import { encode } from '../core/encode'
import { decodeSurvivors } from '../core/decode'
import { generateAllByteProvenance } from '../core/evidence'
import { generateRandomBytes } from '../features/input/generators'
import type {
  ByteEvidence,
  DecodeInput,
  DecodeResult,
  EncodeResult,
  FailureReason,
  GFStep,
  Matrix,
} from '../core/types'

/** §9.1 顶层强制字段（全部不得省略）。 */
export interface ShardLensFile {
  spec_version: '1.0.0'
  slug: 'shardlens'
  experiment_id: string
  input_mode: 'utf8' | 'seeded_random'
  input_text: string | null
  random_seed: number | null
  k: number
  m: number
  n: number
  shard_len: number
  original_len: number
  padding_len: number
  encoding_matrix: Matrix
  shards: Array<{
    index: number
    label: string
    kind: 'data' | 'parity'
    data_base64: string
    sha256: string
  }>
  erased_indices: number[]
  surviving_indices: number[]
  selected_survivor_indices: number[]
  ignored_survivor_indices: number[]
  recovery_submatrix: Matrix | null
  recovery_matrix: Matrix | null
  gauss_jordan_initial_augmented: Matrix | null
  gauss_jordan_steps: GFStep[]
  byte_provenance: ByteEvidence[]
  original_payload_base64: string
  recovered_payload_base64: string | null
  original_sha256: string
  recovered_sha256: string | null
  byte_equal: boolean
  recoverable: boolean
  failure_reason: FailureReason | null
  failure_reason_detail: string | null
  verification: {
    byte_checked_count: number
    first_mismatch_offset: number | null
    hash_equal: boolean
  }
  comparison_id: string | null
}

/** exportExperiment 的输入：当次真实实验结果 + 展示层元数据。 */
export interface ExperimentExportInput {
  encoded: EncodeResult
  /** 只用存活片解码得到的 DecodeResult（decode 本身不含原文）。 */
  decoded: DecodeResult
  /** 升序擦除索引（全局分片索引）；须与 surviving 互补。 */
  erasedIndices: number[]
  input_mode: 'utf8' | 'seeded_random'
  /** utf8 模式为原文字符串（可为空串），随机模式为 null。 */
  input_text: string | null
  /** 随机模式为无符号整数，文本模式为 null。 */
  random_seed: number | null
  /** 未提供时自动生成本地非敏感标识。 */
  experiment_id?: string
  /** P1 反事实配对的可选标识，未提供为 null。 */
  comparison_id?: string | null
  /** 失败时的补充说明，未提供为 null。 */
  failure_reason_detail?: string | null
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Encode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out += BASE64_ALPHABET[b0 >> 2]
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : '='
  }
  return out
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes as unknown as BufferSource,
  )
  const view = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, '0')
  }
  return hex
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

function isByteValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
}

function failExport(message: string): never {
  throw new Error(`export: ${message}`)
}

function sortedCopy(values: number[]): number[] {
  return values.slice().sort((a, b) => a - b)
}

function sameNumbers(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function sameMatrix(a: Matrix, b: Matrix): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!sameNumbers(a[i]!, b[i]!)) return false
  }
  return true
}

function cloneMatrix(m: Matrix): Matrix {
  return m.map((row) => row.slice())
}

/** 严格扩展名：主实验文件后缀固定 `.shardlens.json`。 */
export function assertShardlensFileName(name: string): void {
  if (
    typeof name !== 'string' ||
    !name.endsWith('.shardlens.json') ||
    name.length <= '.shardlens.json'.length
  ) {
    failExport(
      `file name must end with .shardlens.json and have a non-empty stem, got ${JSON.stringify(name)}`,
    )
  }
}

/** 由 experiment_id 生成主实验文件名（严格扩展名）。 */
export function buildExperimentFileName(experimentId: string): string {
  if (typeof experimentId !== 'string' || experimentId.length === 0) {
    failExport('experiment_id must be a non-empty string')
  }
  const name = `${experimentId}.shardlens.json`
  assertShardlensFileName(name)
  return name
}

/**
 * 导出完整实验文件（PROJECT_BOOK §9.1/§9.5）。
 *
 * 一致性校验（任一失败即抛错，绝不导出半真文件）：
 * - k/m/n 范围与长度方程（§6.1）；
 * - G 等于重算的系统型矩阵；
 * - 每片 SHA 等于 subtle 重算值；
 * - erased/surviving 互补分区；
 * - 可恢复时 selected/ignored 与存活集一致、Gs/逆阵/轨迹首帧为 [Gs|I]；
 * - utf8 模式的 input_text 编码后等于原文；
 * - 成功时 byte_provenance 全量生成且长度严格等于 original_len。
 */
export async function exportExperiment(
  input: ExperimentExportInput,
): Promise<ShardLensFile> {
  const { encoded, decoded, erasedIndices } = input
  const { k, m, n, shardLen, paddingLen, G, shards } = encoded
  const original = encoded.original
  const originalLen = original.length

  if (!isInteger(k) || !isInteger(m) || !isInteger(n)) {
    failExport('k/m/n must be integers')
  }
  if (k < 1 || m < 1 || k + m > 16 || n !== k + m) {
    failExport(`invalid k/m/n: k=${k}, m=${m}, n=${n}`)
  }
  if (!isInteger(originalLen) || originalLen < 0 || originalLen > 16384) {
    failExport(`invalid original_len: ${originalLen}`)
  }
  if (!isInteger(shardLen) || shardLen < 0) {
    failExport(`invalid shard_len: ${shardLen}`)
  }
  if (originalLen > k * shardLen || paddingLen !== k * shardLen - originalLen) {
    failExport(
      `length equation violated: original_len=${originalLen}, k*shard_len=${k * shardLen}, padding_len=${paddingLen}`,
    )
  }
  if (originalLen > 0 && shardLen === 0) {
    failExport('shard_len is 0 while original_len > 0')
  }
  if (shards.length !== n) {
    failExport(`shards length ${shards.length} != n ${n}`)
  }
  for (let i = 0; i < n; i++) {
    const shard = shards[i]!
    const wantLabel = i < k ? `D${i}` : `P${i - k}`
    const wantKind = i < k ? 'data' : 'parity'
    if (
      shard.index !== i ||
      shard.label !== wantLabel ||
      shard.kind !== wantKind ||
      !(shard.bytes instanceof Uint8Array) ||
      shard.bytes.length !== shardLen
    ) {
      failExport(`shard ${i} does not match D/P naming or shard_len`)
    }
    const recomputed = await sha256Hex(shard.bytes)
    if (recomputed !== shard.sha256) {
      failExport(`shard ${i} sha256 mismatch: snapshot is stale or corrupted`)
    }
  }

  // G 必须等于重算的系统型矩阵。
  let expectedG: Matrix
  try {
    expectedG = buildSystematicMatrix(k, m)
  } catch {
    failExport('cannot recompute systematic matrix for k/m')
  }
  if (G.length !== n || !sameMatrix(G, expectedG!)) {
    failExport('encoding_matrix does not equal recomputed systematic G')
  }

  // erased/surviving 互补分区（升序、无重复、无遗漏）。
  if (!Array.isArray(erasedIndices)) failExport('erasedIndices must be an array')
  const erasedSorted = sortedCopy(erasedIndices)
  if (!sameNumbers(erasedSorted, erasedIndices)) {
    failExport('erasedIndices must be ascending without duplicates')
  }
  const erasedSet = new Set<number>()
  for (const idx of erasedIndices) {
    if (!isInteger(idx) || idx < 0 || idx > n - 1) {
      failExport(`erased index out of range: ${idx}`)
    }
    erasedSet.add(idx)
  }
  if (erasedSet.size !== erasedIndices.length) {
    failExport('erasedIndices contain duplicates')
  }
  const surviving: number[] = []
  for (let i = 0; i < n; i++) {
    if (!erasedSet.has(i)) surviving.push(i)
  }

  // input_mode / input_text / random_seed 一致性。
  if (input.input_mode !== 'utf8' && input.input_mode !== 'seeded_random') {
    failExport(`invalid input_mode: ${String(input.input_mode)}`)
  }
  if (input.input_mode === 'utf8') {
    if (typeof input.input_text !== 'string' || input.random_seed !== null) {
      failExport('utf8 mode requires input_text string and random_seed null')
    }
    const textBytes = new TextEncoder().encode(input.input_text)
    if (
      textBytes.length !== originalLen ||
      !textBytes.every((b, i) => b === original[i])
    ) {
      failExport('input_text does not match original payload bytes')
    }
  } else {
    if (
      input.input_text !== null ||
      !isInteger(input.random_seed) ||
      (input.random_seed as number) < 0 ||
      (input.random_seed as number) > 0xffffffff
    ) {
      failExport('seeded_random mode requires input_text null and uint32 random_seed')
    }
  }

  const experimentId =
    input.experiment_id !== undefined && input.experiment_id !== ''
      ? input.experiment_id
      : `exp-${Date.now()}`
  if (typeof experimentId !== 'string' || experimentId.length === 0) {
    failExport('experiment_id must be a non-empty string')
  }

  const originalSha256 = await sha256Hex(original)
  const originalPayloadBase64 = base64Encode(original)

  let recoverySubmatrix: Matrix | null = null
  let recoveryMatrix: Matrix | null = null
  let initialAugmented: Matrix | null = null
  let steps: GFStep[] = []
  let provenance: ByteEvidence[] = []
  let selected: number[] = []
  let ignored: number[] = []
  let recoveredPayloadBase64: string | null = null
  let recoveredSha256: string | null = null
  let byteEqual = false
  let failureReason: FailureReason | null = null
  let verification: ShardLensFile['verification'] = {
    byte_checked_count: 0,
    first_mismatch_offset: null,
    hash_equal: false,
  }

  if (decoded.recoverable) {
    if (decoded.inverse === null || decoded.Gs === null || decoded.recovered === null) {
      failExport('recoverable decode is missing inverse/Gs/recovered')
    }
    if (decoded.selectedIndices.length !== k) {
      failExport(
        `selectedIndices length ${decoded.selectedIndices.length} != k ${k}`,
      )
    }
    const selectedSorted = sortedCopy(decoded.selectedIndices)
    if (!sameNumbers(selectedSorted, decoded.selectedIndices)) {
      failExport('selectedIndices must be ascending')
    }
    for (const idx of selectedSorted) {
      if (!surviving.includes(idx)) {
        failExport(`selected survivor ${idx} is not surviving`)
      }
    }
    const wantIgnored = surviving.filter((i) => !selectedSorted.includes(i))
    if (!sameNumbers(wantIgnored, decoded.ignoredIndices)) {
      failExport('ignoredIndices do not match surviving minus selected')
    }
    if (
      decoded.Gs!.length !== k ||
      decoded.Gs!.some((row) => row.length !== k) ||
      decoded.inverse!.length !== k ||
      decoded.inverse!.some((row) => row.length !== k)
    ) {
      failExport('Gs/inverse shape is not k x k')
    }
    if (decoded.steps.length === 0) {
      failExport('recoverable decode has no gauss-jordan steps')
    }
    // 轨迹首帧必须为 [Gs|I]。
    const firstBefore = decoded.steps[0]!.before
    const wantFirst: Matrix = decoded.Gs!.map((row, i) => {
      const identityRow = Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))
      return [...row, ...identityRow]
    })
    if (!sameMatrix(firstBefore, wantFirst)) {
      failExport('first gauss-jordan step before is not [Gs|I]')
    }

    selected = selectedSorted
    ignored = wantIgnored
    recoverySubmatrix = cloneMatrix(decoded.Gs!)
    recoveryMatrix = cloneMatrix(decoded.inverse!)
    initialAugmented = cloneMatrix(firstBefore)
    steps = decoded.steps.map((s) => ({
      ...s,
      before: cloneMatrix(s.before),
      after: cloneMatrix(s.after),
    }))

    // 全量逐字节证据：绝不截断，长度复核失败即抛错。
    if (originalLen > 0) {
      const result = await generateAllByteProvenance(encoded, decoded)
      if (result.stale || result.cancelled) {
        failExport('byte provenance generation was stale or cancelled')
      }
      provenance = result.items
    }
    if (provenance.length !== originalLen) {
      failExport(
        `byte_provenance length ${provenance.length} != original_len ${originalLen}; refusing to export truncated evidence`,
      )
    }

    // 校验：逐字节比对 + SHA 比对（不信任 decode 自带的 byteEqual 字段）。
    const recovered = decoded.recovered!
    if (recovered.length !== originalLen) {
      failExport('recovered length does not equal original_len')
    }
    recoveredSha256 = await sha256Hex(recovered)
    recoveredPayloadBase64 = base64Encode(recovered)
    byteEqual =
      recovered.length === originalLen &&
      recovered.every((b, i) => b === original[i])
    const shaEqual = recoveredSha256 === originalSha256
    let firstMismatch: number | null = null
    for (let i = 0; i < originalLen; i++) {
      if (recovered[i] !== original[i]) {
        firstMismatch = i
        break
      }
    }
    verification = {
      byte_checked_count: originalLen,
      first_mismatch_offset: firstMismatch,
      hash_equal: shaEqual,
    }
    if (!byteEqual) {
      failureReason = 'BYTE_MISMATCH'
    } else if (!shaEqual) {
      failureReason = 'HASH_MISMATCH'
    } else {
      failureReason = null
    }
  } else {
    // 失败态（§9.1）：矩阵/轨迹/证据/恢复字节全部置空，不伪造。
    if (decoded.failureReason === null) {
      failExport('non-recoverable decode carries no failure_reason')
    }
    if (
      decoded.failureReason !== 'INSUFFICIENT_SHARDS' &&
      decoded.failureReason !== 'SINGULAR_MATRIX' &&
      decoded.failureReason !== 'INVALID_EXPERIMENT'
    ) {
      failExport(`unexpected failure_reason for export: ${decoded.failureReason}`)
    }
    selected = []
    ignored = surviving.slice()
    recoverySubmatrix = null
    recoveryMatrix = null
    initialAugmented = null
    steps = []
    provenance = []
    recoveredPayloadBase64 = null
    recoveredSha256 = null
    byteEqual = false
    failureReason = decoded.failureReason
    verification = { byte_checked_count: 0, first_mismatch_offset: null, hash_equal: false }
  }

  // 矩阵元素 0..255 复核（导出前最后一道关）。
  for (const row of [G, recoverySubmatrix, recoveryMatrix, initialAugmented]) {
    if (row === null) continue
    for (const v of row.flat()) {
      if (!isByteValue(v)) failExport('matrix value out of 0..255')
    }
  }

  return {
    spec_version: '1.0.0',
    slug: 'shardlens',
    experiment_id: experimentId,
    input_mode: input.input_mode,
    input_text: input.input_mode === 'utf8' ? input.input_text : null,
    random_seed: input.input_mode === 'seeded_random' ? input.random_seed : null,
    k,
    m,
    n,
    shard_len: shardLen,
    original_len: originalLen,
    padding_len: paddingLen,
    encoding_matrix: cloneMatrix(G),
    shards: shards.map((s) => ({
      index: s.index,
      label: s.label,
      kind: s.kind,
      data_base64: base64Encode(s.bytes),
      sha256: s.sha256,
    })),
    erased_indices: erasedSorted,
    surviving_indices: surviving,
    selected_survivor_indices: selected,
    ignored_survivor_indices: ignored,
    recovery_submatrix: recoverySubmatrix,
    recovery_matrix: recoveryMatrix,
    gauss_jordan_initial_augmented: initialAugmented,
    gauss_jordan_steps: steps,
    byte_provenance: provenance,
    original_payload_base64: originalPayloadBase64,
    recovered_payload_base64: recoveredPayloadBase64,
    original_sha256: originalSha256,
    recovered_sha256: recoveredSha256,
    byte_equal: byteEqual,
    recoverable: decoded.recoverable,
    failure_reason: failureReason,
    failure_reason_detail: input.failure_reason_detail ?? null,
    verification,
    comparison_id: input.comparison_id ?? null,
  }
}

/** 序列化为 JSON 文本（2 空格缩进，便于人工复核）。 */
export function serializeExperimentFile(file: ShardLensFile): string {
  return JSON.stringify(file, null, 2)
}

/* ------------------------------------------------------------------ */
/* P0002-T020 import（PROJECT_BOOK §9，严格导入、重算与拒绝伪证）。   */
/*                                                                    */
/* 反作弊不变式：                                                      */
/* - 只接受文本，不接受任何调用方状态：失败时只抛 ImportError，       */
/*   不返回部分结果；调用方应在 await 成功后才用返回的                 */
/*   ImportedExperiment 整体替换会话状态，失败时原状态对象不动         */
/*   ——原子替换由“无状态输入 + 全有或全无返回”保证。                  */
/* - 绝不信任外来标志：byte_equal、recovered_sha256、逆阵、轨迹、      */
/*   逐字节证据全部重算后逐项比对，任一不符即按字段路径拒绝。          */
/* - 原文 payload 只供比对/核验：解码输入（DecodeInput）只含存活片    */
/*   与编码矩阵，绝不把 original_payload_base64 或已擦除片字节喂给    */
/*   decodeSurvivors 的矩阵恢复路径；逐字节证据的 expected_byte 也     */
/*   只作事后比对（与 evidence.ts 的不变式一致）。                     */
/* - 失败实验按 §9.1 置空约定核验：矩阵/轨迹/证据/恢复字节全为         */
/*   null/[]，selected 为 []，ignored 等于 surviving。                */
/* ------------------------------------------------------------------ */

/** 导入文件体积上限：64 MiB（PROJECT_BOOK §9.5）。 */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024

/** 导入拒绝：message 固定携带字段路径，便于调用方定位到 JSON 字段。 */
export class ImportError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`import: [${path}] ${message}`)
    this.name = 'ImportError'
    this.path = path
  }
}

function failImport(path: string, message: string): never {
  throw new ImportError(path, message)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function isAscending(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i]! <= values[i - 1]!) return false
  }
  return true
}

/* ---------------- 严格 base64（拒绝非标准/非规范形式） ---------------- */

const B64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_REVERSE = new Map<string, number>()
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_REVERSE.set(B64_CHARS[i]!, i)
}

function base64DecodeStrict(text: string, path: string): Uint8Array {
  if (text.length % 4 !== 0) {
    failImport(path, 'base64 length must be a multiple of 4')
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      text,
    )
  ) {
    failImport(path, 'base64 contains illegal characters or bad padding')
  }
  const out: number[] = []
  for (let i = 0; i < text.length; i += 4) {
    const c0 = B64_REVERSE.get(text[i]!)!
    const c1 = B64_REVERSE.get(text[i + 1]!)!
    const third = text[i + 2]!
    const fourth = text[i + 3]!
    const c2 = third === '=' ? 0 : B64_REVERSE.get(third)!
    const c3 = fourth === '=' ? 0 : B64_REVERSE.get(fourth)!
    out.push((c0 << 2) | (c1 >> 4))
    if (third !== '=') out.push(((c1 & 0x0f) << 4) | (c2 >> 2))
    if (fourth !== '=') out.push(((c2 & 0x03) << 6) | c3)
  }
  return new Uint8Array(out)
}

/* ---------------- 结构校验 helpers（全部带字段路径） ---------------- */

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failImport(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function reqField(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!(key in obj)) {
    failImport(path, `missing required field ${key}`)
  }
  return obj[key]
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') failImport(path, 'must be a string')
  return value as string
}

function asNonEmptyString(value: unknown, path: string): string {
  const s = asString(value, path)
  if (s.length === 0) failImport(path, 'must be a non-empty string')
  return s
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null) return null
  return asString(value, path)
}

function asBool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') failImport(path, 'must be a boolean')
  return value as boolean
}

function asInt(value: unknown, path: string): number {
  if (!isInteger(value)) failImport(path, 'must be an integer')
  return value as number
}

function asByte(value: unknown, path: string): number {
  const v = asInt(value, path)
  if (!isByteValue(v)) failImport(path, 'must be 0..255')
  return v
}

function asIntArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) failImport(path, 'must be an array of integers')
  for (let i = 0; i < value.length; i++) {
    if (!isInteger(value[i])) {
      failImport(`${path}[${i}]`, 'must be an integer')
    }
  }
  return value as number[]
}

function asMatrix(
  value: unknown,
  path: string,
  rows: number,
  cols: number,
): Matrix {
  if (!Array.isArray(value)) failImport(path, 'must be a matrix')
  if (value.length !== rows) {
    failImport(path, `matrix must have ${rows} rows, got ${value.length}`)
  }
  const out: Matrix = []
  for (let i = 0; i < rows; i++) {
    const row = value[i]
    if (!Array.isArray(row) || row.length !== cols) {
      failImport(`${path}[${i}]`, `matrix row must have ${cols} columns`)
    }
    for (let j = 0; j < cols; j++) {
      if (!isByteValue(row[j])) {
        failImport(`${path}[${i}][${j}]`, 'matrix value must be 0..255')
      }
    }
    out.push((row as number[]).slice())
  }
  return out
}

function asNullableMatrix(
  value: unknown,
  path: string,
  rows: number,
  cols: number,
): Matrix | null {
  if (value === null) return null
  return asMatrix(value, path, rows, cols)
}

function asShaHex(value: unknown, path: string): string {
  const s = asString(value, path)
  if (!/^[0-9a-f]{64}$/.test(s)) {
    failImport(path, 'must be a 64-char lowercase hex SHA-256')
  }
  return s
}

function asNullableShaHex(value: unknown, path: string): string | null {
  if (value === null) return null
  return asShaHex(value, path)
}

const STEP_OPS = new Set(['pivot_select', 'swap', 'scale', 'eliminate'])

function asSteps(value: unknown, path: string, k: number): GFStep[] {
  if (!Array.isArray(value)) failImport(path, 'must be an array of steps')
  const out: GFStep[] = []
  for (let i = 0; i < value.length; i++) {
    const sp = `${path}[${i}]`
    const step = asRecord(value[i], sp)
    const op = asString(reqField(step, 'op', `${sp}.op`), `${sp}.op`)
    if (!STEP_OPS.has(op)) {
      failImport(`${sp}.op`, `unknown step op ${op}`)
    }
    const rowB = reqField(step, 'row_b', `${sp}.row_b`)
    if (rowB !== null && !isInteger(rowB)) {
      failImport(`${sp}.row_b`, 'must be null or an integer')
    }
    const factor = reqField(step, 'factor', `${sp}.factor`)
    if (factor !== null && !isByteValue(factor)) {
      failImport(`${sp}.factor`, 'must be null or 0..255')
    }
    out.push({
      seq: asInt(reqField(step, 'seq', `${sp}.seq`), `${sp}.seq`),
      op: op as GFStep['op'],
      pivot_col: asInt(reqField(step, 'pivot_col', `${sp}.pivot_col`), `${sp}.pivot_col`),
      row_a: asInt(reqField(step, 'row_a', `${sp}.row_a`), `${sp}.row_a`),
      row_b: rowB as number | null,
      factor: factor as number | null,
      before: asMatrix(reqField(step, 'before', `${sp}.before`), `${sp}.before`, k, 2 * k),
      after: asMatrix(reqField(step, 'after', `${sp}.after`), `${sp}.after`, k, 2 * k),
    })
  }
  return out
}

function asProvenance(
  value: unknown,
  path: string,
  k: number,
): ByteEvidence[] {
  if (!Array.isArray(value)) failImport(path, 'must be an array of byte evidence')
  const out: ByteEvidence[] = []
  for (let i = 0; i < value.length; i++) {
    const ep = `${path}[${i}]`
    const entry = asRecord(value[i], ep)
    const termsRaw = reqField(entry, 'terms', `${ep}.terms`)
    if (!Array.isArray(termsRaw)) failImport(`${ep}.terms`, 'must be an array')
    if (termsRaw.length !== k) {
      failImport(`${ep}.terms`, `terms length must equal k=${k}`)
    }
    const terms: ByteEvidence['terms'] = []
    for (let j = 0; j < termsRaw.length; j++) {
      const tp = `${ep}.terms[${j}]`
      const term = asRecord(termsRaw[j], tp)
      terms.push({
        survivor_index: asInt(reqField(term, 'survivor_index', `${tp}.survivor_index`), `${tp}.survivor_index`),
        coefficient: asByte(reqField(term, 'coefficient', `${tp}.coefficient`), `${tp}.coefficient`),
        input_byte: asByte(reqField(term, 'input_byte', `${tp}.input_byte`), `${tp}.input_byte`),
        product: asByte(reqField(term, 'product', `${tp}.product`), `${tp}.product`),
        xor_accumulator: asByte(reqField(term, 'xor_accumulator', `${tp}.xor_accumulator`), `${tp}.xor_accumulator`),
      })
    }
    const coefficientRow = asIntArray(
      reqField(entry, 'coefficient_row', `${ep}.coefficient_row`),
      `${ep}.coefficient_row`,
    )
    if (coefficientRow.length !== k) {
      failImport(`${ep}.coefficient_row`, `length must equal k=${k}`)
    }
    for (let j = 0; j < coefficientRow.length; j++) {
      if (!isByteValue(coefficientRow[j])) {
        failImport(`${ep}.coefficient_row[${j}]`, 'must be 0..255')
      }
    }
    out.push({
      offset: asInt(reqField(entry, 'offset', `${ep}.offset`), `${ep}.offset`),
      data_shard_index: asInt(reqField(entry, 'data_shard_index', `${ep}.data_shard_index`), `${ep}.data_shard_index`),
      shard_offset: asInt(reqField(entry, 'shard_offset', `${ep}.shard_offset`), `${ep}.shard_offset`),
      coefficient_row: coefficientRow,
      terms,
      result_byte: asInt(reqField(entry, 'result_byte', `${ep}.result_byte`), `${ep}.result_byte`),
      expected_byte: asInt(reqField(entry, 'expected_byte', `${ep}.expected_byte`), `${ep}.expected_byte`),
      equal: asBool(reqField(entry, 'equal', `${ep}.equal`), `${ep}.equal`),
    })
    if (!isByteValue(out[i]!.result_byte) || !isByteValue(out[i]!.expected_byte)) {
      failImport(ep, 'result_byte/expected_byte must be 0..255')
    }
  }
  return out
}

/* ---------------- 结构解析（只校验形状与范围，不信任任何值） ---------------- */

interface ImportShardEntry {
  index: number
  label: string
  kind: 'data' | 'parity'
  dataBase64: string
  sha256: string
  bytes: Uint8Array
}

interface ImportDraft {
  experimentId: string
  inputMode: 'utf8' | 'seeded_random'
  inputText: string | null
  randomSeed: number | null
  k: number
  m: number
  n: number
  shardLen: number
  originalLen: number
  paddingLen: number
  encodingMatrix: Matrix
  shardEntries: ImportShardEntry[]
  erasedIndices: number[]
  survivingIndices: number[]
  selectedSurvivorIndices: number[]
  ignoredSurvivorIndices: number[]
  recoverySubmatrix: Matrix | null
  recoveryMatrix: Matrix | null
  initialAugmented: Matrix | null
  steps: GFStep[]
  provenance: ByteEvidence[]
  originalPayloadBase64: string
  original: Uint8Array
  recoveredPayloadBase64: string | null
  recovered: Uint8Array | null
  originalSha256: string
  recoveredSha256: string | null
  byteEqual: boolean
  recoverable: boolean
  failureReason: FailureReason | null
  failureReasonDetail: string | null
  verification: {
    byte_checked_count: number
    first_mismatch_offset: number | null
    hash_equal: boolean
  }
  comparisonId: string | null
}

const FAILURE_REASONS = new Set([
  'INSUFFICIENT_SHARDS',
  'SINGULAR_MATRIX',
  'INVALID_EXPERIMENT',
  'BYTE_MISMATCH',
  'HASH_MISMATCH',
])

function parseImportShape(raw: unknown): ImportDraft {
  const root = asRecord(raw, '$')

  const specVersion = asString(reqField(root, 'spec_version', 'spec_version'), 'spec_version')
  if (specVersion !== '1.0.0') {
    failImport('spec_version', `must be 1.0.0, got ${specVersion}`)
  }
  const slug = asString(reqField(root, 'slug', 'slug'), 'slug')
  if (slug !== 'shardlens') {
    failImport('slug', `must be shardlens, got ${slug}`)
  }
  const experimentId = asNonEmptyString(
    reqField(root, 'experiment_id', 'experiment_id'),
    'experiment_id',
  )
  const inputModeRaw = asString(reqField(root, 'input_mode', 'input_mode'), 'input_mode')
  if (inputModeRaw !== 'utf8' && inputModeRaw !== 'seeded_random') {
    failImport('input_mode', `must be utf8 or seeded_random, got ${inputModeRaw}`)
  }
  const inputMode = inputModeRaw as 'utf8' | 'seeded_random'
  const inputText = reqField(root, 'input_text', 'input_text')
  const randomSeed = reqField(root, 'random_seed', 'random_seed')
  if (inputMode === 'utf8') {
    if (typeof inputText !== 'string') {
      failImport('input_text', 'utf8 mode requires input_text string')
    }
    if (randomSeed !== null) {
      failImport('random_seed', 'utf8 mode requires random_seed null')
    }
  } else {
    if (inputText !== null) {
      failImport('input_text', 'seeded_random mode requires input_text null')
    }
    if (!isInteger(randomSeed) || (randomSeed as number) < 0 || (randomSeed as number) > 0xffffffff) {
      failImport('random_seed', 'seeded_random mode requires uint32 random_seed')
    }
  }

  const k = asInt(reqField(root, 'k', 'k'), 'k')
  const m = asInt(reqField(root, 'm', 'm'), 'm')
  const n = asInt(reqField(root, 'n', 'n'), 'n')
  if (k < 1 || m < 1 || k + m > 16 || n !== k + m) {
    failImport('k', `invalid k/m/n: k=${k}, m=${m}, n=${n}`)
  }
  const shardLen = asInt(reqField(root, 'shard_len', 'shard_len'), 'shard_len')
  const originalLen = asInt(reqField(root, 'original_len', 'original_len'), 'original_len')
  const paddingLen = asInt(reqField(root, 'padding_len', 'padding_len'), 'padding_len')
  if (shardLen < 0 || originalLen < 0 || originalLen > 16384 || paddingLen < 0) {
    failImport('original_len', `invalid lengths: shard_len=${shardLen}, original_len=${originalLen}, padding_len=${paddingLen}`)
  }
  if (originalLen > k * shardLen || paddingLen !== k * shardLen - originalLen) {
    failImport('padding_len', `length equation violated: original_len=${originalLen}, k*shard_len=${k * shardLen}, padding_len=${paddingLen}`)
  }
  const wantShardLen = originalLen === 0 ? 0 : Math.ceil(originalLen / k)
  if (shardLen !== wantShardLen) {
    failImport('shard_len', `must be ceil(original_len/k)=${wantShardLen}, got ${shardLen}`)
  }

  const encodingMatrix = asMatrix(
    reqField(root, 'encoding_matrix', 'encoding_matrix'),
    'encoding_matrix',
    n,
    k,
  )

  const shardsRaw = reqField(root, 'shards', 'shards')
  if (!Array.isArray(shardsRaw) || shardsRaw.length !== n) {
    failImport('shards', `must be an array of ${n} shards`)
  }
  const shardEntries: ImportShardEntry[] = []
  for (let i = 0; i < n; i++) {
    const sp = `shards[${i}]`
    const shard = asRecord(shardsRaw[i], sp)
    const index = asInt(reqField(shard, 'index', `${sp}.index`), `${sp}.index`)
    if (index !== i) failImport(`${sp}.index`, `must equal position ${i}`)
    const wantLabel = i < k ? `D${i}` : `P${i - k}`
    const label = asString(reqField(shard, 'label', `${sp}.label`), `${sp}.label`)
    if (label !== wantLabel) failImport(`${sp}.label`, `must be ${wantLabel}`)
    const wantKind = i < k ? 'data' : 'parity'
    const kind = asString(reqField(shard, 'kind', `${sp}.kind`), `${sp}.kind`)
    if (kind !== wantKind) failImport(`${sp}.kind`, `must be ${wantKind}`)
    const dataBase64 = asString(reqField(shard, 'data_base64', `${sp}.data_base64`), `${sp}.data_base64`)
    const bytes = base64DecodeStrict(dataBase64, `${sp}.data_base64`)
    if (bytes.length !== shardLen) {
      failImport(`${sp}.data_base64`, `decoded length ${bytes.length} != shard_len ${shardLen}`)
    }
    const sha256 = asShaHex(reqField(shard, 'sha256', `${sp}.sha256`), `${sp}.sha256`)
    shardEntries.push({ index, label, kind: kind as 'data' | 'parity', dataBase64, sha256, bytes })
  }

  const erasedIndices = asIntArray(reqField(root, 'erased_indices', 'erased_indices'), 'erased_indices')
  const survivingIndices = asIntArray(reqField(root, 'surviving_indices', 'surviving_indices'), 'surviving_indices')
  // 互补分区：升序、无重复、范围合法、并集恰为全部索引。
  for (const [list, path] of [[erasedIndices, 'erased_indices'], [survivingIndices, 'surviving_indices']] as const) {
    if (!isAscending(list) && list.length > 1) {
      // isAscending 对单元素/空数组为真；此处额外要求严格升序（含去重）。
      failImport(path, 'must be ascending without duplicates')
    }
    const seen = new Set<number>()
    for (const idx of list) {
      if (idx < 0 || idx > n - 1) failImport(path, `index out of range: ${idx}`)
      if (seen.has(idx)) failImport(path, `duplicate index: ${idx}`)
      seen.add(idx)
    }
  }
  {
    const union = [...erasedIndices, ...survivingIndices].sort((a, b) => a - b)
    const all = Array.from({ length: n }, (_, i) => i)
    if (!sameNumbers(union, all)) {
      failImport('erased_indices', 'erased + surviving must partition all shard indices')
    }
  }

  const selectedSurvivorIndices = asIntArray(reqField(root, 'selected_survivor_indices', 'selected_survivor_indices'), 'selected_survivor_indices')
  const ignoredSurvivorIndices = asIntArray(reqField(root, 'ignored_survivor_indices', 'ignored_survivor_indices'), 'ignored_survivor_indices')
  for (const [list, path] of [[selectedSurvivorIndices, 'selected_survivor_indices'], [ignoredSurvivorIndices, 'ignored_survivor_indices']] as const) {
    if (!isAscending(list) && list.length > 1) {
      failImport(path, 'must be ascending without duplicates')
    }
    const seen = new Set<number>()
    for (const idx of list) {
      if (idx < 0 || idx > n - 1) failImport(path, `index out of range: ${idx}`)
      if (seen.has(idx)) failImport(path, `duplicate index: ${idx}`)
      seen.add(idx)
    }
  }

  const recoverySubmatrix = asNullableMatrix(reqField(root, 'recovery_submatrix', 'recovery_submatrix'), 'recovery_submatrix', k, k)
  const recoveryMatrix = asNullableMatrix(reqField(root, 'recovery_matrix', 'recovery_matrix'), 'recovery_matrix', k, k)
  const initialAugmented = asNullableMatrix(reqField(root, 'gauss_jordan_initial_augmented', 'gauss_jordan_initial_augmented'), 'gauss_jordan_initial_augmented', k, 2 * k)
  const steps = asSteps(reqField(root, 'gauss_jordan_steps', 'gauss_jordan_steps'), 'gauss_jordan_steps', k)
  const provenance = asProvenance(reqField(root, 'byte_provenance', 'byte_provenance'), 'byte_provenance', k)

  const originalPayloadBase64 = asString(reqField(root, 'original_payload_base64', 'original_payload_base64'), 'original_payload_base64')
  const original = base64DecodeStrict(originalPayloadBase64, 'original_payload_base64')
  if (original.length !== originalLen) {
    failImport('original_payload_base64', `decoded length ${original.length} != original_len ${originalLen}`)
  }
  const recoveredPayloadBase64 = asNullableString(reqField(root, 'recovered_payload_base64', 'recovered_payload_base64'), 'recovered_payload_base64')
  let recovered: Uint8Array | null = null
  if (recoveredPayloadBase64 !== null) {
    recovered = base64DecodeStrict(recoveredPayloadBase64, 'recovered_payload_base64')
    if (recovered.length !== originalLen) {
      failImport('recovered_payload_base64', `decoded length ${recovered.length} != original_len ${originalLen}`)
    }
  }
  const originalSha256 = asShaHex(reqField(root, 'original_sha256', 'original_sha256'), 'original_sha256')
  const recoveredSha256 = asNullableShaHex(reqField(root, 'recovered_sha256', 'recovered_sha256'), 'recovered_sha256')
  const byteEqual = asBool(reqField(root, 'byte_equal', 'byte_equal'), 'byte_equal')
  const recoverable = asBool(reqField(root, 'recoverable', 'recoverable'), 'recoverable')
  const failureReasonRaw = reqField(root, 'failure_reason', 'failure_reason')
  let failureReason: FailureReason | null = null
  if (failureReasonRaw !== null) {
    if (typeof failureReasonRaw !== 'string' || !FAILURE_REASONS.has(failureReasonRaw)) {
      failImport('failure_reason', `unknown failure_reason ${String(failureReasonRaw)}`)
    }
    failureReason = failureReasonRaw as FailureReason
  }
  const failureReasonDetail = asNullableString(reqField(root, 'failure_reason_detail', 'failure_reason_detail'), 'failure_reason_detail')
  const verificationRaw = asRecord(reqField(root, 'verification', 'verification'), 'verification')
  const byteCheckedCount = asInt(reqField(verificationRaw, 'byte_checked_count', 'verification.byte_checked_count'), 'verification.byte_checked_count')
  const firstMismatchRaw = reqField(verificationRaw, 'first_mismatch_offset', 'verification.first_mismatch_offset')
  if (firstMismatchRaw !== null && (!isInteger(firstMismatchRaw) || (firstMismatchRaw as number) < 0 || (firstMismatchRaw as number) >= originalLen)) {
    failImport('verification.first_mismatch_offset', 'must be null or within [0, original_len)')
  }
  const hashEqual = asBool(reqField(verificationRaw, 'hash_equal', 'verification.hash_equal'), 'verification.hash_equal')
  const comparisonId = asNullableString(reqField(root, 'comparison_id', 'comparison_id'), 'comparison_id')

  return {
    experimentId,
    inputMode,
    inputText: inputMode === 'utf8' ? (inputText as string) : null,
    randomSeed: inputMode === 'seeded_random' ? (randomSeed as number) : null,
    k,
    m,
    n,
    shardLen,
    originalLen,
    paddingLen,
    encodingMatrix,
    shardEntries,
    erasedIndices,
    survivingIndices,
    selectedSurvivorIndices,
    ignoredSurvivorIndices,
    recoverySubmatrix,
    recoveryMatrix,
    initialAugmented,
    steps,
    provenance,
    originalPayloadBase64,
    original,
    recoveredPayloadBase64,
    recovered,
    originalSha256,
    recoveredSha256,
    byteEqual,
    recoverable,
    failureReason,
    failureReasonDetail,
    verification: {
      byte_checked_count: byteCheckedCount,
      first_mismatch_offset: firstMismatchRaw as number | null,
      hash_equal: hashEqual,
    },
    comparisonId,
  }
}

/* ---------------- 逐项比对（首个差异即带路径拒绝） ---------------- */

function compareSteps(recomputed: GFStep[], imported: GFStep[]): void {
  if (recomputed.length !== imported.length) {
    failImport('gauss_jordan_steps', `step count ${imported.length} != recomputed ${recomputed.length}`)
  }
  for (let i = 0; i < recomputed.length; i++) {
    const sp = `gauss_jordan_steps[${i}]`
    const a = recomputed[i]!
    const b = imported[i]!
    if (a.seq !== b.seq) failImport(`${sp}.seq`, `expected ${a.seq}, got ${b.seq}`)
    if (a.op !== b.op) failImport(`${sp}.op`, `expected ${a.op}, got ${b.op}`)
    if (a.pivot_col !== b.pivot_col) failImport(`${sp}.pivot_col`, `expected ${a.pivot_col}, got ${b.pivot_col}`)
    if (a.row_a !== b.row_a) failImport(`${sp}.row_a`, `expected ${a.row_a}, got ${b.row_a}`)
    if (a.row_b !== b.row_b) failImport(`${sp}.row_b`, `expected ${String(a.row_b)}, got ${String(b.row_b)}`)
    if (a.factor !== b.factor) failImport(`${sp}.factor`, `expected ${String(a.factor)}, got ${String(b.factor)}`)
    if (!sameMatrix(a.before, b.before)) failImport(`${sp}.before`, 'does not match recomputed snapshot')
    if (!sameMatrix(a.after, b.after)) failImport(`${sp}.after`, 'does not match recomputed snapshot')
  }
}

function compareProvenance(recomputed: ByteEvidence[], imported: ByteEvidence[]): void {
  if (recomputed.length !== imported.length) {
    failImport('byte_provenance', `length ${imported.length} != recomputed ${recomputed.length}`)
  }
  for (let i = 0; i < recomputed.length; i++) {
    const ep = `byte_provenance[${i}]`
    const a = recomputed[i]!
    const b = imported[i]!
    if (a.offset !== b.offset) failImport(`${ep}.offset`, `expected ${a.offset}, got ${b.offset}`)
    if (a.data_shard_index !== b.data_shard_index) failImport(`${ep}.data_shard_index`, `expected ${a.data_shard_index}, got ${b.data_shard_index}`)
    if (a.shard_offset !== b.shard_offset) failImport(`${ep}.shard_offset`, `expected ${a.shard_offset}, got ${b.shard_offset}`)
    if (!sameNumbers(a.coefficient_row, b.coefficient_row)) failImport(`${ep}.coefficient_row`, 'does not match recomputed row')
    if (a.terms.length !== b.terms.length) failImport(`${ep}.terms`, `length ${b.terms.length} != recomputed ${a.terms.length}`)
    for (let j = 0; j < a.terms.length; j++) {
      const tp = `${ep}.terms[${j}]`
      const ta = a.terms[j]!
      const tb = b.terms[j]!
      if (ta.survivor_index !== tb.survivor_index) failImport(`${tp}.survivor_index`, `expected ${ta.survivor_index}, got ${tb.survivor_index}`)
      if (ta.coefficient !== tb.coefficient) failImport(`${tp}.coefficient`, `expected ${ta.coefficient}, got ${tb.coefficient}`)
      if (ta.input_byte !== tb.input_byte) failImport(`${tp}.input_byte`, `expected ${ta.input_byte}, got ${tb.input_byte}`)
      if (ta.product !== tb.product) failImport(`${tp}.product`, `expected ${ta.product}, got ${tb.product}`)
      if (ta.xor_accumulator !== tb.xor_accumulator) failImport(`${tp}.xor_accumulator`, `expected ${ta.xor_accumulator}, got ${tb.xor_accumulator}`)
    }
    if (a.result_byte !== b.result_byte) failImport(`${ep}.result_byte`, `expected ${a.result_byte}, got ${b.result_byte}`)
    if (a.expected_byte !== b.expected_byte) failImport(`${ep}.expected_byte`, `expected ${a.expected_byte}, got ${b.expected_byte}`)
    if (a.equal !== b.equal) failImport(`${ep}.equal`, `expected ${a.equal}, got ${b.equal}`)
  }
}

/* ---------------- 语义重算（结构之后、信任之前） ---------------- */

async function verifyImportSemantics(
  draft: ImportDraft,
): Promise<{ encoded: EncodeResult; decoded: DecodeResult }> {
  const { k, m, n, shardLen, originalLen, paddingLen } = draft

  // 1. 原文 SHA 与输入模式一致性（原文只供比对，不进入解码）。
  const originalSha = await sha256Hex(draft.original)
  if (originalSha !== draft.originalSha256) {
    failImport('original_sha256', 'does not match SHA-256 of original_payload_base64')
  }
  if (draft.inputMode === 'utf8') {
    const textBytes = new TextEncoder().encode(draft.inputText!)
    if (textBytes.length !== originalLen || !bytesEqual(textBytes, draft.original)) {
      failImport('input_text', 'does not encode to original_payload_base64 bytes')
    }
  } else {
    const regen = generateRandomBytes(originalLen, draft.randomSeed!)
    if (!bytesEqual(regen, draft.original)) {
      failImport('random_seed', 'seeded_random payload does not match LCG regeneration from random_seed')
    }
  }

  // 2. 分片 SHA 与 base64 规范形式。
  for (let i = 0; i < n; i++) {
    const entry = draft.shardEntries[i]!
    const sha = await sha256Hex(entry.bytes)
    if (sha !== entry.sha256) {
      failImport(`shards[${i}].sha256`, 'does not match SHA-256 of decoded shard bytes')
    }
    if (base64Encode(entry.bytes) !== entry.dataBase64) {
      failImport(`shards[${i}].data_base64`, 'base64 is not canonical')
    }
  }
  if (base64Encode(draft.original) !== draft.originalPayloadBase64) {
    failImport('original_payload_base64', 'base64 is not canonical')
  }

  // 3. V→G：编码矩阵必须等于重算的系统型矩阵。
  const recomputedG = buildSystematicMatrix(k, m)
  if (!sameMatrix(recomputedG, draft.encodingMatrix)) {
    failImport('encoding_matrix', 'does not equal recomputed systematic G (V→G)')
  }

  // 4. 所有片真实重编码：原文重编码后每片字节必须与文件快照一致。
  const encoded = await encode(draft.original, k, m)
  if (encoded.shardLen !== shardLen || encoded.paddingLen !== paddingLen) {
    failImport('shard_len', 're-encoded shard_len/padding_len do not match file')
  }
  for (let i = 0; i < n; i++) {
    if (!bytesEqual(encoded.shards[i]!.bytes, draft.shardEntries[i]!.bytes)) {
      failImport(`shards[${i}].data_base64`, 'shard bytes do not match re-encoding of original payload')
    }
  }

  // 5. selected/ignored 约定（成功态与失败态的 §9.1 语义不同）。
  if (draft.recoverable) {
    if (draft.selectedSurvivorIndices.length !== k) {
      failImport('selected_survivor_indices', `length must equal k=${k}`)
    }
    for (const idx of draft.selectedSurvivorIndices) {
      if (!draft.survivingIndices.includes(idx)) {
        failImport('selected_survivor_indices', `selected survivor ${idx} is not surviving`)
      }
    }
    const wantIgnored = draft.survivingIndices.filter(
      (i) => !draft.selectedSurvivorIndices.includes(i),
    )
    if (!sameNumbers(wantIgnored, draft.ignoredSurvivorIndices)) {
      failImport('ignored_survivor_indices', 'must equal surviving minus selected')
    }
  } else {
    if (draft.selectedSurvivorIndices.length !== 0) {
      failImport('selected_survivor_indices', 'failure file must have empty selected_survivor_indices')
    }
    if (!sameNumbers(draft.survivingIndices, draft.ignoredSurvivorIndices)) {
      failImport('ignored_survivor_indices', 'failure file ignored must equal surviving')
    }
  }

  // 6. 从未擦除片重新求解（解码输入绝不含原文与已擦除片）。
  const available: DecodeInput['available'] = draft.survivingIndices.map(
    (idx) => ({ index: idx, bytes: draft.shardEntries[idx]!.bytes }),
  )
  const decoded = decodeSurvivors({
    k,
    m,
    n,
    originalLen,
    paddingLen,
    shardLen,
    encodingMatrix: cloneMatrix(recomputedG),
    available,
  })
  if (decoded.recoverable !== draft.recoverable) {
    failImport('recoverable', `re-solved recoverable=${decoded.recoverable}, file says ${draft.recoverable}`)
  }

  if (decoded.recoverable) {
    if (
      draft.failureReason !== null &&
      draft.failureReason !== 'BYTE_MISMATCH' &&
      draft.failureReason !== 'HASH_MISMATCH'
    ) {
      failImport('failure_reason', 'recoverable file failure_reason must be null, BYTE_MISMATCH or HASH_MISMATCH')
    }
    if (!sameNumbers(decoded.selectedIndices, draft.selectedSurvivorIndices)) {
      failImport('selected_survivor_indices', 'does not match re-solved selection')
    }
    if (!sameNumbers(decoded.ignoredIndices, draft.ignoredSurvivorIndices)) {
      failImport('ignored_survivor_indices', 'does not match re-solved ignored set')
    }
    if (decoded.Gs === null || !sameMatrix(decoded.Gs, draft.recoverySubmatrix!)) {
      failImport('recovery_submatrix', 'does not match re-solved Gs')
    }
    if (decoded.inverse === null || !sameMatrix(decoded.inverse, draft.recoveryMatrix!)) {
      failImport('recovery_matrix', 'does not match re-solved inverse R')
    }
    compareSteps(decoded.steps, draft.steps)
    if (decoded.steps.length === 0) {
      failImport('gauss_jordan_steps', 'recoverable file has no steps')
    }
    if (
      draft.initialAugmented === null ||
      !sameMatrix(draft.initialAugmented, decoded.steps[0]!.before)
    ) {
      failImport('gauss_jordan_initial_augmented', 'must equal first step before ([Gs|I])')
    }
    if (decoded.recovered === null || draft.recovered === null) {
      failImport('recovered_payload_base64', 'recoverable file must carry recovered payload')
    }
    if (!bytesEqual(decoded.recovered, draft.recovered)) {
      failImport('recovered_payload_base64', 'does not match re-solved recovered bytes')
    }
    if (base64Encode(draft.recovered) !== draft.recoveredPayloadBase64) {
      failImport('recovered_payload_base64', 'base64 is not canonical')
    }
    const recoveredSha = await sha256Hex(decoded.recovered)
    if (recoveredSha !== draft.recoveredSha256) {
      failImport('recovered_sha256', 'does not match SHA-256 of re-solved recovered bytes')
    }
    const byteEqual = bytesEqual(decoded.recovered, draft.original)
    if (byteEqual !== draft.byteEqual) {
      failImport('byte_equal', 'imported flag does not match recomputation; refusing to trust foreign success flag')
    }
    const shaEqual = recoveredSha === originalSha
    const expectedFailure: FailureReason | null = !byteEqual
      ? 'BYTE_MISMATCH'
      : !shaEqual
        ? 'HASH_MISMATCH'
        : null
    if (draft.failureReason !== expectedFailure) {
      failImport('failure_reason', `must be ${String(expectedFailure)} for recomputed byte_equal=${byteEqual}, hash_equal=${shaEqual}`)
    }
    let firstMismatch: number | null = null
    for (let i = 0; i < originalLen; i++) {
      if (decoded.recovered[i] !== draft.original[i]) {
        firstMismatch = i
        break
      }
    }
    if (draft.verification.byte_checked_count !== originalLen) {
      failImport('verification.byte_checked_count', `must equal original_len ${originalLen}`)
    }
    if (draft.verification.first_mismatch_offset !== firstMismatch) {
      failImport('verification.first_mismatch_offset', `must be ${String(firstMismatch)}`)
    }
    if (draft.verification.hash_equal !== shaEqual) {
      failImport('verification.hash_equal', `must be ${shaEqual}`)
    }
    const provenance = await generateAllByteProvenance(encoded, decoded)
    if (provenance.stale || provenance.cancelled) {
      failImport('byte_provenance', 'provenance generation was stale or cancelled')
    }
    compareProvenance(provenance.items, draft.provenance)
  } else {
    if (
      draft.failureReason === null ||
      (draft.failureReason !== 'INSUFFICIENT_SHARDS' &&
        draft.failureReason !== 'SINGULAR_MATRIX' &&
        draft.failureReason !== 'INVALID_EXPERIMENT')
    ) {
      failImport('failure_reason', 'failure file failure_reason must be INSUFFICIENT_SHARDS, SINGULAR_MATRIX or INVALID_EXPERIMENT')
    }
    if (decoded.failureReason !== draft.failureReason) {
      failImport('failure_reason', `re-solved failure ${String(decoded.failureReason)} != imported ${draft.failureReason}`)
    }
    if (draft.recoverySubmatrix !== null) {
      failImport('recovery_submatrix', 'failure file must be null')
    }
    if (draft.recoveryMatrix !== null) {
      failImport('recovery_matrix', 'failure file must be null')
    }
    if (draft.initialAugmented !== null) {
      failImport('gauss_jordan_initial_augmented', 'failure file must be null')
    }
    if (draft.steps.length !== 0) {
      failImport('gauss_jordan_steps', 'failure file must be empty')
    }
    if (draft.provenance.length !== 0) {
      failImport('byte_provenance', 'failure file must be empty')
    }
    if (
      draft.recovered !== null ||
      draft.recoveredPayloadBase64 !== null ||
      draft.recoveredSha256 !== null
    ) {
      failImport('recovered_payload_base64', 'failure file must have null recovered payload')
    }
    if (draft.byteEqual !== false) {
      failImport('byte_equal', 'failure file must have byte_equal false')
    }
    if (
      draft.verification.byte_checked_count !== 0 ||
      draft.verification.first_mismatch_offset !== null ||
      draft.verification.hash_equal !== false
    ) {
      failImport('verification', 'failure file verification must be {0, null, false}')
    }
  }

  return { encoded, decoded }
}

/* ---------------- 入口与返回 ---------------- */

/** 导入成功后返回的全新对象：文件深拷贝 + 重编码 + 重求解结果。 */
export interface ImportedExperiment {
  /** 已验证的文件内容深拷贝（与输入文本无共享引用）。 */
  file: ShardLensFile
  /** 由已验证原文重编码得到的编码结果。 */
  encoded: EncodeResult
  /** 仅由存活片重求解得到的解码结果。 */
  decoded: DecodeResult
  /** 升序擦除索引（文件 erased_indices 的副本）。 */
  erasedIndices: number[]
}

function cloneStep(step: GFStep): GFStep {
  return {
    ...step,
    before: cloneMatrix(step.before),
    after: cloneMatrix(step.after),
  }
}

function cloneEvidence(evidence: ByteEvidence): ByteEvidence {
  return {
    ...evidence,
    coefficient_row: evidence.coefficient_row.slice(),
    terms: evidence.terms.map((t) => ({ ...t })),
  }
}

/**
 * 严格导入 `.shardlens.json` 文本（PROJECT_BOOK §9）。
 *
 * 流程：体积上限 → JSON 解析 → 全部结构字段校验 → 原文 SHA/
 * 输入模式/分片 SHA/base64 规范性 → V→G 重算 → 原文重编码比对
 * → 仅由存活片重求解并比对逆阵/轨迹/逐字节证据/校验块。
 * 任一环节失败即抛 ImportError（message 含字段路径），不返回部分结果；
 * 调用方应在 await 成功后才整体替换会话状态，失败时原状态保持不动。
 */
export async function importExperiment(
  text: string,
): Promise<ImportedExperiment> {
  if (typeof text !== 'string') {
    failImport('$', 'import input must be a string')
  }
  const byteLen = new TextEncoder().encode(text).length
  if (byteLen > MAX_IMPORT_BYTES) {
    failImport('$', `file size ${byteLen} exceeds 64 MiB limit ${MAX_IMPORT_BYTES}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    failImport('$', 'invalid JSON')
  }
  const draft = parseImportShape(raw)
  const { encoded, decoded } = await verifyImportSemantics(draft)

  const file: ShardLensFile = {
    spec_version: '1.0.0',
    slug: 'shardlens',
    experiment_id: draft.experimentId,
    input_mode: draft.inputMode,
    input_text: draft.inputText,
    random_seed: draft.randomSeed,
    k: draft.k,
    m: draft.m,
    n: draft.n,
    shard_len: draft.shardLen,
    original_len: draft.originalLen,
    padding_len: draft.paddingLen,
    encoding_matrix: cloneMatrix(draft.encodingMatrix),
    shards: draft.shardEntries.map((e) => ({
      index: e.index,
      label: e.label,
      kind: e.kind,
      data_base64: e.dataBase64,
      sha256: e.sha256,
    })),
    erased_indices: draft.erasedIndices.slice(),
    surviving_indices: draft.survivingIndices.slice(),
    selected_survivor_indices: draft.selectedSurvivorIndices.slice(),
    ignored_survivor_indices: draft.ignoredSurvivorIndices.slice(),
    recovery_submatrix:
      draft.recoverySubmatrix === null ? null : cloneMatrix(draft.recoverySubmatrix),
    recovery_matrix:
      draft.recoveryMatrix === null ? null : cloneMatrix(draft.recoveryMatrix),
    gauss_jordan_initial_augmented:
      draft.initialAugmented === null ? null : cloneMatrix(draft.initialAugmented),
    gauss_jordan_steps: draft.steps.map(cloneStep),
    byte_provenance: draft.provenance.map(cloneEvidence),
    original_payload_base64: draft.originalPayloadBase64,
    recovered_payload_base64: draft.recoveredPayloadBase64,
    original_sha256: draft.originalSha256,
    recovered_sha256: draft.recoveredSha256,
    byte_equal: draft.byteEqual,
    recoverable: draft.recoverable,
    failure_reason: draft.failureReason,
    failure_reason_detail: draft.failureReasonDetail,
    verification: { ...draft.verification },
    comparison_id: draft.comparisonId,
  }

  return {
    file,
    encoded,
    decoded,
    erasedIndices: draft.erasedIndices.slice(),
  }
}

