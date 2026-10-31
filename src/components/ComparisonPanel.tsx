/**
 * P0002-T017 — 同输入反事实对比面板（角色 FRONTEND_UI）。
 *
 * 展示型组件（PROJECT_BOOK FR-13 / 实施计划 T017）：
 * - 只渲染 props，不调用 encode/decode，不读取 original 字节，不持有内部解码状态；
 * - 冻结 A 与当前 B 由调用方用真实解码结果构造，组件只做呈现与差异归纳；
 * - 未实际解码的失败案例绝不显示虚构数据：逆阵、恢复哈希一律显式为 null，
 *   失败原因按真实传入的 failureReason 原样呈现；
 * - 不可修改 T016 失败状态字段：本组件不渲染、不改写 StatusBar 的任何字段，
 *   失败态的 null 门禁由 StatusBar 自身负责；
 * - 比较过期（stale）时明确标记“已过期，需重新冻结”，并通过 onRefreeze
 *   把重新冻结的动作交回调用方，组件自身不重算任何方案。
 */

import type { FailureReason, Matrix } from '../core/types'

/** 反事实对比中的一方方案：调用方用真实解码结果填写，禁止虚构。 */
export interface ComparisonCase {
  /** 方案标识，如“冻结 A”/“当前 B”。 */
  label: string
  /** 升序擦除索引（全局分片索引）。 */
  erased: number[]
  /** 升序存活索引（全局分片索引）。 */
  alive: number[]
  /** 选行（前 k 个存活片对应的 G 行索引）；不可解码时为 null。 */
  selectedIndices: number[] | null
  /** 选行矩阵 Gs；不可解码时为 null。 */
  selectedMatrix: Matrix | null
  /** 逆阵 R；不可解码时为 null（失败案例绝不凭空补一个矩阵）。 */
  inverse: Matrix | null
  /** 数学可恢复性（decode.recoverable）。 */
  recoverable: boolean
  /** 失败原因码；成功时为 null。 */
  failureReason: FailureReason | null
  /** 最终校验结论（byteEqual && shaEqual）；失败时为 false。 */
  verified: boolean
  /** 恢复字节的 SHA-256；失败时为 null。 */
  recoveredSha256: string | null
}

export interface ComparisonPanelProps {
  /** 冻结的 A 方案；尚未冻结时为 null（此时只显示空态，不编造 A）。 */
  frozenA: ComparisonCase | null
  /** 当前的 B 方案。 */
  currentB: ComparisonCase
  /** 原文/参数修改后比较是否已过期；过期时必须重新冻结。 */
  stale: boolean
  /** 重新冻结回调（调用方重算并替换 frozenA）；未提供时不渲染按钮。 */
  onRefreeze?: () => void
}

function label(value: boolean): string {
  return value ? '是' : '否'
}

function listText(values: number[]): string {
  return `[${values.join(',')}]`
}

function matrixText(matrix: Matrix | null): string {
  if (matrix === null) return 'null'
  return matrix.map((row) => `[${row.join(',')}]`).join(' ')
}

function sameNumbers(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function sameMatrix(a: Matrix | null, b: Matrix | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.length === b.length &&
    a.every((row, i) => row.length === b[i]!.length && row.every((v, j) => v === b[i]![j]))
  )
}

/**
 * 首个差异：按固定字段顺序归纳，字段顺序为擦除集 → 存活数 →
 * 可恢复性 → 失败原因 → 选行 → 逆阵。全部相同则返回 null。
 */
