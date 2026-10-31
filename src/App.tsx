/**
 * P0002-T023 — 全链路主界面接线。
 *
 * 在 T009 真实会话接线（输入 → 编码 → 擦除 → 恢复）之上，把此前各任务产出的
 * 展示组件接进同一页面，全部由 session 单例的真实状态驱动，不渲染任何静态
 * “成功”数据：
 * - ShardWall（T010）：真实分片墙与擦除开关；
 * - StatusBar（T016）：失败门禁（失败时强制 recovered=null、R=null、证据=[]）；
 * - MatrixWorkbench（T012）：G 实时计算与消元回放；
 * - ByteInspector（T014）：逐字节证据，默认偏移 1；
 * - ComparisonPanel（T017）：冻结 A / 当前 B 反事实对比；
 * - ExperimentIOPanel（T021）：导出/导入调用方（exportExperiment / importExperiment）。
 *
 * FIX-R1（终审第 1 轮 B1/B2 修复）：ExperimentControls（T011，含 seeded
 * 随机模式）已接入主界面——session 现有 seeded 会话级编码入口（LCG 真实
 * 生成字节），utf8 与 seeded 均可走完整实验闭环；导出/导入亦按真实输入
 * 模式走对应路径，不再固定为 utf8。矩阵工作台跟随当前实验存活集
 * （见 MatrixWorkbench 的 followSurvivors 属性）。
 */
import { useState, useSyncExternalStore } from 'react'
import { session, type RecoveryOutcome } from './state/session'
import type { EncodeResult, FailureReason } from './core/types'
import { DEFAULT_SEED } from './features/input/generators'
import ExperimentControls, { type InputMode } from './components/ExperimentControls'
import ShardWall from './components/ShardWall'
import StatusBar from './components/StatusBar'
import MatrixWorkbench from './components/MatrixWorkbench'
import ByteInspector from './components/ByteInspector'
import ComparisonPanel, { type ComparisonCase } from './components/ComparisonPanel'
import ExperimentIOPanel, {
  type ExportSummary,
  type ImportSuccessSummary,
} from './components/ExperimentIOPanel'
import {
  buildExperimentFileName,
  exportExperiment,
  importExperiment,
  serializeExperimentFile,
} from './io/experiment_io'

const PHASE_LABEL: Record<string, string> = {
  CLEAN: 'CLEAN（无输入/未算）',
  ENCODED: 'ENCODED（已编码）',
  ERASED: 'ERASED（已标记擦除）',
  RECOVERING: 'RECOVERING（求逆重建中）',
  VERIFIED: 'VERIFIED（字节+SHA 校验通过）',
  FAILED: 'FAILED（恢复/校验失败）',
}

/** 由真实解码结果构造反事实对比的一方；未解码时全部关键字段为 null，绝不虚构。 */
function buildCase(
  label: string,
  encoded: EncodeResult | null,
  erased: number[],
  recovery: RecoveryOutcome | null,
  failureReason: FailureReason | null,
): ComparisonCase {
  const erasedSet = new Set(erased)
  const alive = encoded
    ? encoded.shards.map((s) => s.index).filter((i) => !erasedSet.has(i))
    : []
  const decode = recovery?.decode ?? null
  if (!recovery || !decode || !decode.recoverable) {
    return {
      label,
      erased: [...erased],
      alive,
      selectedIndices: null,
      selectedMatrix: null,
      inverse: null,
      recoverable: false,
      failureReason: failureReason ?? decode?.failureReason ?? null,
      verified: false,
      recoveredSha256: null,
    }
  }
  return {
    label,
    erased: [...erased],
    alive,
    selectedIndices: decode.selectedIndices,
    selectedMatrix: decode.Gs,
    inverse: decode.inverse,
    recoverable: true,
    failureReason: null,
    verified: recovery.verified,
    recoveredSha256: recovery.recoveredSha256,
  }
}

/** 比较快照键：参数 + 擦除集 + 各片 SHA；任一变化即视为比较过期。 */
function snapshotKey(
  encoded: EncodeResult | null,
  erased: number[],
  k: number,
  m: number,
): string {
  const shardsKey = encoded ? encoded.shards.map((s) => s.sha256).join(',') : ''
  return `${k}/${m}|${erased.join(',')}|${shardsKey}`
}

