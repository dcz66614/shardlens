import { add, mul } from './gf256'
import { buildSystematicMatrix } from './rs_matrix'
import type { EncodeResult, Shard } from './types'

const MAX_INPUT_LEN = 16384

function assertInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer, got ${String(value)}`)
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes as unknown as BufferSource,
  )
  const view = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, '0')
  }
  return hex
}

export async function encode(
  input: Uint8Array,
  k: number,
  m: number,
): Promise<EncodeResult> {
  assertInteger(k, 'k')
  assertInteger(m, 'm')
  if (k < 1 || k > 15) {
    throw new RangeError(`k must be in 1..15, got ${k}`)
  }
  if (m < 1 || m > 15) {
    throw new RangeError(`m must be in 1..15, got ${m}`)
  }
  if (k + m > 16) {
    throw new RangeError(`k + m must be <= 16, got ${k} + ${m} = ${k + m}`)
  }

  const originalLen = input.length
  if (originalLen > MAX_INPUT_LEN) {
    throw new RangeError(
      `input length ${originalLen} exceeds 16KiB (max ${MAX_INPUT_LEN})`,
    )
  }

  const n = k + m
  const shardLen = originalLen === 0 ? 0 : Math.ceil(originalLen / k)
  const paddingLen = k * shardLen - originalLen

  const padded = new Uint8Array(k * shardLen)
  padded.set(input, 0)

  const dataShards: Uint8Array[] = []
  for (let i = 0; i < k; i++) {
    dataShards.push(padded.subarray(i * shardLen, (i + 1) * shardLen))
  }

  const G = buildSystematicMatrix(k, m)

  const shardBytes: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    if (i < k) {
      shardBytes.push(dataShards[i]!)
      continue
    }
    const row = G[i]!
    const shard = new Uint8Array(shardLen)
    for (let t = 0; t < shardLen; t++) {
      let acc = 0
      for (let j = 0; j < k; j++) {
        acc = add(acc, mul(row[j]!, dataShards[j]![t]!))
      }
      shard[t] = acc
    }
    shardBytes.push(shard)
  }

  const shards: Shard[] = []
  for (let i = 0; i < n; i++) {
    const isData = i < k
    const bytes = shardBytes[i]!
    shards.push({
      index: i,
      label: isData ? `D${i}` : `P${i - k}`,
      kind: isData ? 'data' : 'parity',
      bytes,
      sha256: await sha256Hex(bytes),
    })
  }

  return {
    k,
    m,
    n,
    original: input,
    shardLen,
    paddingLen,
    G,
    shards,
  }
}