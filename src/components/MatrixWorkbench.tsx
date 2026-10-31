/**
 * P0002-T012 — 数学矩阵工作台与消元回放（角色 FRONTEND_MATH_UI）。
 *
 * 展示 + 交互组件（实施计划 P0002-T012 / PROJECT_BOOK §7.2、§7.4、§12.1）：
 * - 由 buildSystematicMatrix(k, m) 实时计算系统型生成矩阵 G，不硬编码矩阵数字；
 * - 交互式选择恰好 k 个存活行（默认前 k 行升序），高亮 G 表中的存活行；
 * - FIX-R1（终审第 1 轮 B2 修复）：新增 followSurvivors 跟随属性。父级传入
 *   当前实验的存活集时，工作台的初始/跟随选择即为该集合（而非脱离实验的
 *   独立默认选择）；父级不传时保持原有默认行为。用户仍可手动切换行做
 *   反事实推演，直到实验存活集再次变化时重新跟随。
 * - 对 Gs = G[存活行,:] 调用 invertWithTrace 求逆 R 与 GFStep[] 轨迹；
 * - 逐步回放真实增广矩阵快照（before/after 来自轨迹，非装饰性矩阵），
 *   最终快照右半阵等于 R；
 * - 所有数字均来自真实计算（rs_matrix.ts 数学结果不变）。
 */

import { useEffect, useMemo, useState } from 'react'
import { buildSystematicMatrix, invertWithTrace } from '../core/rs_matrix'
import type { GFStep, Matrix } from '../core/types'

export interface MatrixWorkbenchProps {
  /** 数据片数，默认 4。 */
  k?: number
  /** 校验片数，默认 2（即 RS(6,4)）。 */
  m?: number
  /**
   * FIX-R1：当前实验的存活集（升序）。传入时工作台跟随该集合作为选择；
   * 不传时保持原有默认（前 k 行）。手动切换后仍可反事实推演，直到该
   * 集合变化时重新跟随。
   */
  followSurvivors?: number[]
}

const OPS: Record<GFStep['op'], string> = {
  pivot_select: 'pivot_select（选主元）',
  swap: 'swap（交换行）',
  scale: 'scale（主元行缩放）',
  eliminate: 'eliminate（消元）',
}

function rowLabel(i: number, k: number): string {
  return i < k ? `D${i}` : `P${i - k}`
}

function colLabel(c: number): string {
  return `D${c}`
}

/** 原始选择去重、过滤越界并升序；仅恰好 k 行时才作为存活行参与计算。 */

