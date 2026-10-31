function toUint32(value: number): number {
  return value >>> 0
}

export const DEFAULT_SEED = 0xc0ffee11

export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export class LCG {
  state: number

  constructor(seed: number = DEFAULT_SEED) {
    this.state = toUint32(seed)
  }

  nextByte(): number {
    this.state = toUint32(Math.imul(1664525, this.state) + 1013904223)
    return (this.state >>> 24) & 255
  }

  nextBytes(length: number): Uint8Array {
    const out = new Uint8Array(length)
    for (let i = 0; i < length; i++) {
      out[i] = this.nextByte()
    }
    return out
  }
}

export function generateRandomBytes(length: number, seed?: number): Uint8Array {
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
    throw new RangeError(`length must be a non-negative integer, got ${length}`)
  }
  const lcg = new LCG(seed === undefined ? DEFAULT_SEED : seed)
  return lcg.nextBytes(length)
}
