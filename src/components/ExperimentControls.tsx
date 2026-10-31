/**
 * P0002-T011 — 双输入和参数控件（角色 FRONTEND_UI）。
 *
 * 展示型受控组件（PROJECT_BOOK 输入与参数章节 / 实施计划 T011）：
 * - props 驱动：输入文本、模式、seed、长度、k/m 全部来自 props，
 *   任何变化都通过 onChange 类回调上报给父级（父级据此失效旧证据）；
 * - 组件自身不持有恢复结果、R、hash、byte proof，也不调用 encode/decode；
 * - 长度判定始终用字节数：utf8 模式 = TextEncoder().encode(text).length，
 *   seeded 模式 = 随机长度；页面上显示的是字节长度而非字符数；
 * - 校验：字节长度 >16384 阻止编码；k、m 必须为整数且 1≤k、1≤m、k+m≤16；
 *   seed 必须为 uint32 整数；任一校验失败显示错误并禁用编码按钮；
 * - 全部控件使用原生 button/input/textarea/checkbox/radio，label/htmlFor 配齐，
 *   Tab 顺序自然，不用 div 模拟按钮。
 */

import { DEFAULT_SEED, textToBytes } from '../features/input/generators'

export const MAX_INPUT_BYTES = 16384
export const MAX_N = 16

export type InputMode = 'utf8' | 'seeded'

export interface ExperimentControlsProps {
  /** 当前输入模式：utf8 文本 或 seeded 随机。 */
  mode: InputMode
  /** utf8 模式下的输入文本。 */
  text: string
  /** seeded 模式下的 seed 原始字符串（uint32 整数）。 */
  seed: string
  /** seeded 模式下的随机字节长度。 */
  length: string
  /** k（数据片）原始字符串。 */
  k: string
  /** m（校验片）原始字符串。 */
  m: string
  /** 父级是否持有可用编码（用于启用恢复按钮）。 */
  canRecover: boolean
  /** FIX-R1：父级是否允许本次编码（默认 true；已编码时父级可传 false 禁用）。 */
  canEncode?: boolean
  /** 父级计算进行中（禁用全部动作按钮）。 */
  busy: boolean
  onModeChange: (mode: InputMode) => void
  onTextChange: (text: string) => void
  onSeedChange: (seed: string) => void
  onLengthChange: (length: string) => void
  onKChange: (k: string) => void
  onMChange: (m: string) => void
  /** 编码请求：由父级执行 encode（组件不调用）。 */
  onEncode: () => void
  /** 恢复请求：由父级执行 decode（组件不调用）。 */
  onRecover: () => void
  /** 清空：父级重置输入与证据。 */
  onClear: () => void
}

function isUint32String(value: string): boolean {
  if (!/^\d+$/.test(value)) return false
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
}

interface ParsedParams {
  errors: string[]
  k: number
  m: number
  n: number
  byteLength: number
  seed: number
}

/** 从 props 计算真实字节长度与全部校验错误（不缓存、不伪造）。 */
export function computeValidation(props: ExperimentControlsProps): ParsedParams {
  const errors: string[] = []
  let byteLength = 0
  let seed = DEFAULT_SEED

  if (props.mode === 'utf8') {
    // 始终以 UTF-8 字节数判定，绝不用字符数。
    byteLength = textToBytes(props.text).length
    if (byteLength > MAX_INPUT_BYTES) {
      errors.push(
        `输入字节长度 ${byteLength} 超过上限 ${MAX_INPUT_BYTES} 字节，已禁止编码。`,
      )
    }
  } else {
    if (props.seed.trim() === '') {
      seed = DEFAULT_SEED
    } else if (!isUint32String(props.seed.trim())) {
      errors.push('seed 必须为 0 到 4294967295 之间的 uint32 整数。')
    } else {
      seed = Number(props.seed.trim())
    }
    const len = Number(props.length)
    if (!Number.isInteger(len) || len < 1 || len > MAX_INPUT_BYTES) {
      errors.push(`随机长度必须为 1 到 ${MAX_INPUT_BYTES} 之间的整数（以字节计）。`)
    } else {
      byteLength = len
    }
  }

  const k = Number(props.k)
  const m = Number(props.m)
  let n = 0
  if (!Number.isInteger(k) || k < 1) {
    errors.push('k（数据片）必须为不小于 1 的整数。')
  }
  if (!Number.isInteger(m) || m < 1) {
    errors.push('m（校验片）必须为不小于 1 的整数。')
  }
  if (Number.isInteger(k) && Number.isInteger(m) && k >= 1 && m >= 1) {
    n = k + m
    if (n > MAX_N) {
      errors.push(`k+m=${n} 超过上限 ${MAX_N}（n≤${MAX_N}），已禁止编码。`)
    }
  }

  return { errors, k, m, n, byteLength, seed }
}

