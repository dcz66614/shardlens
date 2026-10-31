/**
 * P0002-T014 — 逐字节检查器与双向联动（角色 FRONTEND_UI）。
 *
 * 实施计划 T014 / PROJECT_BOOK §8、§10.3：
 * - 偏移选择：数字输入框 + 真实 <button> 确认/步进；范围验证为整数且
 *   0 <= offset < original_len，非法输入显示错误信息，且绝不读取越界字节
 *   （explainByte 的 RangeError 守卫兜底，验证前不访问任何分片字节）。
 * - 对当前有效偏移调用 explainByte() 实时计算（复用 T013 求解逻辑，不另写
 *   一套求解器；原文字节仅由 explainByte 事后比对给出 expected_byte）。
 * - 完整展示计算项：data_shard_index / shard_offset、系数行 R[d,:]、每项
 *   survivor_index / coefficient / input_byte / product / xor_accumulator、
 *   result_byte / expected_byte / equal —— 缺一不可，不得只显示一个 hex。
 * - 空态：无输入、未解码或 original_len 为 0 时显示“无字节”空态；解码失败
 *   显示 failureReason 与空态，不展示伪造原文。
 * - 双向联动：点击计算项通过 onLocateShard(survivor_index, shard_offset)
 *   跳转碎片墙；点击系数行通过 onLocateMatrix(data_shard_index, col) 跳转矩阵。
 * - 数字一律十进制与十六进制双显（如 66 (0x42)）。
 */

import { useMemo, useState } from 'react'
import { explainByte } from '../core/evidence'
import type { ByteEvidence, DecodeResult, EncodeResult } from '../core/types'

export interface ByteInspectorProps {
  /** 编码结果（含分片真实字节与原文，仅用于 explainByte 事后比对）。 */
  encoded: EncodeResult | null
  /** 解码结果（含 R = inverse 与 recovered；失败时不展示伪造计算项）。 */
  decoded: DecodeResult | null
  /** 定位到矩阵第 row 行第 col 列（R / G 等工作台联动）。 */
  onLocateMatrix?: (row: number, col: number) => void
  /** 定位到碎片墙第 shardIndex 片、片内偏移 shardOffset。 */
  onLocateShard?: (shardIndex: number, shardOffset: number) => void
  /** 初始偏移（可选，默认 0）。 */
  initialOffset?: number
}

/** 十进制与十六进制双显，如 66 (0x42)。 */
function dual(v: number): string {
  const hex = Math.max(0, v & 0xff).toString(16).padStart(2, '0')
  return `${v} (0x${hex})`
}

