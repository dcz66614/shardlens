/**
 * P0002-T009 — 实验状态机与解码适配器（角色 FRONTEND_STATE）。
 *
 * 分层不变式（PROJECT_BOOK §10.2 / 实施计划 T009）：
 * - 本模块是核心解码与 UI 之间唯一的适配层；
 * - `recoverExperiment()` 只用**真正存活的分片**构造 `DecodeInput`
 *   （绝不含原文、绝不含已擦除片），调用 `decodeSurvivors()`；
 * - 原文比对只发生在 decode 结束之后，由本层持有 `encoded.original`
 *   调用 `verifyDecoded()` —— decode 本身始终拿不到 original；
 * - 状态机：CLEAN → ENCODED → ERASED → RECOVERING → VERIFIED | FAILED；
 * - 任何输入/参数/擦除集变动都同步废止上一轮恢复字节、哈希与证明；
 *   无新结果时绝不呈现上一轮 VERIFIED。
 *
 * 本文件不依赖 React；App.tsx 通过 subscribe/getState 接入。
 *
 * FIX-R1（终审第 1 轮 B1 修复）：新增 seeded 随机输入入口。会话此前只支持
 * utf8 文本输入；本修复后 inputMode/seed/seededLength 进入会话状态，encode()
 * 在 seeded 模式下用 generators 的 LCG 真实生成字节（与 T019/T020 的
 * seeded_random 口径一致），不再只有 IO 函数层面支持 seeded。
 */

import { encode as encodeCore } from '../core/encode'
import { decodeSurvivors } from '../core/decode'
import { verifyDecoded } from '../core/verify'
import { DEFAULT_SEED, generateRandomBytes } from '../features/input/generators'
import type {
  DecodeInput,
  DecodeResult,
  EncodeResult,
  FailureReason,
} from '../core/types'

export type Phase =
  | 'CLEAN'
  | 'ENCODED'
  | 'ERASED'
  | 'RECOVERING'
  | 'VERIFIED'
  | 'FAILED'

/** decode 之后、由本层补齐的校验结论（verify 结果不进入 decode）。 */
export interface RecoveryOutcome {
  decode: DecodeResult
  /** verifyDecoded 的逐字节比较结果。 */
  byteEqual: boolean
  recoveredSha256: string | null
  expectedSha256: string | null
  shaEqual: boolean
  /** 仅当 byteEqual 与 shaEqual 同时为真才为 true（§9.3：BYTE_MISMATCH 绝不 VERIFIED）。 */
  verified: boolean
  /** 面向用户的补充说明（例如 crypto.subtle 不可用）。 */
  detail: string | null
}

export interface SessionState {
  phase: Phase
  inputText: string
  /** 输入模式：utf8 文本 或 seeded 随机字节（FIX-R1 新增）。 */
  inputMode: 'utf8' | 'seeded'
  /** seeded 模式的种子（uint32）；utf8 模式下不使用。 */
  seed: number
  /** seeded 模式的随机字节长度；utf8 模式下不使用。 */
  seededLength: number
  k: number
  m: number
  encoded: EncodeResult | null
  /** 升序擦除索引（全局分片索引）。 */
  erased: number[]
  /** 上一轮恢复结果；被失效后为 null。 */
  recovery: RecoveryOutcome | null
  failureReason: FailureReason | null
  detail: string | null
  busy: boolean
  /** crypto.subtle 是否可用；不可用时不允许出现 VERIFIED。 */
  hashAvailable: boolean
}

