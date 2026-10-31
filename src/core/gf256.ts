// GF(2^8) arithmetic, primitive polynomial 0x11D, generator 2.
// Log/exp tables built at module load.

const PRIMITIVE_POLY = 0x11d; // x^8 + x^4 + x^3 + x^2 + 1

function isByte(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function checkByte(v: unknown, name: string): void {
  if (!isByte(v)) {
    throw new RangeError(`${name} out of range: ${String(v)}`);
  }
}

function checkExp(v: unknown): void {
  if (!isNonNegativeInt(v)) {
    throw new RangeError(`e out of range: ${String(v)}`);
  }
}

// Build EXP_TABLE (length 510) and LOG_TABLE (length 256).
const EXP_TABLE: number[] = new Array<number>(510);
const LOG_TABLE: number[] = new Array<number>(256);

let x = 1;
for (let i = 0; i <= 254; i++) {
  EXP_TABLE[i] = x;
  LOG_TABLE[x] = i;
  x = x << 1;
  if (x & 0x100) {
    x = x ^ PRIMITIVE_POLY;
  }
}
for (let i = 0; i < 255; i++) {
  EXP_TABLE[i + 255] = EXP_TABLE[i]!;
}
LOG_TABLE[0] = -1;

Object.freeze(EXP_TABLE);
Object.freeze(LOG_TABLE);

export { EXP_TABLE, LOG_TABLE };

export function add(a: number, b: number): number {
  checkByte(a, 'a');
  checkByte(b, 'b');
  return a ^ b;
}

export function mul(a: number, b: number): number {
  checkByte(a, 'a');
  checkByte(b, 'b');
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a]! + LOG_TABLE[b]!]!;
}

export function div(a: number, b: number): number {
  checkByte(a, 'a');
  checkByte(b, 'b');
  if (b === 0) throw new Error('GF_DIV_ZERO');
  if (a === 0) return 0;
  return EXP_TABLE[(LOG_TABLE[a]! - LOG_TABLE[b]! + 255) % 255]!;
}

export function inv(a: number): number {
  checkByte(a, 'a');
  if (a === 0) throw new Error('GF_INV_ZERO');
  return EXP_TABLE[255 - LOG_TABLE[a]!]!;
}

export function pow(a: number, e: number): number {
  checkByte(a, 'a');
  checkExp(e);
  if (e === 0) return 1;
  if (a === 0) return 0;
  return EXP_TABLE[(LOG_TABLE[a]! * e) % 255]!;
}