export function firstDifference(a: ComparisonCase, b: ComparisonCase): string | null {
  if (!sameNumbers(a.erased, b.erased)) {
    return `擦除集不同：A=${listText(a.erased)}，B=${listText(b.erased)}`
  }
  if (a.alive.length !== b.alive.length) {
    return `存活数不同：A=${a.alive.length}，B=${b.alive.length}`
  }
  if (!sameNumbers(a.alive, b.alive)) {
    return `存活集不同：A=${listText(a.alive)}，B=${listText(b.alive)}`
  }
  if (a.recoverable !== b.recoverable) {
    return `可恢复性不同：A=${label(a.recoverable)}，B=${label(b.recoverable)}`
  }
  if (a.failureReason !== b.failureReason) {
    return `失败原因不同：A=${a.failureReason ?? '无'}，B=${b.failureReason ?? '无'}`
  }
  if (!sameNumbers(a.selectedIndices, b.selectedIndices)) {
    return `选行不同：A=${a.selectedIndices === null ? 'null' : listText(a.selectedIndices)}，B=${b.selectedIndices === null ? 'null' : listText(b.selectedIndices)}`
  }
  if (!sameMatrix(a.inverse, b.inverse)) {
    return '逆阵不同'
  }
  return null
}

function CaseBlock(props: { testid: string; c: ComparisonCase }) {
  const { testid, c } = props
  return (
    <section data-testid={testid}>
      <h3>{c.label}</h3>
      <p>
        擦除集：{listText(c.erased)}；存活集：{listText(c.alive)}；存活数：
        {c.alive.length}
      </p>
      <p>选行：{c.selectedIndices === null ? 'null' : listText(c.selectedIndices)}</p>
      <p>选行矩阵 Gs：{matrixText(c.selectedMatrix)}</p>
      <p>逆阵 R：{matrixText(c.inverse)}</p>
      <p>
        数学可恢复：{label(c.recoverable)}（recoverable）；最终 verified：
        {label(c.verified)}
      </p>
      <p>失败原因：{c.failureReason ?? '无'}</p>
      <p>恢复 SHA-256：{c.recoveredSha256 ?? 'null'}</p>
      {!c.recoverable && (
        <p role="alert">
          该方案未实际解码成功：逆阵与恢复数据均为 null，不显示虚构数据。
        </p>
      )}
    </section>
  )
}

export default function ComparisonPanel(props: ComparisonPanelProps) {
  const { frozenA, currentB, stale, onRefreeze } = props

  if (frozenA === null) {
    return (
      <section data-testid="comparison-panel">
        <h2>反事实对比</h2>
        <p data-testid="comparison-empty">尚未冻结 A：请先冻结当前方案，再与当前 B 对比。</p>
      </section>
    )
  }

  const diff = firstDifference(frozenA, currentB)
  const conclusion =
    frozenA.recoverable && !currentB.recoverable
      ? `结论：A 可恢复、B 不可恢复（${currentB.failureReason ?? '失败'}）`
      : !frozenA.recoverable && currentB.recoverable
        ? `结论：A 不可恢复（${frozenA.failureReason ?? '失败'}）、B 可恢复`
        : frozenA.recoverable && currentB.recoverable
          ? '结论：A、B 均可恢复'
          : '结论：A、B 均不可恢复'

  return (
    <section data-testid="comparison-panel">
      <h2>反事实对比</h2>
      {stale && (
        <p data-testid="comparison-stale" role="alert">
          比较已过期：原文或参数已修改，当前对比基于旧冻结，需重新冻结。
          {onRefreeze !== undefined && (
            <button type="button" data-testid="refreeze-button" onClick={onRefreeze}>
              重新冻结
            </button>
          )}
        </p>
      )}
      <div>
        <CaseBlock testid="case-a" c={frozenA} />
        <CaseBlock testid="case-b" c={currentB} />
      </div>
      <section data-testid="comparison-diff">
        <h3>比较结果</h3>
        <p>{conclusion}</p>
        <p>首个差异：{diff ?? '完全一致'}</p>
        <p>
          擦除集：{sameNumbers(frozenA.erased, currentB.erased) ? '相同' : '不同'}；
          存活数：{frozenA.alive.length === currentB.alive.length ? '相同' : '不同'}；
          可恢复性：{frozenA.recoverable === currentB.recoverable ? '相同' : '不同'}；
          选行：
          {sameNumbers(frozenA.selectedIndices, currentB.selectedIndices) ? '相同' : '不同'}；
          逆阵：{sameMatrix(frozenA.inverse, currentB.inverse) ? '相同' : '不同'}
        </p>
      </section>
    </section>
  )
}
