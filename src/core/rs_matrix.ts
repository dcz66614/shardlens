import { add, inv, mul, pow } from './gf256'
import type { GFStep, Matrix } from './types'

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

function isByteValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
}

function deepCopyMatrix(m: Matrix): Matrix {
  const rows = m.length
  const result: number[][] = []
  for (let i = 0; i < rows; i++) {
    const row = m[i]
    if (!row) {
      result.push([])
      continue
    }
    const newRow: number[] = []
    const cols = row.length
    for (let j = 0; j < cols; j++) {
      newRow.push(row[j]!)
    }
    result.push(newRow)
  }
  return result
}

function validateMatrixShape(m: Matrix): { rows: number; cols: number } {
  if (!Array.isArray(m)) {
    throw new Error('Matrix must be array')
  }
  const rows = m.length
  if (rows === 0) {
    throw new Error('Matrix must have at least one row')
  }
  const firstRow = m[0]
  if (!Array.isArray(firstRow)) {
    throw new Error('Matrix rows must be arrays')
  }
  const cols = firstRow.length
  if (cols === 0) {
    throw new Error('Matrix must have at least one column')
  }
  for (let i = 0; i < rows; i++) {
    const row = m[i]
    if (!Array.isArray(row)) {
      throw new Error('Matrix rows must be arrays')
    }
    if (row.length !== cols) {
      throw new Error('Matrix must be rectangular')
    }
    for (let j = 0; j < cols; j++) {
      const val = row[j]
      if (!isByteValue(val)) {
        throw new Error('Matrix elements must be integers in 0..255')
      }
    }
  }
  return { rows, cols }
}

export function buildVandermonde(n: number, k: number): Matrix {
  if (!isInteger(n) || !isInteger(k)) {
    throw new RangeError('n and k must be integers')
  }
  if (k < 1 || n < k || n > 16) {
    throw new RangeError('require 1 <= k <= n <= 16')
  }
  const result: number[][] = []
  for (let r = 0; r < n; r++) {
    const row: number[] = []
    for (let c = 0; c < k; c++) {
      const val = pow(2, r * c)
      row.push(val)
    }
    result.push(row)
  }
  return result
}

export function matMul(A: Matrix, B: Matrix): Matrix {
  const shapeA = validateMatrixShape(A)
  const shapeB = validateMatrixShape(B)
  if (shapeA.cols !== shapeB.rows) {
    throw new Error('Matrix dimensions incompatible for multiplication')
  }
  const rowsA = shapeA.rows
  const colsA = shapeA.cols
  const colsB = shapeB.cols
  const result: number[][] = []
  for (let i = 0; i < rowsA; i++) {
    const rowA = A[i]!
    const newRow: number[] = []
    for (let j = 0; j < colsB; j++) {
      let acc = 0
      for (let p = 0; p < colsA; p++) {
        const aVal = rowA[p]!
        const bVal = B[p]![j]!
        if (aVal === 0 || bVal === 0) {
          continue
        }
        const prod = mul(aVal, bVal)
        acc = add(acc, prod)
      }
      newRow.push(acc)
    }
    result.push(newRow)
  }
  return result
}