export function isHashAvailable(): boolean {
  const c = globalThis.crypto as Crypto | undefined
  return typeof c?.subtle?.digest === 'function'
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function sortedIndices(set: Iterable<number>): number[] {
  return [...set].sort((a, b) => a - b)
}

/**
 * 只用存活片构造 DecodeInput（不含原文、不含已擦除片）。
 * 独立导出以便状态层审计与探针复查。
 */
export function buildDecodeInput(
  encoded: EncodeResult,
  erased: number[],
): DecodeInput {
  const erasedSet = new Set(erased)
  const available = encoded.shards
    .filter((s) => !erasedSet.has(s.index))
    .map((s) => ({ index: s.index, bytes: s.bytes }))
  return {
    k: encoded.k,
    m: encoded.m,
    n: encoded.n,
    originalLen: encoded.original.length,
    paddingLen: encoded.paddingLen,
    shardLen: encoded.shardLen,
    encodingMatrix: encoded.G,
    available,
  }
}

/**
 * 薄包装（契约见 types.ts 的 `recoverExperiment` 声明）：
 * 编码结果 + 擦除集合 → 只含存活片的 DecodeInput → decodeSurvivors → verifyDecoded。
 */
export async function recoverExperiment(
  encoded: EncodeResult,
  erased: number[],
): Promise<RecoveryOutcome> {
  // 关键分层点：available 只包含未擦除片的真实字节，不携带 original、
  // 不携带任何已擦除片的备份。
  const input = buildDecodeInput(encoded, erased)

  const decode = decodeSurvivors(input)

  if (!decode.recoverable || decode.recovered === null) {
    return {
      decode,
      byteEqual: false,
      recoveredSha256: decode.recoveredSha256,
      expectedSha256: null,
      shaEqual: false,
      verified: false,
      detail: decode.failureReason,
    }
  }

  if (!isHashAvailable()) {
    return {
      decode,
      byteEqual: false,
      recoveredSha256: null,
      expectedSha256: null,
      shaEqual: false,
      verified: false,
      detail: 'crypto.subtle 不可用：请使用 localhost/HTTPS 运行后重新校验（未校验的恢复不会标记为 VERIFIED）',
    }
  }

  // verify 只在这一步、且仅由状态层持有原文时发生。
  const v = await verifyDecoded(decode, encoded.original)
  return {
    decode,
    byteEqual: v.byteEqual,
    recoveredSha256: v.recoveredSha256,
    expectedSha256: v.expectedSha256,
    shaEqual: v.shaEqual,
    verified: v.byteEqual && v.shaEqual,
    detail: v.byteEqual && v.shaEqual ? null : decode.byteEqual ? 'HASH_MISMATCH' : 'BYTE_MISMATCH',
  }
}

type Listener = () => void

const INITIAL: SessionState = {
  phase: 'CLEAN',
  inputText: 'ABC',
  inputMode: 'utf8',
  seed: DEFAULT_SEED,
  seededLength: 16,
  k: 4,
  m: 2,
  encoded: null,
  erased: [],
  recovery: null,
  failureReason: null,
  detail: null,
  busy: false,
  hashAvailable: isHashAvailable(),
}

/** 实验状态机（React-free）。 */
export class ExperimentSession {
  private state: SessionState = INITIAL
  private listeners = new Set<Listener>()
  private generation = 0

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): SessionState => this.state

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  /** 统一失效：清除上一轮恢复字节、哈希与证明。 */
  private invalidateEvidence(): void {
    this.generation += 1
    this.set({ recovery: null, failureReason: null, detail: null })
  }

  /** 重置/删除：撤销整个当次实验状态（不隐式恢复过期证据）。
   *  注意：输入模式/种子/长度属于输入偏好而非当次证据，重置后保留，
   *  以便用户换一组参数立即重做同一模式的实验。 */
  reset(): void {
    this.generation += 1
    this.set({
      phase: 'CLEAN',
      inputText: '',
      encoded: null,
      erased: [],
      recovery: null,
      failureReason: null,
      detail: null,
      busy: false,
    })
  }

  /** 用户再次输入：废止旧证据与旧分片（分片不再对应新输入）。 */
  setInputText(text: string): void {
    if (text === this.state.inputText && this.state.encoded === null && this.state.phase === 'CLEAN') return
    this.invalidateEvidence()
    this.set({
      inputText: text,
      encoded: null,
      erased: [],
      phase: 'CLEAN',
      busy: false,
    })
  }

  /** 切换输入模式：废止旧分片与旧证据（新模式的字节与旧分片无关）。 */
  setInputMode(mode: 'utf8' | 'seeded'): void {
    if (mode === this.state.inputMode) return
    this.invalidateEvidence()
    this.set({
      inputMode: mode,
      encoded: null,
      erased: [],
      phase: 'CLEAN',
      busy: false,
    })
  }

  /** 设置 seeded 种子（仅接受 uint32 整数；非法值不改动会话，控件层负责禁编码）。 */
  setSeed(seed: number): void {
    if (
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 0xffffffff ||
      seed === this.state.seed
    ) {
      return
    }
    this.invalidateEvidence()
    this.set({
      seed,
      encoded: null,
      erased: [],
      phase: 'CLEAN',
      busy: false,
    })
  }

  /** 设置 seeded 随机字节长度（仅接受 1..16384；非法值不改动会话）。 */
  setSeededLength(length: number): void {
    if (
      !Number.isInteger(length) ||
      length < 1 ||
      length > 16384 ||
      length === this.state.seededLength
    ) {
      return
    }
    this.invalidateEvidence()
    this.set({
      seededLength: length,
      encoded: null,
      erased: [],
      phase: 'CLEAN',
      busy: false,
    })
  }

  /** 修改参数：同输入一样废止整个待算状态。 */
  setParams(k: number, m: number): void {
    if (k === this.state.k && m === this.state.m) return
    this.invalidateEvidence()
    this.set({
      k,
      m,
      encoded: null,
      erased: [],
      phase: 'CLEAN',
      busy: false,
      detail: null,
    })
  }

  /** 编码：真实调用 core/encode。 */
  async encode(): Promise<void> {
    if (!this.state.hashAvailable) {
      this.set({
        phase: 'FAILED',
        failureReason: 'INVALID_EXPERIMENT',
        detail: 'crypto.subtle 不可用：请使用 localhost/HTTPS 运行',
      })
      return
    }
    this.invalidateEvidence()
    const gen = this.generation
    this.set({ busy: true, detail: null, failureReason: null })
    try {
      // FIX-R1：seeded 模式用 LCG 真实生成字节；utf8 模式仍用文本字节。
      const bytes =
        this.state.inputMode === 'seeded'
          ? generateRandomBytes(this.state.seededLength, this.state.seed)
          : utf8Bytes(this.state.inputText)
      const encoded = await encodeCore(bytes, this.state.k, this.state.m)
      if (gen !== this.generation) return // 已被新输入废止
      this.set({ encoded, erased: [], phase: 'ENCODED', busy: false })
    } catch (err) {
      if (gen !== this.generation) return
      this.set({
        busy: false,
        phase: 'CLEAN',
        failureReason: 'INVALID_EXPERIMENT',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** 改变任意擦除开关：同步废止上一轮 VERIFIED/FAILED 证据。 */
  toggleErase(index: number): void {
    const enc = this.state.encoded
    if (!enc) return
    if (!Number.isInteger(index) || index < 0 || index >= enc.n) return
    const set = new Set(this.state.erased)
    if (set.has(index)) set.delete(index)
    else set.add(index)
    this.invalidateEvidence()
    const erased = sortedIndices(set)
    this.set({
      erased,
      phase: erased.length > 0 ? 'ERASED' : 'ENCODED',
    })
  }

  /** 清空擦除集：同样废止旧证据。 */
  clearErase(): void {
    if (this.state.erased.length === 0) return
    this.invalidateEvidence()
    this.set({ erased: [], phase: this.state.encoded ? 'ENCODED' : 'CLEAN' })
  }

  /** 恢复：真实求逆/重建 + 校验。 */
  async recover(): Promise<void> {
    const enc = this.state.encoded
    if (!enc || this.state.busy) return
    this.invalidateEvidence()
    const gen = this.generation
    this.set({ phase: 'RECOVERING', busy: true })
    try {
      const outcome = await recoverExperiment(enc, this.state.erased)
      if (gen !== this.generation) return
      this.set({
        recovery: outcome,
        failureReason: outcome.verified ? null : (outcome.decode.failureReason ?? 'BYTE_MISMATCH'),
        detail: outcome.detail,
        phase: outcome.verified ? 'VERIFIED' : 'FAILED',
        busy: false,
      })
    } catch (err) {
      if (gen !== this.generation) return
      this.set({
        phase: 'FAILED',
        failureReason: 'SINGULAR_MATRIX',
        detail: err instanceof Error ? err.message : String(err),
        busy: false,
      })
    }
  }
}

/** 单例，供 App 与探针共用。 */
export const session = new ExperimentSession()
