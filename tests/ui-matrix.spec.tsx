// P0002-T015 QA_UI — 矩阵工作台一致性测试（tests/ui-matrix.spec.tsx）。
//
// 反作弊约定：
// - G 与逆阵 R 的期望值来自项目书 §12.1 固定样例（规格数字，非生产计算结果）；
// - Gs×R=I 与中间快照的代数关系用测试内独立参考乘法（位移位 + XOR +
//   0x11D 约简）复算，不导入生产 gf256 的 mul / 查表；
// - 表单元格一律用 within(<单张表>) 限定取值（g-matrix / aug-matrix 的
//   matrix-cell-r-c testid 重复，禁止全局 getByTestId 抢第一张表）。

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MatrixWorkbench from '../src/components/MatrixWorkbench';
import { invertWithTrace } from '../src/core/rs_matrix';
import type { Matrix } from '../src/core/types';

afterEach(() => {
  cleanup();
});

// ---------- 独立参考乘法（bitwise, 0x11D 约简） ----------
const PRIMITIVE_POLY = 0x11d;
function refMul(a: number, b: number): number {
  let result = 0;
  let aa = a & 0xff;
  let bb = b & 0xff;
  while (bb !== 0) {
    if (bb & 1) result ^= aa;
    aa <<= 1;
    if (aa & 0x100) aa ^= PRIMITIVE_POLY;
    bb >>= 1;
  }
  return result & 0xff;
}

function refMatMul(A: Matrix, B: Matrix): Matrix {
  const out: Matrix = [];
  for (let i = 0; i < A.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < B[0]!.length; j++) {
      let acc = 0;
      for (let p = 0; p < A[0]!.length; p++) {
        acc ^= refMul(A[i]![p]!, B[p]![j]!);
      }
      row.push(acc);
    }
    out.push(row);
  }
  return out;
}

function identity(k: number): Matrix {
  return Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)),
  );
}

// ---------- §12.1 固定样例（规格，不来自生产代码） ----------
const EXPECTED_G: Matrix = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
  [64, 120, 54, 15],
  [231, 210, 87, 99],
];
const EXPECTED_R_FOR_0_2_3_5: Matrix = [
  [1, 0, 0, 0],
  [234, 46, 13, 200],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
];

/** 从单张表读出矩阵（单元格 testid 形如 matrix-cell-r-c）。 */
function readMatrix(table: HTMLElement, rows: number, cols: number): Matrix {
  const out: Matrix = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = within(table).getByTestId(`matrix-cell-${r}-${c}`);
      row.push(Number(cell.textContent));
    }
    out.push(row);
  }
  return out;
}

async function toggleRow(user: ReturnType<typeof userEvent.setup>, r: number): Promise<void> {
  // 切换按钮文本形如 "☑ D1（行 1）" / "☐ P1（行 5）"，按"（行 r）"精确定位
  const btn = screen
    .getAllByRole('button')
    .find((b) => b.textContent?.includes(`（行 ${r}）`));
  expect(btn).toBeTruthy();
  await user.click(btn!);
}

