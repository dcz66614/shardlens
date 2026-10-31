// P0002-T015 QA_UI — 逐字节检查器一致性测试（tests/ui-byte-inspector.spec.tsx）。
//
// 反作弊约定：
// - DecodeInput 只含存活分片与矩阵，绝不含 original（反作弊不变式）；
// - 显示的每项 coefficient / product / xor_accumulator / result_byte 用测试内
//   独立参考乘法（位移位 + XOR + 0x11D 约简）复算，不导入生产 gf256；
// - 偏移 1 的期望数值（乘积 [242,61,0,141]、XOR 链 [242,207,207,66]、结果 66）
//   来自项目书 §12.1 / 实施计划 T013 固定规格样例。

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ByteInspector from '../src/components/ByteInspector';
import { encode } from '../src/core/encode';
import { decodeSurvivors } from '../src/core/decode';
import type {
  ByteTerm,
  DecodeInput,
  DecodeResult,
  EncodeResult,
  Matrix,
} from '../src/core/types';

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

// ---------- 实验构造 ----------
function buildDecodeInput(encoded: EncodeResult, survivors: number[]): DecodeInput {
  return {
    k: encoded.k,
    m: encoded.m,
    n: encoded.n,
    originalLen: encoded.original.length,
    paddingLen: encoded.paddingLen,
    shardLen: encoded.shardLen,
    encodingMatrix: encoded.G,
    available: survivors.map((i) => ({ index: i, bytes: encoded.shards[i]!.bytes })),
  };
}

async function setupABC(): Promise<{ encoded: EncodeResult; decoded: DecodeResult }> {
  const encoded = await encode(new TextEncoder().encode('ABC'), 4, 2);
  // 擦除 [1,4] → 存活 [0,2,3,5]（§12.1）
  const decoded = decodeSurvivors(
    buildDecodeInput(encoded, [0, 2, 3, 5]),
  );
  return { encoded, decoded };
}

/** 从 byte-terms 表读出全部计算项。 */
function readTerms(table: HTMLElement): ByteTerm[] {
  const rows = within(table).getAllByTestId(/^byte-term-\d+$/);
  return rows.map((row) => {
    const cells = within(row).getAllByRole('cell');
    // "234 (0xea)" → 234；survivor 按钮文本 "分片 3" → 3
    const decNum = (s: string): number => {
      const m = s.trim().match(/^(\d+)/);
      return m === null ? NaN : Number(m[1]);
    };
    // 行内 cell 顺序：survivor 按钮、coefficient、input_byte、product、xor_accumulator
    // （首格是含按钮的 <td>，十进制值在前，如 "234 (0xea)"）
    return {
      survivor_index: decNum(
        (within(row).getByRole('button').textContent ?? '').match(/\d+/)?.[0] ?? '',
      ),
      coefficient: decNum(cells[1]!.textContent ?? ''),
      input_byte: decNum(cells[2]!.textContent ?? ''),
      product: decNum(cells[3]!.textContent ?? ''),
      xor_accumulator: decNum(cells[4]!.textContent ?? ''),
    };
  });
}

