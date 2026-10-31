// P0002-T021 FRONTEND_INTEGRATION — 导入导出 UI 与独立 I/O 测试。
//
// 覆盖（实施计划 T021）：
// - 成功实验往返：真实 encode → 擦除 [1,4] → session 恢复 → export →
//   serialize → import，恢复字节、G、原文 SHA、逐字节证据全等；
// - 失败实验往返：擦除 [1,4,5] → INSUFFICIENT_SHARDS，失败文件本身
//   可合法导入且矩阵/证据/恢复字节按 §9.1 置空；
// - seeded_random 往返：100 字节种子输入恢复字节与原文相等；
// - 篡改拒绝带字段路径（product 一项）；
// - ExperimentIOPanel：隐私提示、导出按钮/摘要/进度、导入文本转发、
//   错误原文（含路径）展示、失败导入保持旧导出摘要、失败案例保存回调；
// - 导入后全字节证明仍可逐位置访问（explainByte 偏移 1 得 66）。
//
// 反作弊约定：全部样例均由真实 encode/recover/export 生成，不手写
// 恢复字节与矩阵；篡改项只改序列化文本后重新导入，断言拒绝路径。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ExperimentIOPanel from '../src/components/ExperimentIOPanel'
import type {
  ExportSummary,
  ImportSuccessSummary,
} from '../src/components/ExperimentIOPanel'
import { encode } from '../src/core/encode'
import { recoverExperiment } from '../src/state/session'
import { generateRandomBytes } from '../src/features/input/generators'
import {
  assertShardlensFileName,
  buildExperimentFileName,
  exportExperiment,
  importExperiment,
  serializeExperimentFile,
} from '../src/io/experiment_io'
import { explainByte } from '../src/core/evidence'

afterEach(() => {
  cleanup()
})

const ABC = new TextEncoder().encode('ABC')

function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a === null || a.length !== b.length) return false
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** 真实链路生成导出文本：encode → 恢复 → export → serialize。 */
async function buildExportText(
  original: Uint8Array,
  erased: number[],
  opts: {
    inputMode: 'utf8' | 'seeded_random'
    inputText: string | null
    randomSeed: number | null
    experimentId: string
  },
): Promise<string> {
  const encoded = await encode(original, 4, 2)
  const outcome = await recoverExperiment(encoded, erased)
  const file = await exportExperiment({
    encoded,
    decoded: outcome.decode,
    erasedIndices: erased,
    input_mode: opts.inputMode,
    input_text: opts.inputText,
    random_seed: opts.randomSeed,
    experiment_id: opts.experimentId,
  })
  return serializeExperimentFile(file)
}

function panelProps(overrides: Partial<ComponentProps<typeof ExperimentIOPanel>> = {}) {
  const exportSummary: ExportSummary = {
    fileName: 't021-success.shardlens.json',
    text: '{"spec_version":"1.0.0"}',
    byteSize: 27,
    provenanceCount: 3,
    originalLen: 3,
  }
  return {
    exportFile: exportSummary,
    exportBusy: false,
    onRequestExport: vi.fn(),
    importBusy: false,
    importError: null as string | null,
    importSuccess: null as ImportSuccessSummary | null,
    onImportText: vi.fn(),
    ...overrides,
  }
}

