/**
 * P0002-T023 — 真实性能基准（PROJECT_BOOK §13）。
 *
 * 测量（全部为真实计算，非模拟数字）：
 * - encode：k=4、m=2，seeded_random 固定种子输入；
 * - decode：擦除 [1,4] 后仅存活片求逆重建；
 * - provenance：全部恢复字节来源生成（generateAllByteProvenance）；
 * - export：完整 .shardlens.json 生成（含全量 byte_provenance 与序列化）。
 *
 * §13 软目标：4KiB 编解码及全证据生成 2 秒以内；16KiB 完整 JSON 生成
 * 15 秒以内。P0 正确性高于软目标：未达标只如实记录，不伪造数字。
 *
 * 输出：<项目根>/05_tests/benchmark/bench-<commit短哈希>.json，
 * 并在 stdout 打印各尺寸 median/max。commit 哈希取 git rev-parse，失败为 unknown。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encode } from '../src/core/encode'
import { decodeSurvivors } from '../src/core/decode'
import { generateAllByteProvenance } from '../src/core/evidence'
import { exportExperiment, serializeExperimentFile } from '../src/io/experiment_io'
import { DEFAULT_SEED, generateRandomBytes } from '../src/features/input/generators'
import type { DecodeInput, DecodeResult, EncodeResult } from '../src/core/types'

const WARMUP = 1
const RUNS = 5

/** 基准配置：默认 RS(6,4) 两档 + 与 T019 对齐的满配 RS(16,12) 一档。 */
const CONFIGS = [
  { size: 4096, k: 4, m: 2, erased: [1, 4] },
  { size: 16384, k: 4, m: 2, erased: [1, 4] },
  { size: 16384, k: 12, m: 4, erased: [1, 4, 5] },
]

interface Stats {
  min_ms: number
  median_ms: number
  p95_ms: number
  max_ms: number
  runs: number[]
}

function summarize(runs: number[]): Stats {
  const sorted = [...runs].sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
  return {
    min_ms: sorted[0]!,
    median_ms: sorted[Math.floor(sorted.length / 2)]!,
    p95_ms: p95,
    max_ms: sorted[sorted.length - 1]!,
    runs,
  }
}

function statsOf(fn: () => number, times: number): Stats {
  const runs: number[] = []
  for (let i = 0; i < times; i++) runs.push(fn())
  return summarize(runs)
}

async function statsOfAsync(fn: () => Promise<number>, times: number): Promise<Stats> {
  const runs: number[] = []
  for (let i = 0; i < times; i++) runs.push(await fn())
  return summarize(runs)
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6
}

function buildDecodeInput(encoded: EncodeResult, erased: number[]): DecodeInput {
  const erasedSet = new Set(erased)
  return {
    k: encoded.k,
    m: encoded.m,
    n: encoded.n,
    originalLen: encoded.original.length,
    paddingLen: encoded.paddingLen,
    shardLen: encoded.shardLen,
    encodingMatrix: encoded.G,
    available: encoded.shards
      .filter((s) => !erasedSet.has(s.index))
      .map((s) => ({ index: s.index, bytes: s.bytes })),
  }
}

function gitShortHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

async function benchSize(cfg: {
  size: number
  k: number
  m: number
  erased: number[]
}): Promise<Record<string, unknown>> {
  const { size, k, m, erased } = cfg
  const input = generateRandomBytes(size, DEFAULT_SEED)
  // warmup（不计入统计）
  for (let i = 0; i < WARMUP; i++) {
    const enc = await encode(input, k, m)
    const dec = decodeSurvivors(buildDecodeInput(enc, erased))
    await generateAllByteProvenance(enc, dec)
  }

  const encodeStats = await statsOfAsync(async () => {
    const t0 = nowMs()
    await encode(input, k, m)
    return nowMs() - t0
  }, RUNS)

  // 固定一次编码结果用于 decode/provenance/export 的计时（输入确定，编码确定）。
  const encoded = await encode(input, k, m)
  const decodeInput = buildDecodeInput(encoded, erased)

  const decodeStats = statsOf(() => {
    const t0 = nowMs()
    const dec: DecodeResult = decodeSurvivors(decodeInput)
    if (!dec.recoverable || dec.recovered === null) {
      throw new Error(`benchmark decode unexpectedly failed for size ${size}`)
    }
    return nowMs() - t0
  }, RUNS)

  const decoded = decodeSurvivors(decodeInput)
  const provenanceStats = await statsOfAsync(async () => {
    const t0 = nowMs()
    const all = await generateAllByteProvenance(encoded, decoded)
    if (all.items.length !== size) {
      throw new Error(`provenance length ${all.items.length} != ${size}`)
    }
    return nowMs() - t0
  }, RUNS)

  const exportStats = await statsOfAsync(async () => {
    const t0 = nowMs()
    const file = await exportExperiment({
      encoded,
      decoded,
      erasedIndices: erased,
      input_mode: 'seeded_random',
      input_text: null,
      random_seed: DEFAULT_SEED,
      comparison_id: null,
    })
    const text = serializeExperimentFile(file)
    if (file.byte_provenance.length !== size) {
      throw new Error(`export provenance length ${file.byte_provenance.length} != ${size}`)
    }
    return nowMs() - t0
  }, RUNS)

  const finalFile = await exportExperiment({
    encoded,
    decoded,
    erasedIndices: erased,
    input_mode: 'seeded_random',
    input_text: null,
    random_seed: DEFAULT_SEED,
    comparison_id: null,
  })
  const finalText = serializeExperimentFile(finalFile)

  return {
    input_bytes: size,
    k,
    m,
    n: k + m,
    erased,
    shard_len: encoded.shardLen,
    encode_ms: encodeStats,
    decode_ms: decodeStats,
    provenance_ms: provenanceStats,
    export_ms: exportStats,
    export_json_bytes: new TextEncoder().encode(finalText).length,
    byte_provenance_length: finalFile.byte_provenance.length,
  }
}

async function main(): Promise<void> {
  const commit = gitShortHash()
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(scriptDir, '..')
  const outDir = join(repoRoot, '..', '..', '05_tests', 'benchmark')
  mkdirSync(outDir, { recursive: true })

  const results: Record<string, unknown>[] = []
  for (const cfg of CONFIGS) {
    const r = await benchSize(cfg)
    results.push(r)
    const e = r.encode_ms as Stats
    const d = r.decode_ms as Stats
    const p = r.provenance_ms as Stats
    const x = r.export_ms as Stats
    console.log(
      `${cfg.size}B k=${cfg.k} m=${cfg.m}: encode median ${e.median_ms.toFixed(1)}ms max ${e.max_ms.toFixed(1)}ms | ` +
        `decode median ${d.median_ms.toFixed(1)}ms max ${d.max_ms.toFixed(1)}ms | ` +
        `provenance median ${p.median_ms.toFixed(1)}ms max ${p.max_ms.toFixed(1)}ms | ` +
        `export median ${x.median_ms.toFixed(1)}ms max ${x.max_ms.toFixed(1)}ms | ` +
        `json ${r.export_json_bytes} bytes`,
    )
  }

  const payload = {
    commit,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    seed: DEFAULT_SEED,
    warmup: WARMUP,
    runs: RUNS,
    results,
  }
  const outPath = join(outDir, `bench-${commit}.json`)
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n')
  console.log(`BENCH_WROTE ${outPath}`)
}

main().catch((err) => {
  console.error('BENCH FAILED', err)
  process.exit(1)
})