export default function MatrixWorkbench(props: MatrixWorkbenchProps) {
  const k = props.k ?? 4
  const m = props.m ?? 2
  const n = k + m

  const G = useMemo(() => buildSystematicMatrix(k, m), [k, m])

  const [selected, setSelected] = useState<number[]>(() =>
    Array.from({ length: k }, (_, i) => i),
  )
  // FIX-R1 跟随：实验存活集变化时同步选择（手动切换在集合不变时不受干扰）。
  const followKey =
    props.followSurvivors === undefined
      ? null
      : [...props.followSurvivors].sort((a, b) => a - b).join(',')
  useEffect(() => {
    if (followKey === null) return
    setSelected(
      followKey === ''
        ? []
        : followKey.split(',').map((v) => Number(v)),
    )
    setCursor(0)
  }, [followKey])
  // 用户当前勾选的行（去重、过滤越界、升序）；只有恰好 k 行时才构成存活集。
  const picked = [...new Set(selected.filter((i) => Number.isInteger(i) && i >= 0 && i < n))].sort(
    (a, b) => a - b,
  )
  const pickedSet = new Set(picked)
  const survivors = picked.length === k ? picked : []

  const { inverse, steps } = useMemo(() => {
    if (survivors.length !== k) {
      return { inverse: null as Matrix | null, steps: [] as GFStep[] }
    }
    try {
      const gs: Matrix = survivors.map((r) => (G[r] ?? []).slice())
      return invertWithTrace(gs)
    } catch {
      return { inverse: null as Matrix | null, steps: [] as GFStep[] }
    }
  }, [G, survivors, k])

  const [cursor, setCursor] = useState(0)
  const total = steps.length
  const clampedCursor = Math.min(cursor, Math.max(total - 1, 0))

  // 当前快照：未前进一步时显示 steps[0].before；第 i 步后显示 steps[i].after。
  const snapshot: Matrix = useMemo(() => {
    if (total === 0) return []
    if (clampedCursor <= 0) return steps[0]!.before
    return steps[clampedCursor]!.after
  }, [steps, clampedCursor, total])

  const currentStep: GFStep | null =
    total > 0 && clampedCursor > 0 ? steps[clampedCursor]! : null

  function toggleSurvivor(i: number): void {
    // 原始勾选：已选则取消；未选且不足 k 行则加入；已满 k 行时点击未选行不做任何事。
    // 这样一次点击必然真实改变选择（或在已满时明确无变化），不会被规范化悄悄抵消。
    setSelected((prev) => {
      const set = new Set(prev.filter((x) => Number.isInteger(x) && x >= 0 && x < n))
      if (set.has(i)) {
        set.delete(i)
      } else if (set.size < k) {
        set.add(i)
      }
      return [...set].sort((a, b) => a - b)
    })
    setCursor(0)
  }

  const hasInverse = inverse !== null && total > 0

  return (
    <section aria-label="矩阵工作台" className="matrix-workbench">
      <h3>矩阵工作台 · RS({n},{k}) 消元回放</h3>

      {/* —— 生成矩阵 G —— */}
      <div className="wb-block">
        <h4>
          生成矩阵 G（{n}×{k}，系统型，来自 buildSystematicMatrix）
        </h4>
        <table className="wb-matrix" data-testid="g-matrix">
          <thead>
            <tr>
              <th scope="col">行\列</th>
              {Array.from({ length: k }, (_, c) => (
                <th key={c} scope="col">
                  {colLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {G.map((row, r) => {
              const isSurvivor = pickedSet.has(r)
              return (
                <tr
                  key={r}
                  data-testid={`survivor-row-${r}`}
                  className={isSurvivor ? 'wb-row-survivor' : 'wb-row-lost'}
                  data-survivor={String(isSurvivor)}
                >
                  <th scope="row">
                    {rowLabel(r, k)}
                    {isSurvivor ? ' ✓' : ''}
                  </th>
                  {row.map((val, c) => (
                    <td key={c} data-testid={`matrix-cell-${r}-${c}`}>
                      {val}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* —— 存活行选择 —— */}
      <div className="wb-block">
        <h4>
          存活行选择（必须恰好 {k} / {n} 行）
        </h4>
        {G.map((_, r) => {
          const isSurvivor = pickedSet.has(r)
          return (
            <button
              key={r}
              type="button"
              aria-pressed={isSurvivor}
              className={`wb-toggle${isSurvivor ? ' wb-toggle-on' : ''}`}
              onClick={() => toggleSurvivor(r)}
            >
              {isSurvivor ? '☑' : '☐'} {rowLabel(r, k)}（行 {r}）
            </button>
          )
        })}
        <p>
          当前勾选行索引：[{picked.join(', ')}]
          {picked.length === k
            ? '（已满 k 行，正在回放该存活集的求逆轨迹）'
            : `（还需选择 ${k - picked.length} 行，选满 ${k} 行后才显示求逆轨迹）`}
        </p>
        {props.followSurvivors !== undefined && (
          <p data-testid="follow-survivors">
            跟随当前实验存活集：[{[...props.followSurvivors].sort((a, b) => a - b).join(', ')}]
          </p>
        )}
      </div>

      {/* —— 回放控制 —— */}
      <div className="wb-block">
        <h4>高斯-约当消元回放（Gs = G[存活行,:] 的求逆轨迹）</h4>
        <button
          type="button"
          data-testid="btn-prev"
          disabled={!hasInverse || clampedCursor <= 0}
          onClick={() => setCursor((c) => Math.max(c - 1, 0))}
        >
          上一步
        </button>
        <button
          type="button"
          data-testid="btn-next"
          disabled={!hasInverse || clampedCursor >= total - 1}
          onClick={() => setCursor((c) => Math.min(c + 1, total - 1))}
        >
          下一步
        </button>
        <span className="wb-counter">
          {hasInverse ? `Step ${clampedCursor} of ${total}` : '无可用轨迹'}
        </span>
      </div>

      {/* —— 单步信息 —— */}
      <div className="wb-block" data-testid="step-info">
        {currentStep === null ? (
          <p>
            {picked.length !== k
              ? `请先选择恰好 ${k} 行存活行（当前 ${picked.length} 行），暂无轨迹可回放。`
              : hasInverse
                ? '初始快照（第一步执行前的增广矩阵 [Gs | I]）'
                : '求逆失败（如 SINGULAR_MATRIX），无轨迹可回放。'}
          </p>
        ) : (
          <ul>
            <li>seq: {currentStep.seq}</li>
            <li>
              op: {currentStep.op}（{OPS[currentStep.op]}）
            </li>
            <li>pivot_col: {currentStep.pivot_col}</li>
            <li>row_a: {currentStep.row_a}</li>
            <li>row_b: {currentStep.row_b === null ? '—' : currentStep.row_b}</li>
            <li>
              factor:{' '}
              {currentStep.factor === null ? '—' : `0x${currentStep.factor.toString(16).padStart(2, '0')}`}
            </li>
          </ul>
        )}
      </div>

      {/* —— 增广矩阵快照 —— */}
      <div className="wb-block">
        <h4>
          当前增广矩阵快照（左半 = Gs，右半 = 累计变换；{k}×{2 * k}）
        </h4>
        <table className="wb-matrix" data-testid="aug-matrix">
          <thead>
            <tr>
              <th scope="col">行\列</th>
              {Array.from({ length: 2 * k }, (_, c) => (
                <th key={c} scope="col" className={c < k ? 'wb-col-gs' : 'wb-col-inv'}>
                  {c < k ? colLabel(c) : `I${c - k}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snapshot.map((row, r) => (
              <tr key={r}>
                <th scope="row">{rowLabel(r, k)}</th>
                {row.map((val, c) => (
                  <td
                    key={c}
                    data-testid={`matrix-cell-${r}-${c}`}
                    className={c < k ? 'wb-col-gs' : 'wb-col-inv'}
                  >
                    {val}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* —— 逆矩阵 R —— */}
      <div className="wb-block">
        <h4>逆矩阵 R = Gs⁻¹（来自 invertWithTrace）</h4>
        {inverse === null ? (
          <p>（不可用）</p>
        ) : (
          <table className="wb-matrix" data-testid="r-matrix">
            <tbody>
              {inverse.map((row, r) => (
                <tr key={r}>
                  <th scope="row">D{r}</th>
                  {row.map((val, c) => (
                    <td key={c}>{val}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="wb-note">
          最终快照（Step {Math.max(total - 1, 0)}）右半阵应与上表 R 一致。
        </p>
      </div>
    </section>
  )
}
