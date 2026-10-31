/**
 * P0002-T010 — 真实 D/P 碎片墙（角色 FRONTEND_UI）。
 *
 * 展示型组件（PROJECT_BOOK §10 中央碎片墙 / 实施计划 T010）：
 * - 只渲染 props 传入的 `shards` 与升序擦除集 `erased`，不在组件内维护擦除状态；
 * - 不调用 encode/decode、不读取 original；擦除/恢复动作仅通过 onToggleErase 上报索引；
 * - 每片显示真实数据：D/P 标签与 kind、全局索引、片字节长度、hex 预览、
 *   完整 sha256（截断显示、title 给完整值）与明确状态文字（存活 / 已擦除）；
 * - 底部汇总：总片数、存活数、已擦除数、擦除集。
 */

import type { Shard } from '../core/types'

export interface ShardWallProps {
  /** 编码产生的真实分片，按全局 index 升序展示。 */
  shards: Shard[]
  /** 升序全局擦除索引。 */
  erased: number[]
  /** 擦除/恢复回调，参数为该分片的全局索引。 */
  onToggleErase: (index: number) => void
  /** 禁用所有擦除/恢复按钮（如恢复计算进行中）。 */
  disabled?: boolean
}

const HEX_PREVIEW_MAX = 16

function hexPreview(bytes: Uint8Array, max = HEX_PREVIEW_MAX): string {
  const n = Math.min(bytes.length, max)
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    parts.push((bytes[i] ?? 0).toString(16).padStart(2, '0'))
  }
  return bytes.length > max ? `${parts.join(' ')} …` : parts.join(' ')
}

const KIND_LABEL: Record<Shard['kind'], string> = {
  data: '数据片',
  parity: '校验片',
}

export default function ShardWall(props: ShardWallProps) {
  const { shards, erased, onToggleErase, disabled = false } = props
  const erasedSet = new Set(erased)
  const total = shards.length
  const erasedCount = erased.length
  const aliveCount = total - erasedCount

  return (
    <section aria-label="分片墙" className="shard-wall">
      <ul className="shard-list">
        {shards.map((s) => {
          const isErased = erasedSet.has(s.index)
          return (
            <li
              key={s.index}
              data-testid={`shard-${s.index}`}
              data-kind={s.kind}
              data-erased={String(isErased)}
              className={`shard shard-${s.kind}${isErased ? ' shard-erased' : ''}`}
            >
              <header className="shard-head">
                <strong>{s.label}</strong>
                <span>（{KIND_LABEL[s.kind]}）</span>
                <span className="shard-index">index {s.index}</span>
                <span
                  className={isErased ? 'shard-status-erased' : 'shard-status-alive'}
                  aria-live="polite"
                >
                  {isErased ? '已擦除' : '存活'}
                </span>
              </header>
              <div className="shard-body">
                <span className="shard-len">片长：{s.bytes.length} 字节</span>
                <span className="shard-hex" title={hexPreview(s.bytes, s.bytes.length)}>
                  hex: {hexPreview(s.bytes)}
                </span>
                <span className="shard-sha" title={s.sha256}>
                  sha256: {s.sha256.slice(0, 16)}…
                </span>
              </div>
              <button
                type="button"
                data-testid={`toggle-${s.index}`}
                aria-pressed={isErased}
                disabled={disabled}
                onClick={() => onToggleErase(s.index)}
              >
                {isErased ? '恢复' : '擦除'}
              </button>
            </li>
          )
        })}
      </ul>
      <p className="shard-summary" aria-live="polite">
        总片数：{total}　存活：{aliveCount}　已擦除：{erasedCount}　擦除集：[{erased.join(', ')}]
      </p>
    </section>
  )
}
