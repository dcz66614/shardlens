import type { EncodeResult } from '../core/types'
import { encode } from '../core/encode'
import { textToBytes } from '../features/input/generators'

/** P0002 ShardLens — 演示夹具（PROJECT_BOOK T006）。分片由 encode 实时算出，不硬编码。 */

export const ABC_TEXT = 'ABC'
export const ABC_K = 4
export const ABC_M = 2
export const ABC_N = ABC_K + ABC_M

/** 5 字节演示输入，用于 padding 验收（k=4 时 shardLen=2、paddingLen=3）。 */
export const PADDING_TEST_INPUT: Uint8Array = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05])

export async function makeABCEncodeResult(): Promise<EncodeResult> {
  return encode(textToBytes(ABC_TEXT), ABC_K, ABC_M)
}

export async function makePaddingTestResult(): Promise<EncodeResult> {
  return encode(PADDING_TEST_INPUT, ABC_K, ABC_M)
}

export async function makeEncodeResult(
  text: string,
  k: number,
  m: number,
): Promise<EncodeResult> {
  return encode(textToBytes(text), k, m)
}