describe('T021 success round-trip', () => {
  it('ABC 擦除 [1,4] 导出再导入：同字节同矩阵同 SHA，证据 3 条', async () => {
    const text = await buildExportText(ABC, [1, 4], {
      inputMode: 'utf8',
      inputText: 'ABC',
      randomSeed: null,
      experimentId: 't021-success',
    })
    const imported = await importExperiment(text)
    const file = imported.file
    expect(file.spec_version).toBe('1.0.0')
    expect(file.slug).toBe('shardlens')
    expect(file.experiment_id).toBe('t021-success')
    expect(bytesEqual(imported.decoded.recovered, ABC)).toBe(true)
    expect(imported.encoded.G).toEqual(file.encoding_matrix)
    expect(file.original_sha256).toBe(file.recovered_sha256)
    expect(file.byte_equal).toBe(true)
    expect(file.byte_provenance.length).toBe(3)
    const ev1 = file.byte_provenance[1]!
    expect(ev1.coefficient_row).toEqual([234, 46, 13, 200])
    expect(ev1.terms.map((t) => t.product)).toEqual([242, 61, 0, 141])
    expect(ev1.terms.map((t) => t.xor_accumulator)).toEqual([242, 207, 207, 66])
    expect(ev1.result_byte).toBe(66)
    expect(ev1.equal).toBe(true)
    expect(file.verification.byte_checked_count).toBe(3)
  })

  it('导入后全字节证明仍可逐位置访问：偏移 1 得 66', async () => {
    const text = await buildExportText(ABC, [1, 4], {
      inputMode: 'utf8',
      inputText: 'ABC',
      randomSeed: null,
      experimentId: 't021-success',
    })
    const imported = await importExperiment(text)
    const ev = explainByte(imported.encoded, imported.decoded, 1)
    expect(ev.result_byte).toBe(66)
    expect(ev.terms.map((t) => t.product)).toEqual([242, 61, 0, 141])
  })

  it('seeded_random 100 字节往返：恢复字节等于原文，证据 100 条', async () => {
    const original = generateRandomBytes(100, 0xc0ffee11)
    const text = await buildExportText(original, [1, 4], {
      inputMode: 'seeded_random',
      inputText: null,
      randomSeed: 0xc0ffee11,
      experimentId: 't021-seeded',
    })
    const imported = await importExperiment(text)
    expect(imported.file.input_mode).toBe('seeded_random')
    expect(imported.file.random_seed).toBe(0xc0ffee11)
    expect(bytesEqual(imported.decoded.recovered, original)).toBe(true)
    expect(imported.file.byte_provenance.length).toBe(100)
  })
})

describe('T021 failure round-trip', () => {
  it('ABC 擦除 [1,4,5] 失败文件可合法导入，置空约定成立', async () => {
    const text = await buildExportText(ABC, [1, 4, 5], {
      inputMode: 'utf8',
      inputText: 'ABC',
      randomSeed: null,
      experimentId: 't021-failure',
    })
    const imported = await importExperiment(text)
    const file = imported.file
    expect(file.failure_reason).toBe('INSUFFICIENT_SHARDS')
    expect(file.recoverable).toBe(false)
    expect(file.recovered_payload_base64).toBeNull()
    expect(file.recovered_sha256).toBeNull()
    expect(file.recovery_matrix).toBeNull()
    expect(file.byte_provenance).toEqual([])
    expect(file.selected_survivor_indices).toEqual([])
    expect(file.ignored_survivor_indices).toEqual(file.surviving_indices)
  })
})

describe('T021 tamper rejection', () => {
  it('篡改 byte_provenance product 被拒绝，路径指向该项', async () => {
    const text = await buildExportText(ABC, [1, 4], {
      inputMode: 'utf8',
      inputText: 'ABC',
      randomSeed: null,
      experimentId: 't021-success',
    })
    const parsed = JSON.parse(text) as Record<string, unknown>
    const provenance = parsed['byte_provenance'] as Array<Record<string, unknown>>
    const terms = provenance[1]!['terms'] as Array<Record<string, unknown>>
    terms[0]!['product'] = 999
    let path = ''
    await expect(
      importExperiment(JSON.stringify(parsed)),
    ).rejects.toThrowError(/byte_provenance\[1\]\.terms\[0\]\.product/)
    try {
      await importExperiment(JSON.stringify(parsed))
    } catch (err) {
      path = (err as { path?: string }).path ?? ''
    }
    expect(path).toBe('byte_provenance[1].terms[0].product')
  })
})

describe('T021 filename rules', () => {
  it('buildExperimentFileName 生成严格 .shardlens.json 后缀', () => {
    expect(buildExperimentFileName('exp-1')).toBe('exp-1.shardlens.json')
  })

  it('assertShardlensFileName 拒绝非标准后缀与空干', () => {
    expect(() => assertShardlensFileName('x.json')).toThrow()
    expect(() => assertShardlensFileName('')).toThrow()
    expect(() => assertShardlensFileName('.shardlens.json')).toThrow()
  })
})