export default function ExperimentControls(props: ExperimentControlsProps) {
  const {
    mode,
    text,
    seed,
    length,
    k,
    m,
    canRecover,
    canEncode = true,
    busy,
    onModeChange,
    onTextChange,
    onSeedChange,
    onLengthChange,
    onKChange,
    onMChange,
    onEncode,
    onRecover,
    onClear,
  } = props

  const validation = computeValidation(props)
  const hasErrors = validation.errors.length > 0
  const encodeDisabled = busy || hasErrors || !canEncode

  return (
    <section aria-label="实验输入与参数" className="experiment-controls">
      <fieldset className="control-mode">
        <legend>输入模式</legend>
        <input
          type="radio"
          id="mode-utf8"
          name="input-mode"
          checked={mode === 'utf8'}
          onChange={() => onModeChange('utf8')}
        />
        <label htmlFor="mode-utf8">UTF-8 文本输入</label>
        <input
          type="radio"
          id="mode-seeded"
          name="input-mode"
          checked={mode === 'seeded'}
          onChange={() => onModeChange('seeded')}
        />
        <label htmlFor="mode-seeded">seeded 随机输入</label>
      </fieldset>

      {mode === 'utf8' ? (
        <div className="control-field">
          <label htmlFor="input-text">输入文本（UTF-8，长度按字节计）</label>
          <textarea
            id="input-text"
            rows={4}
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
          />
        </div>
      ) : (
        <>
          <div className="control-field">
            <label htmlFor="input-seed">seed（uint32，默认 0xC0FFEE11 = {DEFAULT_SEED}）</label>
            <input
              id="input-seed"
              type="text"
              inputMode="numeric"
              value={seed}
              placeholder={`留空使用默认 ${DEFAULT_SEED}`}
              onChange={(e) => onSeedChange(e.target.value)}
            />
          </div>
          <div className="control-field">
            <label htmlFor="input-length">随机字节长度</label>
            <input
              id="input-length"
              type="number"
              min={1}
              max={MAX_INPUT_BYTES}
              step={1}
              value={length}
              onChange={(e) => onLengthChange(e.target.value)}
            />
          </div>
        </>
      )}

      <div className="control-field">
        <label htmlFor="param-k">k（数据片）</label>
        <input
          id="param-k"
          type="number"
          min={1}
          max={MAX_N}
          step={1}
          value={k}
          onChange={(e) => onKChange(e.target.value)}
        />
      </div>
      <div className="control-field">
        <label htmlFor="param-m">m（校验片）</label>
        <input
          id="param-m"
          type="number"
          min={1}
          max={MAX_N}
          step={1}
          value={m}
          onChange={(e) => onMChange(e.target.value)}
        />
      </div>

      <p className="control-bytelength" aria-live="polite" data-testid="byte-length">
        输入字节长度：{validation.byteLength} 字节（上限 {MAX_INPUT_BYTES}）
      </p>

      {hasErrors ? (
        <ul className="control-errors" role="alert" data-testid="input-errors">
          {validation.errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      ) : (
        <p className="control-ok" aria-live="polite">
          参数有效：n=k+m={validation.n}。
        </p>
      )}

      <div className="control-actions">
        <button type="button" onClick={onEncode} disabled={encodeDisabled}>
          编码
        </button>
        <button type="button" onClick={onRecover} disabled={busy || !canRecover}>
          恢复
        </button>
        <button type="button" onClick={onClear} disabled={busy}>
          清空
        </button>
      </div>
    </section>
  )
}