export default function App() {
  const state = useSyncExternalStore(session.subscribe, session.getState)
  const { phase, encoded, erased, recovery } = state

  const canEncode = !state.busy && state.encoded === null
  const canRecover = !!encoded && !state.busy

  // FIX-R1：受控输入的本地字符串镜像（会话层持有解析后的数值）。
  // seed 为空串表示使用默认种子；长度非法时不写入会话，控件层禁编码。
  const [seedText, setSeedText] = useState('')
  const [lengthText, setLengthText] = useState('16')

  const [locateNote, setLocateNote] = useState('（尚未点击定位）')
  const [frozenA, setFrozenA] = useState<ComparisonCase | null>(null)
  const [frozenKey, setFrozenKey] = useState<string | null>(null)
  const [exportFile, setExportFile] = useState<ExportSummary | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState<ImportSuccessSummary | null>(null)
  const [savedFailureCase, setSavedFailureCase] = useState<string | null>(null)

  const currentKey = snapshotKey(encoded, erased, state.k, state.m)
  const stale = frozenA !== null && frozenKey !== null && frozenKey !== currentKey

  // FIX-R1（B2）：工作台跟随当前实验的存活集。已恢复时用解码的选中行；
  // 未恢复时用升序存活片的前 k 个（与 decodeSurvivors 的选行规则一致）；
  // 未编码时不传，工作台保持默认行为。
  const aliveIndices = encoded
    ? encoded.shards.map((s) => s.index).filter((i) => !erased.includes(i))
    : []
  const followSurvivors =
    encoded === null
      ? undefined
      : recovery && recovery.decode.recoverable
        ? recovery.decode.selectedIndices
        : aliveIndices.slice(0, state.k)

  function freezeCurrent(): void {
    if (!recovery) return
    setFrozenA(buildCase('冻结 A', encoded, erased, recovery, state.failureReason))
    setFrozenKey(currentKey)
  }

  const currentB: ComparisonCase = recovery
    ? buildCase('当前 B', encoded, erased, recovery, state.failureReason)
    : buildCase('当前 B', encoded, erased, null, null)

  async function handleExport(): Promise<void> {
    if (!encoded || !recovery) {
      setExportError('尚未完成一次恢复，无法导出（请先编码、擦除并恢复）')
      return
    }
    setExportBusy(true)
    setExportError(null)
    try {
      // FIX-R1：按会话真实输入模式导出；seeded 模式下 input_text 为 null、
      // random_seed 为会话种子，绝不固定为 utf8。
      const seeded = state.inputMode === 'seeded'
      const file = await exportExperiment({
        encoded,
        decoded: recovery.decode,
        erasedIndices: erased,
        input_mode: seeded ? 'seeded_random' : 'utf8',
        input_text: seeded ? null : state.inputText,
        random_seed: seeded ? state.seed : null,
        comparison_id: null,
      })
      const text = serializeExperimentFile(file)
      setExportFile({
        fileName: buildExperimentFileName(file.experiment_id),
        text,
        byteSize: new TextEncoder().encode(text).length,
        provenanceCount: file.byte_provenance.length,
        originalLen: file.original_len,
      })
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExportBusy(false)
    }
  }

  async function handleImport(text: string): Promise<void> {
    setImportBusy(true)
    setImportError(null)
    setImportSuccess(null)
    try {
      const result = await importExperiment(text)
      setImportSuccess({
        experimentId: result.file.experiment_id,
        byteEqual: result.file.byte_equal,
        recoverable: result.file.recoverable,
        failureReason: result.file.failure_reason,
      })
      // FIX-R1：两种模式均经由会话公开 API 完整复现（参数 → 输入 → 编码 →
      // 擦除 → 恢复）。seeded 模式用文件种子与原文长度经同一 LCG 重新生成
      // 字节（导入已校验文件合法性；此处再核对复现字节长度，绝不假装）。
      session.setParams(result.file.k, result.file.m)
      if (result.file.input_mode === 'utf8' && result.file.input_text !== null) {
        session.setInputMode('utf8')
        session.setInputText(result.file.input_text)
      } else if (result.file.input_mode === 'seeded_random') {
        const seed = result.file.random_seed ?? DEFAULT_SEED
        session.setInputMode('seeded')
        session.setSeed(seed)
        session.setSeededLength(result.file.original_len)
        setSeedText(String(seed))
        setLengthText(String(result.file.original_len))
      } else {
        throw new Error(`不支持的导入输入模式：${String(result.file.input_mode)}`)
      }
      await session.encode()
      const replayed = session.getState().encoded
      if (!replayed || replayed.original.length !== result.file.original_len) {
        throw new Error('导入复现字节长度与文件 original_len 不一致')
      }
      for (const idx of result.erasedIndices) session.toggleErase(idx)
      await session.recover()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImportBusy(false)
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="logo-mark" aria-hidden="true">
          ▚▞
        </span>
        <h1 className="logo">碎码镜 / ShardLens</h1>
        <span className="version-badge">v1.0.0</span>
      </header>

      <main>
        <section aria-label="状态">
          <p>
            状态：<strong aria-live="polite">{PHASE_LABEL[phase] ?? phase}</strong>
          </p>
          {!state.hashAvailable && (
            <p className="note" role="alert">
              crypto.subtle 不可用：请使用 localhost/HTTPS 运行。未校验的恢复不会被标记为 VERIFIED。
            </p>
          )}
          {state.detail && (
            <p className="note" role="alert">
              {state.failureReason ? `失败码 ${state.failureReason}：` : ''}
              {state.detail}
            </p>
          )}
        </section>

        {/* FIX-R1：双输入控件真正接入主界面（utf8 文本 / seeded 随机）。 */}
        <ExperimentControls
          mode={state.inputMode as InputMode}
          text={state.inputText}
          seed={seedText}
          length={lengthText}
          k={String(state.k)}
          m={String(state.m)}
          canRecover={canRecover}
          canEncode={canEncode}
          busy={state.busy}
          onModeChange={(mode) => session.setInputMode(mode)}
          onTextChange={(text) => session.setInputText(text)}
          onSeedChange={(value) => {
            setSeedText(value)
            const trimmed = value.trim()
            if (trimmed === '') {
              session.setSeed(DEFAULT_SEED)
            } else if (/^\d+$/.test(trimmed)) {
              session.setSeed(Number(trimmed))
            }
            // 非法 seed 字符串不写入会话；控件层已禁编码。
          }}
          onLengthChange={(value) => {
            setLengthText(value)
            const n = Number(value)
            if (Number.isInteger(n)) session.setSeededLength(n)
          }}
          onKChange={(value) => {
            const k = Number(value)
            if (Number.isInteger(k)) session.setParams(k, state.m)
          }}
          onMChange={(value) => {
            const m = Number(value)
            if (Number.isInteger(m)) session.setParams(state.k, m)
          }}
          onEncode={() => void session.encode()}
          onRecover={() => void session.recover()}
          onClear={() => session.reset()}
        />
        <section aria-label="擦除操作">
          <button
            type="button"
            data-testid="btn-clear-erase"
            onClick={() => session.clearErase()}
            disabled={erased.length === 0}
          >
            清空擦除
          </button>
        </section>

        {encoded && (
          <ShardWall
            shards={encoded.shards}
            erased={erased}
            onToggleErase={(index) => session.toggleErase(index)}
            disabled={state.busy}
          />
        )}

        <StatusBar
          phase={phase}
          k={state.k}
          m={state.m}
          n={encoded ? encoded.n : state.k + state.m}
          aliveCount={encoded ? encoded.n - erased.length : 0}
          erasedCount={erased.length}
          failureReason={state.failureReason}
          decode={recovery ? recovery.decode : null}
          verified={recovery ? recovery.verified : false}
          byteEqual={recovery ? recovery.byteEqual : false}
          shaEqual={recovery ? recovery.shaEqual : false}
          detail={state.detail}
        />

        <MatrixWorkbench k={state.k} m={state.m} followSurvivors={followSurvivors} />

        {encoded && (
          <>
            <ByteInspector
              encoded={encoded}
              decoded={recovery ? recovery.decode : null}
              initialOffset={1}
              onLocateShard={(shardIndex, shardOffset) =>
                setLocateNote(`定位到碎片墙：第 ${shardIndex} 片，片内偏移 ${shardOffset}`)
              }
              onLocateMatrix={(row, col) =>
                setLocateNote(`定位到矩阵：第 ${row} 行，第 ${col} 列`)
              }
            />
            <p data-testid="locate-note" aria-live="polite">
              定位：{locateNote}
            </p>
          </>
        )}

        {encoded && (recovery || frozenA) && (
          <section aria-label="反事实对比">
            <button
              type="button"
              data-testid="freeze-a-button"
              onClick={freezeCurrent}
              disabled={!recovery}
            >
              冻结当前为 A
            </button>
            <ComparisonPanel
              frozenA={frozenA}
              currentB={currentB}
              stale={stale}
              onRefreeze={freezeCurrent}
            />
          </section>
        )}

        {recovery && (
          <section aria-label="恢复结果">
            <h2>恢复结果</h2>
            <p>失败码：{recovery.decode.failureReason ?? 'null'}</p>
            <p>recoverable: {String(recovery.decode.recoverable)}</p>
            <p>选中存活片：[{recovery.decode.selectedIndices.join(', ')}]</p>
            <p>忽略存活片：[{recovery.decode.ignoredIndices.join(', ')}]</p>
            <p>
              恢复字节：
              {recovery.decode.recovered === null
                ? 'null'
                : `${recovery.decode.recovered.length} 字节 → "${new TextDecoder().decode(recovery.decode.recovered)}"`}
            </p>
            <p>byte_equal: {String(recovery.byteEqual)}</p>
            <p>recovered sha256: {recovery.recoveredSha256 ?? 'null'}</p>
            <p>expected sha256: {recovery.expectedSha256 ?? 'null'}</p>
            <p>sha_equal: {String(recovery.shaEqual)}</p>
            <p>
              最终判定：
              <strong aria-live="polite">{recovery.verified ? 'VERIFIED' : '未通过（不显示 VERIFIED）'}</strong>
            </p>
          </section>
        )}

        <ExperimentIOPanel
          exportFile={exportFile}
          exportBusy={exportBusy}
          onRequestExport={() => void handleExport()}
          importBusy={importBusy}
          importError={importError}
          importSuccess={importSuccess}
          onImportText={(text) => void handleImport(text)}
          onSaveFailureCase={
            importError !== null
              ? () => setSavedFailureCase(importError)
              : undefined
          }
        />
        {exportError !== null && (
          <p data-testid="io-note" role="alert">
            导出提示：{exportError}
          </p>
        )}
        {savedFailureCase !== null && (
          <section aria-label="已保存失败案例">
            <h2>已保存失败案例（本页展示）</h2>
            <p data-testid="saved-failure-case">{savedFailureCase}</p>
          </section>
        )}
      </main>
    </div>
  )
}