describe('T021 ExperimentIOPanel', () => {
  it('常驻隐私提示、导出按钮回调与导出摘要/进度', async () => {
    const user = userEvent.setup()
    const props = panelProps()
    render(createElement(ExperimentIOPanel, props))
    expect(screen.getByTestId('io-privacy-note').textContent).toMatch(/base64/)
    expect(screen.getByTestId('io-privacy-note').textContent).toMatch(/本地生成/)
    await user.click(screen.getByTestId('io-export-button'))
    expect(props.onRequestExport).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('io-export-filename').textContent).toBe(
      't021-success.shardlens.json',
    )
    expect(screen.getByTestId('io-export-size').textContent).toBe('27 字节')
    expect(screen.getByTestId('io-export-progress').textContent).toBe('字节证据 3 / 3')
    expect(
      (screen.getByTestId('io-export-text') as HTMLTextAreaElement).value,
    ).toBe('{"spec_version":"1.0.0"}')
  })

  it('导入文本框内容原样转发给 onImportText', async () => {
    const user = userEvent.setup()
    const props = panelProps()
    render(createElement(ExperimentIOPanel, props))
    const tampered = '{"spec_version":"1.0.0","tampered":true}'
    // JSON 花括号会被 userEvent.type 解析为按键描述，故用 fireEvent 设值。
    fireEvent.change(screen.getByTestId('io-import-textarea'), {
      target: { value: tampered },
    })
    await user.click(screen.getByTestId('io-import-button'))
    expect(props.onImportText).toHaveBeenCalledTimes(1)
    expect(props.onImportText).toHaveBeenCalledWith(tampered)
  })

  it('失败导入展示含路径的错误原文，且旧导出摘要保持可见', async () => {
    const user = userEvent.setup()
    const props = panelProps()
    const { rerender } = render(createElement(ExperimentIOPanel, props))
    // 无 jest-dom 匹配器：getByTestId 找不到即抛错，本身即断言。
    screen.getByTestId('io-export-filename')
    const errText =
      'import: [byte_provenance[1].terms[0].product] recomputed product mismatch'
    rerender(
      createElement(ExperimentIOPanel, {
        ...props,
        importError: errText,
        onSaveFailureCase: vi.fn(),
      }),
    )
    expect(screen.getByTestId('io-import-error').textContent).toBe(errText)
    expect(screen.getByTestId('io-import-error').textContent).toMatch(
      /byte_provenance\[1\]\.terms\[0\]\.product/,
    )
    // 旧状态未被清除：导出摘要仍在。
    expect(screen.getByTestId('io-export-filename').textContent).toBe(
      't021-success.shardlens.json',
    )
    screen.getByTestId('io-save-failure-case')
    await user.click(screen.getByTestId('io-save-failure-case'))
  })

  it('失败案例保存按钮调用 onSaveFailureCase', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      createElement(ExperimentIOPanel, {
        ...panelProps(),
        importError: 'import: [byte_equal] mismatch',
        onSaveFailureCase: onSave,
      }),
    )
    await user.click(screen.getByTestId('io-save-failure-case'))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('导入成功摘要显示 experiment_id 与校验结论', () => {
    render(
      createElement(ExperimentIOPanel, {
        ...panelProps(),
        importSuccess: {
          experimentId: 't021-success',
          byteEqual: true,
          recoverable: true,
          failureReason: null,
        },
      }),
    )
    const el = screen.getByTestId('io-import-success')
    expect(el.textContent).toMatch(/t021-success/)
    expect(el.textContent).toMatch(/byte_equal=true/)
    expect(el.textContent).toMatch(/recoverable=true/)
  })

  it('未导出时显示尚未导出', () => {
    render(createElement(ExperimentIOPanel, panelProps({ exportFile: null })))
    expect(screen.getByTestId('io-export-empty').textContent).toBe('尚未导出')
  })
})
