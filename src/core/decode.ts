import { add, mul } from './gf256'
import { invertWithTrace } from './rs_matrix'
import type { DecodeInput, DecodeResult, FailureReason, GFStep, Matrix } from './types'

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

function isByteValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
}

function invalidResult(available: unknown): DecodeResult {
  const list = Array.isArray(available) ? available : []
  const ignored = list
    .map((a) => (typeof a === 'object' && a !== null ? (a as { index: unknown }).index : undefined))
    .filter((i): i is number => typeof i === 'number' && Number.isInteger(i))
    .sort((a, b) => a - b)
  return {
    recoverable: false,
    failureReason: 'INVALID_EXPERIMENT',
    selectedIndices: [],
    ignoredIndices: ignored,
    Gs: null,
    inverse: null,
    steps: [],
    recovered: null,
    byteEqual: false,
    recoveredSha256: null,
  }
}

function failResult(
  reason: FailureReason,
  selected: number[],
  ignored: number[],
  Gs: Matrix | null,
  inverse: Matrix | null,
  steps: GFStep[],
  recovered: Uint8Array | null,
): DecodeResult {
  return {
    recoverable: false,
    failureReason: reason,
    selectedIndices: selected,
    ignoredIndices: ignored,
    Gs,
    inverse,
    steps,
    recovered,
    byteEqual: false,
    recoveredSha256: null,
  }
}

export function decodeSurvivors(input: DecodeInput): DecodeResult {
  const { k, m, n, originalLen, paddingLen, shardLen, encodingMatrix, available } = input

  // validate
  let valid = true
  if (!isInteger(k) || !isInteger(m) || !isInteger(n)) valid = false
  if (valid && (k < 1 || m < 1 || k + m > 16)) valid = false
  if (valid && n !== k + m) valid = false
  if (valid && (!isInteger(originalLen) || originalLen < 0)) valid = false
  if (valid && (!isInteger(shardLen) || shardLen < 0)) valid = false
  // length equation (PROJECT_BOOK §6.1/§7.3/§9.1): recovered length must equal
  // originalLen, i.e. originalLen <= k*shardLen and paddingLen fills the gap.
  // Empty input (0, 0, 0) satisfies the equation and keeps the existing convention.
  if (valid && (!isInteger(paddingLen) || paddingLen < 0)) valid = false
  if (valid && originalLen > k * shardLen) valid = false
  if (valid && paddingLen !== k * shardLen - originalLen) valid = false
  if (valid) {
    if (!Array.isArray(encodingMatrix) || encodingMatrix.length !== n) valid = false
    else {
      for (let i = 0; i < n; i++) {
        const row = encodingMatrix[i]
        if (!Array.isArray(row) || row.length !== k) { valid = false; break }
        for (let j = 0; j < k; j++) {
          if (!isByteValue(row[j])) { valid = false; break }
        }
        if (!valid) break
      }
    }
  }
  // available validation
  if (valid) {
    if (!Array.isArray(available)) valid = false
    else {
      const seen = new Set<number>()
      for (const a of available) {
        if (typeof a !== 'object' || a === null) { valid = false; break }
        if (!isInteger(a.index) || a.index < 0 || a.index > n - 1) { valid = false; break }
        if (seen.has(a.index)) { valid = false; break }
        seen.add(a.index)
        if (!(a.bytes instanceof Uint8Array) || a.bytes.length !== shardLen) { valid = false; break }
      }
    }
  }

  if (!valid) {
    return invalidResult(available)
  }

  const sorted = available.map((a) => a.index).slice().sort((a, b) => a - b)
  // need map index->bytes
  const byIndex = new Map<number, Uint8Array>()
  for (const a of available) byIndex.set(a.index, a.bytes)

  if (available.length < k) {
    const ignored = sorted.slice()
    return failResult('INSUFFICIENT_SHARDS', [], ignored, null, null, [], null)
  }

  const selectedIndices = sorted.slice(0, k)
  const ignoredIndices = sorted.slice(k)

  const Gs: Matrix = selectedIndices.map((idx) => encodingMatrix[idx]!.map((v) => v))
  // deep copy already

  let inverse: Matrix
  let steps: GFStep[]
  try {
    const res = invertWithTrace(Gs)
    inverse = res.inverse
    steps = res.steps
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'SINGULAR_MATRIX') {
      return failResult('SINGULAR_MATRIX', selectedIndices, ignoredIndices, Gs, null, [], null)
    }
    throw e
  }

  // rebuild
  const padded = new Uint8Array(k * shardLen)
  for (let i = 0; i < k; i++) {
    for (let t = 0; t < shardLen; t++) {
      let acc = 0
      for (let j = 0; j < k; j++) {
        const selIdx = selectedIndices[j]!
        const byteVal = byIndex.get(selIdx)![t]!
        acc = add(acc, mul(inverse[i]![j]!, byteVal))
      }
      padded[i * shardLen + t] = acc
    }
  }

  const recovered = new Uint8Array(padded.subarray(0, originalLen))

  return {
    recoverable: true,
    failureReason: null,
    selectedIndices,
    ignoredIndices,
    Gs,
    inverse,
    steps,
    recovered,
    byteEqual: false,
    recoveredSha256: null,
  }
}