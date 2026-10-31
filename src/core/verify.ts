import type { DecodeResult } from './types'

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

export async function verifyRecovered(
  recovered: Uint8Array,
  expected: Uint8Array,
): Promise<{
  byteEqual: boolean
  recoveredSha256: string
  expectedSha256: string
  shaEqual: boolean
}> {
  const byteEqual =
    recovered.length === expected.length &&
    (() => {
      for (let i = 0; i < recovered.length; i++) {
        if (recovered[i]! !== expected[i]!) return false
      }
      return true
    })()
  const recoveredSha256 = await sha256Hex(recovered)
  const expectedSha256 = await sha256Hex(expected)
  const shaEqual = recoveredSha256 === expectedSha256
  return { byteEqual, recoveredSha256, expectedSha256, shaEqual }
}

export async function verifyDecoded(
  decoded: DecodeResult,
  expected: Uint8Array,
): Promise<{
  byteEqual: boolean
  recoveredSha256: string | null
  expectedSha256: string
  shaEqual: boolean
}> {
  if (decoded.recovered === null) {
    return {
      byteEqual: false,
      recoveredSha256: null,
      expectedSha256: await sha256Hex(expected),
      shaEqual: false,
    }
  }
  return verifyRecovered(decoded.recovered, expected)
}