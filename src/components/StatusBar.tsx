/**
 * P0002-T016 — 失败状态说明与真实性门禁（角色 FRONTEND_STATE）。
 *
 * 展示型组件（PROJECT_BOOK §9.3 / §5 / 实施计划 T016）：
 * - 只渲染 props，无内部状态，不调用 encode/decode，不读取 original 字节；
 * - 存活数 / 总片数 / 最少需求 k 与失败码按真实传入值原样呈现；
 * - 「数学可恢复」（decode.recoverable）与「最终 verified」（byteEqual && shaEqual）
 *   是两条独立判定，绝不合并表述：数学可恢复但未通过校验时不得读作成功；
 * - 任何失败（phase FAILED 或 failureReason 非空）下强制显示
 *   recovered=null、逆阵 R=null、证据=[]，并使用失败样式，
 *   绝不渲染绿色「通过/VERIFIED」样式或任何旧成功数据；
 * - BYTE_MISMATCH / HASH_MISMATCH 时提示「标擦除」该片后重新恢复，
 *   绝不建议自动纠错（PROJECT_BOOK §9.3：不自动纠错）。
 */

import type { DecodeResult, FailureReason } from '../core/types'

export interface StatusBarProps {
  /** 会话阶段（CLEAN/ENCODED/ERASED/RECOVERING/VERIFIED/FAILED）。 */
  phase: string
  /** 数据片数 k。 */
  k: number
  /** 校验片数 m。 */
  m: number
  /** 总片数 n = k + m。 */
  n: number
  /** 当前存活分片数。 */
  aliveCount: number
  /** 当前已擦除分片数。 */
  erasedCount: number
  /** 最近失败码（无失败为 null）。 */
  failureReason: FailureReason | null
  /** 最近一次解码结果（无则为 null）。 */
  decode: DecodeResult | null
  /** 最终校验结论：byteEqual && shaEqual。 */
  verified: boolean
  /** 逐字节比较结果。 */
  byteEqual: boolean
  /** SHA-256 比较结果。 */
  shaEqual: boolean
  /** 面向用户的补充说明（无则为 null）。 */
  detail: string | null
}

const CHECKSUM_CODES: ReadonlySet<string> = new Set(['BYTE_MISMATCH', 'HASH_MISMATCH'])

const CHECKSUM_HINT = '片校验失败：建议标擦除该片后重新恢复（系统不会自动纠错）'

const FAIL_COLOR = '#b00020'
const OK_COLOR = '#1b5e20'
const NEUTRAL_COLOR = '#444'

function label(value: boolean): string {
  return value ? '是' : '否'
}

export default function StatusBar(props: StatusBarProps) {
  const {
    phase,
    k,
    m,
    n,
    aliveCount,
    erasedCount,
    failureReason,
    decode,
    verified,
    byteEqual,
    shaEqual,
    detail,
  } = props

  const isFailure = phase === 'FAILED' || failureReason !== null
  // 失败态下绝不展示任何历史成功数据：recovered=null、R=null、证据=[]。
  const recovered = isFailure ? null : (decode?.recovered ?? null)
  const inverse = isFailure ? null : (decode?.inverse ?? null)
  const evidenceCount = isFailure ? 0 : (decode?.steps.length ?? 0)

  const recoverable = decode?.recoverable ?? false
  const mathRecoverableText = `${label(recoverable)}（recoverable）`
  const finalVerifiedText = verified ? '是（VERIFIED：byteEqual 与 shaEqual 同时为真）' : '否（未通过，不显示 VERIFIED）'

  const recoveredText =
    recovered === null ? 'null' : `${recovered.length} 字节`
  const inverseText = inverse === null ? 'null' : `${inverse.length}×${inverse[0]?.length ?? 0} 逆阵`
  const evidenceText = isFailure ? '[]' : `[${evidenceCount} 条消元轨迹]`

  const statusColor = isFailure ? FAIL_COLOR : verified ? OK_COLOR : NEUTRAL_COLOR

  return (
    <section
      aria-label="状态条"
      data-testid="status-bar"
      style={{
        border: `1px solid ${statusColor}`,
        padding: '8px',
        color: statusColor,
      }}
    >
      <p>
        存活 {aliveCount}/{n}，已擦除 {erasedCount}，最少需要 k={k}（k={k}, m={m}, n={n}）
      </p>

      <p data-testid="failure-code">
        失败码：{failureReason ?? 'null'}
      </p>

      <p data-testid="math-recoverable">
        数学可恢复：{mathRecoverableText}
      </p>
      <p data-testid="final-verified">
        最终 verified：{finalVerifiedText}
      </p>
      {!verified && recoverable && !isFailure && (
        <p>
          注意：数学上可恢复并不等于校验通过；byte_equal={String(byteEqual)}，sha_equal={String(shaEqual)}，
          尚不构成 VERIFIED。
        </p>
      )}
      {!verified && isFailure && (
        <p>
          注意：失败状态下不显示通过结论；byte_equal={String(byteEqual)}，sha_equal={String(shaEqual)}。
        </p>
      )}

      <p data-testid="recovered-value">recovered = {recoveredText}</p>
      <p data-testid="inverse-value">逆阵 R = {inverseText}</p>
      <p data-testid="evidence-value">证据 = {evidenceText}</p>

      {failureReason !== null && CHECKSUM_CODES.has(failureReason) && (
        <p data-testid="checksum-hint" role="alert">
          {CHECKSUM_HINT}
        </p>
      )}

      {detail !== null && detail !== '' && <p className="note">{detail}</p>}
    </section>
  )
}
