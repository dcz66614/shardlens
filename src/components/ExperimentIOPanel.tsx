/**
 * P0002-T021 — 导入导出 UI 与独立 I/O 测试（角色 FRONTEND_INTEGRATION）。
 *
 * 展示型集成面板（PROJECT_BOOK §9 / 实施计划 T021）：
 * - 只渲染 props + 本地导入文本框，不调用 encode/decode，不改写
 *   T019/T020 的字段与导入规则；真正的导出/导入计算由调用方
 *   （exportExperiment / importExperiment）完成，本面板只转发文本；
 * - 导出隐私提示常驻：文件含原文与恢复载荷 base64、分片快照与哈希，
 *   仅在本地生成、不会自动外发，分享前请确认接收方可信；
 * - 导出摘要显示文件名、字节大小与字节证据进度（已生成数 / 原文长度），
 *   绝不截断文件本身；超大文本（>1 MiB）只在界面上折叠为摘要提示，
 *   调用方持有的完整文本不受影响；
 * - 导入失败只展示调用方传回的完整错误文本（含字段路径），面板本身
 *   不清除、不改写已有的导出摘要——失败导入保持旧状态；
 * - 失败案例保存为调用方回调（onSaveFailureCase），面板不擅自落盘。
 */

import { useState } from 'react'

/** 调用方已导出的文件摘要（由 exportExperiment + serialize 得到）。 */
export interface ExportSummary {
  /** 严格以 .shardlens.json 结尾的文件名。 */
  fileName: string
  /** 完整序列化文本（调用方持有，面板不截断、不改写）。 */
  text: string
  /** 序列化文本的 UTF-8 字节数。 */
  byteSize: number
  /** 已生成字节证据条数（成功时应等于 originalLen）。 */
  provenanceCount: number
  /** 原文长度（字节）。 */
  originalLen: number
}

/** 调用方导入成功后的摘要（由 importExperiment 返回结果提炼）。 */
export interface ImportSuccessSummary {
  experimentId: string
  byteEqual: boolean
  recoverable: boolean
  failureReason: string | null
}

export interface ExperimentIOPanelProps {
  /** 当前导出文件摘要；null 表示尚未导出。 */
  exportFile: ExportSummary | null
  exportBusy: boolean
  onRequestExport: () => void
  importBusy: boolean
  /** 调用方传回的完整导入错误文本（含字段路径），null 表示无错误。 */
  importError: string | null
  importSuccess: ImportSuccessSummary | null
  /** 调用方执行导入（importExperiment）；面板只转发文本框内容。 */
  onImportText: (text: string) => void
  /** 失败案例保存回调；仅在有导入错误时渲染对应按钮。 */
  onSaveFailureCase?: () => void
}

/** 界面上折叠显示导出文本的上限；仅影响渲染，不截断文件本身。 */
const EXPORT_TEXT_RENDER_LIMIT = 1024 * 1024

const PRIVACY_NOTE =
  '隐私提示：导出的 .shardlens.json 包含原文与恢复载荷（base64）、全部 D/P 分片快照、矩阵与哈希；文件只在本地生成，不会自动发送给任何人，分享前请确认接收方 可信。'

export default function ExperimentIOPanel(props: ExperimentIOPanelProps) {
  const {
    exportFile,
    exportBusy,
    onRequestExport,
    importBusy,
    importError,
    importSuccess,
    onImportText,
    onSaveFailureCase,
  } = props
  const [importText, setImportText] = useState('')

  const showExportText =
    exportFile !== null && exportFile.text.length <= EXPORT_TEXT_RENDER_LIMIT

  return (
    <section data-testid="io-panel">
      <h2>实验导入导出</h2>

      <p data-testid="io-privacy-note">{PRIVACY_NOTE}</p>

      <div>
        <h3>导出</h3>
        <button
          type="button"
          data-testid="io-export-button"
          disabled={exportBusy}
          onClick={onRequestExport}
        >
          {exportBusy ? '导出中…' : '导出 .shardlens.json'}
        </button>
        {exportFile === null ? (
          <p data-testid="io-export-empty">尚未导出</p>
        ) : (
          <div>
            <p data-testid="io-export-filename">{exportFile.fileName}</p>
            <p data-testid="io-export-size">{exportFile.byteSize} 字节</p>
            <p data-testid="io-export-progress">
              字节证据 {exportFile.provenanceCount} / {exportFile.originalLen}
            </p>
            {showExportText ? (
              <textarea
                data-testid="io-export-text"
                readOnly
                value={exportFile.text}
              />
            ) : (
              <p data-testid="io-export-large-note">
                文件过大，仅显示摘要（完整文件由调用方持有，未截断）
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <h3>导入</h3>
        <textarea
          data-testid="io-import-textarea"
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
        />
        <button
          type="button"
          data-testid="io-import-button"
          disabled={importBusy}
          onClick={() => onImportText(importText)}
        >
          {importBusy ? '导入中…' : '导入 .shardlens.json'}
        </button>
        {importError !== null && (
          <div>
            <p data-testid="io-import-error">{importError}</p>
            {onSaveFailureCase !== undefined && (
              <button
                type="button"
                data-testid="io-save-failure-case"
                onClick={onSaveFailureCase}
              >
                保存失败案例
              </button>
            )}
          </div>
        )}
        {importSuccess !== null && (
          <p data-testid="io-import-success">
            导入成功：{importSuccess.experimentId}，byte_equal=
            {importSuccess.byteEqual ? 'true' : 'false'}，recoverable=
            {importSuccess.recoverable ? 'true' : 'false'}，failure_reason=
            {importSuccess.failureReason ?? 'null'}
          </p>
        )}
      </div>
    </section>
  )
}