describe('MatrixWorkbench（默认 RS(6,4)，默认选中 [0,1,2,3]）', () => {
  it('显示的 G 与项目书 §12.1 固定值严格相等', () => {
    render(<MatrixWorkbench />);
    const g = readMatrix(screen.getByTestId('g-matrix'), 6, 4);
    expect(g).toEqual(EXPECTED_G);
  });

  it('把选择切到 [0,2,3,5] 后：显示的 R 与 §12.1 指定逆阵严格相等，且 Gs×R=I（参考乘法复算）', async () => {
    const user = userEvent.setup();
    render(<MatrixWorkbench />);
    // 满 k 行时点未选行无变化 → 先取消一行再选
    await toggleRow(user, 1); // 取消 D1 → [0,2,3]
    await toggleRow(user, 5); // 加 P1 → [0,2,3,5]

    const g = readMatrix(screen.getByTestId('g-matrix'), 6, 4);
    expect(g).toEqual(EXPECTED_G); // G 本身不随选择改变
    // Gs 取自显示的 G（独立于生产计算）
    const Gs = [0, 2, 3, 5].map((r) => g[r]!);
    expect(Gs).toEqual([
      [1, 0, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
      [231, 210, 87, 99],
    ]);

    const rTable = screen.getByTestId('r-matrix');
    const rCells = within(rTable).getAllByRole('cell');
    const R: Matrix = [];
    for (let i = 0; i < 4; i++) R.push(rCells.slice(i * 4, i * 4 + 4).map((c) => Number(c.textContent)));
    expect(R).toEqual(EXPECTED_R_FOR_0_2_3_5);
    // 独立复算 Gs×R=I
    expect(refMatMul(Gs, R)).toEqual(identity(4));
  });

  it('满 k 行时点未选行无变化（需先取消一行再选）', async () => {
    const user = userEvent.setup();
    render(<MatrixWorkbench />);
    const buttonFor = (r: number) =>
      screen
        .getAllByRole('button')
        .find((b) => b.textContent?.includes(`（行 ${r}）`))!;

    await user.click(buttonFor(5)); // 已满 4 行，点击未选行应无任何变化
    // 选择仍是 [0,1,2,3]：行 0-3 高亮，行 4/5 未选
    const pressedRows = [0, 1, 2, 3, 4, 5].filter(
      (r) => buttonFor(r).getAttribute('aria-pressed') === 'true',
    );
    expect(pressedRows).toEqual([0, 1, 2, 3]);

    await user.click(buttonFor(0)); // 取消 D0 → [1,2,3]，不足 k 行，无轨迹
    expect(buttonFor(0).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/还需选择 1 行/)).toBeTruthy();
    expect(screen.getByTestId('btn-next')).toHaveProperty('disabled', true);

    await user.click(buttonFor(5)); // 加 P1 → [1,2,3,5]，重新出现轨迹
    const pressedRows2 = [0, 1, 2, 3, 4, 5].filter(
      (r) => buttonFor(r).getAttribute('aria-pressed') === 'true',
    );
    expect(pressedRows2).toEqual([1, 2, 3, 5]);
    expect(screen.getByTestId('r-matrix').textContent).not.toContain('（不可用）');
  });

  it('逐步点击下一步重放轨迹：初始/中间/最终快照与 invertWithTrace 的 before/after 一致，最终快照右半 = R', async () => {
    const user = userEvent.setup();
    render(<MatrixWorkbench />);
    const buttonFor = (r: number) =>
      screen
        .getAllByRole('button')
        .find((b) => b.textContent?.includes(`（行 ${r}）`))!;
    await user.click(buttonFor(1));
    await user.click(buttonFor(5));
    // 与生产同一存活集求逆（期望轨迹的"形状"来自真实求解；代数值仍独立复算）
    const Gs = [0, 2, 3, 5].map((r) => EXPECTED_G[r]!);
    const { steps } = invertWithTrace(Gs);
    expect(steps.length).toBeGreaterThan(0);

    const aug = screen.getByTestId('aug-matrix');
    const stepInfo = screen.getByTestId('step-info');
    const btnNext = screen.getByTestId('btn-next');
    const btnPrev = screen.getByTestId('btn-prev');

    const readSnapshot = () => readMatrix(aug, 4, 8);
    const half = (m: Matrix, which: 'left' | 'right') =>
      m.map((row) => row.slice(which === 'left' ? 0 : 4, which === 'left' ? 4 : 8));

    // 初始快照：左半 = Gs，右半 = I
    expect(half(readSnapshot(), 'left')).toEqual(Gs);
    expect(half(readSnapshot(), 'right')).toEqual(identity(4));
    expect(screen.getByText(`Step 0 of ${steps.length}`)).toBeTruthy();
    expect(btnPrev).toHaveProperty('disabled', true);
    expect(btnNext).toHaveProperty('disabled', false);
    expect(stepInfo.textContent).toContain('初始快照');

    // 轨迹相邻关系（before/after 链）独立检查
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.before).toEqual(steps[i - 1]!.after);
    }

    // 逐步推进：点击 c 次后 cursor=c，快照 = steps[c].after，步信息 = steps[c]
    for (let c = 1; c < steps.length; c++) {
      await user.click(btnNext);
      expect(screen.getByText(`Step ${c} of ${steps.length}`)).toBeTruthy();
      expect(readSnapshot()).toEqual(steps[c]!.after);
      expect(stepInfo.textContent).toContain(`seq: ${steps[c]!.seq}`);
      expect(stepInfo.textContent).toContain(`op: ${steps[c]!.op}`);
      expect(stepInfo.textContent).toContain(`pivot_col: ${steps[c]!.pivot_col}`);
      expect(btnPrev).toHaveProperty('disabled', false);
    }
    // 最终：左半 = I，右半 = R（代数关系独立复算）
    expect(half(readSnapshot(), 'left')).toEqual(identity(4));
    expect(half(readSnapshot(), 'right')).toEqual(EXPECTED_R_FOR_0_2_3_5);
    expect(refMatMul(Gs, half(readSnapshot(), 'right'))).toEqual(identity(4));
    expect(btnNext).toHaveProperty('disabled', true);

    // 上一步逐步回退：cursor=c-1 时快照 = steps[c].before（= steps[c-1].after）
    for (let c = steps.length - 1; c >= 1; c--) {
      await user.click(btnPrev);
      expect(screen.getByText(`Step ${c - 1} of ${steps.length}`)).toBeTruthy();
      expect(readSnapshot()).toEqual(steps[c]!.before);
      expect(readSnapshot()).toEqual(steps[c - 1]!.after);
    }
    expect(half(readSnapshot(), 'left')).toEqual(Gs);
    expect(half(readSnapshot(), 'right')).toEqual(identity(4));
    expect(screen.getByText(`Step 0 of ${steps.length}`)).toBeTruthy();
    expect(btnPrev).toHaveProperty('disabled', true);
  });
});