export function invertWithTrace(A: Matrix): { inverse: Matrix; steps: GFStep[] } {
  const shape = validateMatrixShape(A)
  if (shape.rows !== shape.cols) {
    throw new Error('Matrix must be square')
  }
  const k = shape.rows
  // build augmented matrix M of k x 2k
  const M: number[][] = []
  for (let i = 0; i < k; i++) {
    const rowA = A[i]!
    const newRow: number[] = []
    for (let j = 0; j < k; j++) {
      newRow.push(rowA[j]!)
    }
    for (let j = 0; j < k; j++) {
      if (i === j) {
        newRow.push(1) // identity
      } else {
        newRow.push(0)
      }
    }
    M.push(newRow)
  }
  const steps: GFStep[] = []
  let seq = 0
  for (let col = 0; col < k; col++) {
    // pivot_select
    let pivotRow = -1
    for (let r = col; r < k; r++) {
      const val = M[r]![col]!
      if (val !== 0) {
        pivotRow = r
        break
      }
    }
    if (pivotRow === -1) {
      throw new Error('SINGULAR_MATRIX')
    }
    const beforePivotSelect = deepCopyMatrix(M)
    const afterPivotSelect = deepCopyMatrix(M)
    steps.push({
      seq: seq++,
      op: 'pivot_select',
      pivot_col: col,
      row_a: pivotRow,
      row_b: null,
      factor: null,
      before: beforePivotSelect,
      after: afterPivotSelect,
    })
    if (pivotRow !== col) {
      // swap rows col and pivotRow
      const beforeSwap = deepCopyMatrix(M)
      const rowCol = M[col]!
      const rowPivot = M[pivotRow]!
      M[col] = rowPivot.slice()
      M[pivotRow] = rowCol.slice()
      const afterSwap = deepCopyMatrix(M)
      steps.push({
        seq: seq++,
        op: 'swap',
        pivot_col: col,
        row_a: col,
        row_b: pivotRow,
        factor: null,
        before: beforeSwap,
        after: afterSwap,
      })
    }
    // scale
    const pivotVal = M[col]![col]!
    const scaleFactor = inv(pivotVal)
    const beforeScale = deepCopyMatrix(M)
    const pivotRowCurrent = M[col]!
    const scaledRow: number[] = []
    const totalCols = 2 * k
    for (let j = 0; j < totalCols; j++) {
      scaledRow.push(mul(pivotRowCurrent[j]!, scaleFactor))
    }
    M[col] = scaledRow
    const afterScale = deepCopyMatrix(M)
    steps.push({
      seq: seq++,
      op: 'scale',
      pivot_col: col,
      row_a: col,
      row_b: null,
      factor: scaleFactor,
      before: beforeScale,
      after: afterScale,
    })
    // eliminate other rows
    for (let r = 0; r < k; r++) {
      if (r === col) continue
      const valRCol = M[r]![col]!
      if (valRCol !== 0) {
        const elimFactor = valRCol
        const beforeElim = deepCopyMatrix(M)
        const rowR = M[r]!
        const rowPivotScaled = M[col]!
        const newRowR: number[] = []
        for (let j = 0; j < totalCols; j++) {
          // row_r = row_r + factor * row_pivot_scaled (xor)
          const term = mul(elimFactor, rowPivotScaled[j]!)
          newRowR.push(add(rowR[j]!, term))
        }
        M[r] = newRowR
        const afterElim = deepCopyMatrix(M)
        steps.push({
          seq: seq++,
          op: 'eliminate',
          pivot_col: col,
          row_a: r,
          row_b: col,
          factor: elimFactor,
          before: beforeElim,
          after: afterElim,
        })
      }
    }
  }
  // extract inverse
  const inverse: Matrix = []
  for (let i = 0; i < k; i++) {
    const rowM = M[i]!
    const invRow: number[] = []
    for (let j = 0; j < k; j++) {
      invRow.push(rowM[k + j]!)
    }
    inverse.push(invRow)
  }
  return { inverse, steps }
}

export function buildSystematicMatrix(k: number, m: number): Matrix {
  if (!isInteger(k) || !isInteger(m)) {
    throw new RangeError('k and m must be integers')
  }
  if (k < 1 || m < 1 || k + m > 16) {
    throw new RangeError('require 1 <= k, 1 <= m, k + m <= 16')
  }
  const n = k + m
  const V = buildVandermonde(n, k)
  // T is first k rows of V
  const T: Matrix = []
  for (let i = 0; i < k; i++) {
    const rowV = V[i]!
    const newRow: number[] = []
    for (let j = 0; j < k; j++) {
      newRow.push(rowV[j]!)
    }
    T.push(newRow)
  }
  const TinvRes = invertWithTrace(T)
  const Tinv = TinvRes.inverse
  const G = matMul(V, Tinv)
  return G
}