export default function ByteInspector(props: ByteInspectorProps) {
  const { encoded, decoded, onLocateMatrix, onLocateShard } = props

  const originalLen = decoded?.recovered?.length ?? 0
  const failed = decoded !== null && !decoded.recoverable
  const hasBytes = encoded !== null && decoded !== null && decoded.recoverable && originalLen > 0

  const [draft, setDraft] = useState<string>(() =>
    props.initialOffset === undefined ? '0' : String(props.initialOffset),
  )
  const [offset, setOffset] = useState<number | null>(() => {
    const init = props.initialOffset
    return init !== undefined && Number.isInteger(init) && init >= 0 ? init : 0
  })
  const [rangeError, setRangeError] = useState<string | null>(null)

  /** 范围验证：整数且 0 <= offset < originalLen；非法时绝不更新有效偏移。 */
  function validateAndApply(raw: string): void {
    if (!hasBytes) return
    const trimmed = raw.trim()
    const value = trimmed === '' ? Number.NaN : Number(trimmed)
    if (!Number.isInteger(value)) {
      setRangeError(`偏移必须是整数，收到：${trimmed === '' ? '（空）' : trimmed}`)
      return
    }
    if (value < 0 || value >= originalLen) {
      setRangeError(`偏移越界：${value} 不在 [0, ${originalLen}) 范围内`)
      return
    }
    setRangeError(null)
    setOffset(value)
  }

  function step(delta: number): void {
    const base = offset ?? 0
    validateAndApply(String(base + delta))
    if (base + delta >= 0 && base + delta < originalLen) {
      setDraft(String(base + delta))
    }
  }

  // 对当前有效偏移实时计算证据；范围验证已通过，explainByte 的 RangeError
  // 作为第二道守卫，任何异常都转为错误显示而非越界读取（渲染期不 setState）。
  const { evidence, computeError } = useMemo<{
    evidence: ByteEvidence | null
    computeError: string | null
  }>(() => {
    if (!hasBytes || encoded === null || decoded === null || offset === null) {
      return { evidence: null, computeError: null }
    }
    if (!Number.isInteger(offset) || offset < 0 || offset >= originalLen) {
      return { evidence: null, computeError: null }
    }
    try {
      return { evidence: explainByte(encoded, decoded, offset), computeError: null }
    } catch (err) {
      return {
        evidence: null,
        computeError: err instanceof Error ? err.message : String(err),
      }
    }
  }, [hasBytes, encoded, decoded, offset, originalLen])

  const k = decoded?.selectedIndices.length ?? 0

  return (
    <section aria-label="逐字节检查器" className="byte-inspector" data-testid="byte-inspector">
      <h3>逐字节取证</h3>

      {/* —— 空态 / 失败态 —— */}
      {!hasBytes && (
        <div data-testid="byte-empty" className="byte-empty" aria-live="polite">
          {failed && (
            <p data-testid="byte-failure" className="byte-failure">
              解码失败：<code>{decoded?.failureReason ?? 'UNKNOWN'}</code>
            </p>
          )}
          <p>无字节</p>
          <p className="byte-empty-hint">
            {failed
              ? '存活分片不足或矩阵不可逆，不存在恢复字节，不展示任何计算项。'
              : '尚无已解码的原始字节（无输入、未解码或原文长度为 0）。'}
          </p>
        </div>
      )}

      {/* —— 偏移选择 —— */}
      {hasBytes && (
        <div className="offset-picker">
          <label htmlFor="byte-offset-input">字节偏移（0..{originalLen - 1}）</label>
          <input
            id="byte-offset-input"
            data-testid="offset-input"
            type="number"
            inputMode="numeric"
            min={0}
            max={originalLen - 1}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            data-testid="offset-confirm"
            onClick={() => validateAndApply(draft)}
          >
            确认
          </button>
          <button type="button" data-testid="offset-prev" onClick={() => step(-1)}>
            上一字节
          </button>
          <button type="button" data-testid="offset-next" onClick={() => step(1)}>
            下一字节
          </button>
        </div>
      )}

      {(rangeError !== null || computeError !== null) && (
        <p data-testid="offset-error" className="offset-error" role="alert">
          {rangeError ?? computeError}
        </p>
      )}

      {/* —— 单字节代数证明 —— */}
      {hasBytes && evidence !== null && (
        <div data-testid="byte-proof" className="byte-proof">
          <p className="byte-locate" aria-live="polite">
            偏移 {evidence.offset}：数据片 D{evidence.data_shard_index}（data_shard_index=
            {evidence.data_shard_index}），片内偏移 shard_offset={evidence.shard_offset}
          </p>

          {/* 系数行 R[d,:]，可点击定位矩阵行列 */}
          <div className="coeff-row">
            <span>
              系数行 R[{evidence.data_shard_index}, :]（点击列定位矩阵）：
            </span>
            <ul data-testid="coefficient-row" className="coeff-list">
              {evidence.coefficient_row.map((coef, col) => (
                <li key={col}>
                  <button
                    type="button"
                    data-testid={`coeff-${col}`}
                    title={`定位矩阵 R[${evidence.data_shard_index}, ${col}]`}
                    onClick={() => onLocateMatrix?.(evidence.data_shard_index, col)}
                  >
                    {dual(coef)}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* 计算项表：每项可点击定位对应分片 */}
          <table data-testid="byte-terms" className="byte-terms">
            <thead>
              <tr>
                <th scope="col">项</th>
                <th scope="col">survivor_index</th>
                <th scope="col">coefficient</th>
                <th scope="col">input_byte</th>
                <th scope="col">product</th>
                <th scope="col">xor_accumulator</th>
              </tr>
            </thead>
            <tbody>
              {evidence.terms.map((t, j) => (
                <tr key={j} data-testid={`byte-term-${j}`}>
                  <th scope="row">{j}</th>
                  <td>
                    <button
                      type="button"
                      data-testid={`term-shard-${j}`}
                      title={`定位分片 ${t.survivor_index} 片内偏移 ${evidence.shard_offset}`}
                      onClick={() =>
                        onLocateShard?.(t.survivor_index, evidence.shard_offset)
                      }
                    >
                      分片 {t.survivor_index}
                    </button>
                  </td>
                  <td>{dual(t.coefficient)}</td>
                  <td>{dual(t.input_byte)}</td>
                  <td>{dual(t.product)}</td>
                  <td>{dual(t.xor_accumulator)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 结果 / 期望 / 相等性 */}
          <p data-testid="byte-result" className="byte-result" aria-live="polite">
            result_byte: {dual(evidence.result_byte)}　expected_byte:{' '}
            {dual(evidence.expected_byte)}　equal:{' '}
            <strong data-testid="byte-equal">{String(evidence.equal)}</strong>
            {k > 0 && `　（共 ${k} 项 GF 乘积异或累计）`}
          </p>
        </div>
      )}
    </section>
  )
}