describe('ByteInspector（ABC，擦除 [1,4]，§12.1）', () => {
  it('每项 terms.length===k=4，数值与参考乘法复算一致，result/expected/equal 显示正确', async () => {
    const { encoded, decoded } = await setupABC();
    const matrixCalls: Array<[number, number]> = [];
    const shardCalls: Array<[number, number]> = [];
    render(
      <ByteInspector
        encoded={encoded}
        decoded={decoded}
        onLocateMatrix={(row, col) => matrixCalls.push([row, col])}
        onLocateShard={(idx, off) => shardCalls.push([idx, off])}
        initialOffset={1}
      />,
    );

    const proof = screen.getByTestId('byte-proof');
    const termsTable = screen.getByTestId('byte-terms');
    const terms = readTerms(termsTable);

    // terms.length === k（断言不得弱化）
    const k = decoded.selectedIndices.length;
    expect(k).toBe(4);
    expect(terms.length).toBe(k);

    // 每项数值独立复算：R[1,:] 与存活片偏移 0（shardLen=1）的真实字节
    const R = decoded.inverse as Matrix;
    const coefficientRow = R[1]!;
    const offset = 1;
    const dataShardIndex = Math.floor(offset / encoded.shardLen);
    const shardOffset = offset % encoded.shardLen;
    expect(dataShardIndex).toBe(1);
    expect(coefficientRow).toEqual([234, 46, 13, 200]); // §12.1

    let acc = 0;
    const chain: number[] = [];
    terms.forEach((t, j) => {
      expect(t.survivor_index).toBe(decoded.selectedIndices[j]);
      expect(t.coefficient).toBe(coefficientRow[j]);
      expect(t.input_byte).toBe(
        encoded.shards[t.survivor_index]!.bytes[shardOffset],
      );
      expect(t.product).toBe(refMul(t.coefficient, t.input_byte));
      acc ^= refMul(t.coefficient, t.input_byte);
      chain.push(acc);
      expect(t.xor_accumulator).toBe(chain[j]);
    });
    // §12.1 / T013 固定样例
    expect(terms.map((t) => t.product)).toEqual([242, 61, 0, 141]);
    expect(terms.map((t) => t.xor_accumulator)).toEqual([242, 207, 207, 66]);

    // 结果 / 期望 / 相等
    const resultText = screen.getByTestId('byte-result').textContent ?? '';
    expect(resultText).toContain('result_byte: 66 (0x42)');
    expect(resultText).toContain('expected_byte: 66 (0x42)');
    expect(screen.getByTestId('byte-equal').textContent).toBe('true');

    // 点击 term-shard 按钮回调 onLocateShard(survivor_index, shard_offset)
    for (let j = 0; j < k; j++) {
      await userEvent.click(screen.getByTestId(`term-shard-${j}`));
    }
    expect(shardCalls).toEqual([
      [decoded.selectedIndices[0], shardOffset],
      [decoded.selectedIndices[1], shardOffset],
      [decoded.selectedIndices[2], shardOffset],
      [decoded.selectedIndices[3], shardOffset],
    ]);

    // 点击 coeff 按钮回调 onLocateMatrix(data_shard_index, col)
    for (let col = 0; col < 4; col++) {
      await userEvent.click(screen.getByTestId(`coeff-${col}`));
    }
    expect(matrixCalls).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
  });

  it('偏移输入确认与上一/下一字节切换后显示对应偏移的证明', async () => {
    const { encoded, decoded } = await setupABC();
    const user = userEvent.setup();
    render(<ByteInspector encoded={encoded} decoded={decoded} />);
    const recovered = decoded.recovered as Uint8Array;
    expect(recovered.length).toBe(3);

    const input = screen.getByTestId('offset-input') as HTMLInputElement;
    const confirm = screen.getByTestId('offset-confirm');

    // 确认偏移 2
    await user.clear(input);
    await user.type(input, '2');
    await user.click(confirm);
    let proofText = screen.getByTestId('byte-proof').textContent ?? '';
    expect(proofText).toContain('偏移 2');
    expect(proofText).toContain('data_shard_index=2');
    // 结果字节必须等于恢复字节（独立复算：R[2,:] × 存活片字节）
    const R = decoded.inverse as Matrix;
    let acc = 0;
    for (let j = 0; j < 4; j++) {
      acc ^= refMul(R[2]![j]!, encoded.shards[decoded.selectedIndices[j]!]!.bytes[0]!);
    }
    expect(acc).toBe(recovered[2]);
    expect(screen.getByTestId('byte-result').textContent).toContain(
      `result_byte: ${acc} (0x${acc.toString(16).padStart(2, '0')})`,
    );

    // 下一字节：越界（2+1=3 >= 3），显示 offset-error 且保持偏移 2
    await user.click(screen.getByTestId('offset-next'));
    expect(screen.getByTestId('offset-error').textContent).toContain('越界');
    proofText = screen.getByTestId('byte-proof').textContent ?? '';
    expect(proofText).toContain('偏移 2');

    // 上一字节：回到偏移 1
    await user.click(screen.getByTestId('offset-prev'));
    proofText = screen.getByTestId('byte-proof').textContent ?? '';
    expect(proofText).toContain('偏移 1');
    expect(screen.getByTestId('byte-result').textContent).toContain('result_byte: 66 (0x42)');
    expect(screen.queryByTestId('offset-error')).toBeNull();
  });

  it('越界偏移显示 offset-error 且不展示越界证明', async () => {
    const { encoded, decoded } = await setupABC();
    const recovered = decoded.recovered as Uint8Array;
    const user = userEvent.setup();
    render(<ByteInspector encoded={encoded} decoded={decoded} />);
    const input = screen.getByTestId('offset-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '9');
    await user.click(screen.getByTestId('offset-confirm'));
    expect(screen.getByTestId('offset-error').textContent).toContain('越界');
    // 越界时有效偏移不更新：证明仍显示上一次有效偏移 0，且未读取越界字节
    const proof = screen.getByTestId('byte-proof');
    expect(proof.textContent).toContain('偏移 0');
    expect(screen.getByTestId('byte-result').textContent).toContain(
      `result_byte: 65 (0x41)`,
    );
    // 有效偏移未更新：上一字节仍基于 0 → 显示错误（0-1 越界）
    await user.click(screen.getByTestId('offset-prev'));
    expect(screen.getByTestId('offset-error').textContent).toContain('越界');
  });

  it('失败解码（存活不足 k）显示 byte-empty 与 byte-failure（INSUFFICIENT_SHARDS）且不显示 byte-proof', async () => {
    const encoded = await encode(new TextEncoder().encode('ABC'), 4, 2);
    const decoded = decodeSurvivors(buildDecodeInput(encoded, [0, 1, 2]));
    expect(decoded.recoverable).toBe(false);
    expect(decoded.failureReason).toBe('INSUFFICIENT_SHARDS');
    render(<ByteInspector encoded={encoded} decoded={decoded} />);
    expect(screen.getByTestId('byte-empty')).toBeTruthy();
    const failure = screen.getByTestId('byte-failure');
    expect(failure.textContent).toContain('INSUFFICIENT_SHARDS');
    expect(screen.queryByTestId('byte-proof')).toBeNull();
    expect(screen.queryByTestId('byte-terms')).toBeNull();
    expect(screen.queryByTestId('offset-input')).toBeNull();
  });

  it('空输入显示 byte-empty', async () => {
    const encoded = await encode(new TextEncoder().encode(''), 4, 2);
    const decoded = decodeSurvivors(
      buildDecodeInput(encoded, [0, 1, 2, 3, 4, 5]),
    );
    expect(decoded.recoverable).toBe(true);
    expect((decoded.recovered as Uint8Array).length).toBe(0);
    render(<ByteInspector encoded={encoded} decoded={decoded} />);
    expect(screen.getByTestId('byte-empty')).toBeTruthy();
    expect(screen.queryByTestId('byte-proof')).toBeNull();
    expect(screen.queryByTestId('byte-failure')).toBeNull();
  });
});
