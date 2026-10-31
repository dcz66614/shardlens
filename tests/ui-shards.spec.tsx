// P0002-T018 QA_UI — 碎片墙与失败状态回归测试（tests/ui-shards.spec.tsx）。
//
// 覆盖（实施计划 T018 前半：混合/全校验片擦除、失败后再次修复、键盘点击）：
// - 混合擦除（数据片 + 校验片）仍可恢复；全校验片擦除后数据片自足；
//   仅校验片存活时仍可由校验片重建原文（RS(6,4) 的校验片重建能力）；
// - 擦除 3 片触及失败边界：解码结果 recovered/inverse 均为 null，
//   StatusBar 在失败态下强制显示 null/[]，绝不渲染旧成功数据；
// - BYTE_MISMATCH 时 StatusBar 只提示“标擦除”、声明不自动纠错；
// - ShardWall 擦除/恢复按钮可用键盘 Enter 激活，重复点击形成擦除→恢复序列。
//
// 反作弊约定：期望值来自真实 encode/decode（非硬编码恢复字节）；
// 恢复字节相等性用 TextDecoder 与逐字节比较断言，不用生产 verify 的结论背书。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShardWall from '../src/components/ShardWall';
import StatusBar from '../src/components/StatusBar';
import { encode } from '../src/core/encode';
import { recoverExperiment } from '../src/state/session';
import type { DecodeResult } from '../src/core/types';

afterEach(() => {
  cleanup();
});

const ABC = new TextEncoder().encode('ABC');

function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a === null || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('ShardWall + 真实恢复：混合擦除与校验片边界', () => {
  it('混合擦除 [1,4]（数据片+校验片）：碎片墙如实标记，恢复字节等于原文', async () => {
    const enc = await encode(ABC, 4, 2);
    expect(enc.shards).toHaveLength(6);

    render(<ShardWall shards={enc.shards} erased={[1, 4]} onToggleErase={() => {}} />);
    expect(screen.getByTestId('shard-1').getAttribute('data-erased')).toBe('true');
    expect(screen.getByTestId('shard-4').getAttribute('data-erased')).toBe('true');
    expect(screen.getByTestId('shard-0').getAttribute('data-erased')).toBe('false');
    expect(screen.getByTestId('shard-1').textContent).toContain('已擦除');
    expect(screen.getByTestId('shard-0').textContent).toContain('存活');
    const body = document.body.textContent ?? '';
    expect(body).toContain('存活：4');
    expect(body).toContain('已擦除：2');

    const outcome = await recoverExperiment(enc, [1, 4]);
    expect(outcome.verified).toBe(true);
    expect(outcome.decode.recoverable).toBe(true);
    expect(bytesEqual(outcome.decode.recovered, ABC)).toBe(true);
  });

  it('全校验片擦除 [4,5]：仅数据片存活仍可恢复，恢复字节等于原文', async () => {
    const enc = await encode(ABC, 4, 2);
    render(<ShardWall shards={enc.shards} erased={[4, 5]} onToggleErase={() => {}} />);
    expect(screen.getByTestId('shard-4').getAttribute('data-kind')).toBe('parity');
    expect(screen.getByTestId('shard-5').getAttribute('data-kind')).toBe('parity');
    const outcome = await recoverExperiment(enc, [4, 5]);
    expect(outcome.verified).toBe(true);
    expect(bytesEqual(outcome.decode.recovered, ABC)).toBe(true);
  });

  it('擦除数据片 [0,1]：选行含校验片 [2,3,4,5]，校验片真实参与重建', async () => {
    const enc = await encode(ABC, 4, 2);
    const outcome = await recoverExperiment(enc, [0, 1]);
    expect(outcome.decode.recoverable).toBe(true);
    expect(outcome.decode.selectedIndices).toEqual([2, 3, 4, 5]);
    expect(outcome.verified).toBe(true);
    expect(bytesEqual(outcome.decode.recovered, ABC)).toBe(true);
  });
});

describe('失败边界：擦除 3 片不产生伪造恢复字节', () => {
  it('擦除 [1,4,5]：INSUFFICIENT_SHARDS，recovered/inverse 均为 null', async () => {
    const enc = await encode(ABC, 4, 2);
    const outcome = await recoverExperiment(enc, [1, 4, 5]);
    expect(outcome.verified).toBe(false);
    expect(outcome.decode.recoverable).toBe(false);
    expect(outcome.decode.failureReason).toBe('INSUFFICIENT_SHARDS');
    expect(outcome.decode.recovered).toBeNull();
    expect(outcome.decode.inverse).toBeNull();
  });

  it('StatusBar 失败态：即使传入成功解码也强制显示 null/[]，无绿色通过', async () => {
    const enc = await encode(ABC, 4, 2);
    const ok = await recoverExperiment(enc, [1, 4]);
    expect(ok.decode.recovered).not.toBeNull(); // 前置：传入的确实是成功解码
    const failed = await recoverExperiment(enc, [1, 4, 5]);

    render(
      <StatusBar
        phase="FAILED"
        k={4}
        m={2}
        n={6}
        aliveCount={3}
        erasedCount={3}
        failureReason={failed.decode.failureReason}
        decode={ok.decode}
        verified={false}
        byteEqual={false}
        shaEqual={false}
        detail={null}
      />,
    );
    const bar = screen.getByTestId('status-bar');
    expect(bar.textContent).toContain('INSUFFICIENT_SHARDS');
    expect(screen.getByTestId('recovered-value').textContent).toContain('recovered = null');
    expect(screen.getByTestId('inverse-value').textContent).toContain('逆阵 R = null');
    expect(screen.getByTestId('evidence-value').textContent).toContain('证据 = []');
    expect(screen.queryByText(/是（VERIFIED/)).toBeNull();
    // 失败红（T016 的 FAIL_COLOR #b00020），不是通过绿。
    expect(bar.getAttribute('style') ?? '').toContain('176, 0, 32');
  });

  it('BYTE_MISMATCH：只提示标擦除、不自动纠错，且失败门禁仍强制 null', async () => {
    const enc = await encode(ABC, 4, 2);
    const ok = await recoverExperiment(enc, [1, 4]);
    const decode = ok.decode as DecodeResult;
    render(
      <StatusBar
        phase="FAILED"
        k={4}
        m={2}
        n={6}
        aliveCount={4}
        erasedCount={2}
        failureReason="BYTE_MISMATCH"
        decode={decode}
        verified={false}
        byteEqual={false}
        shaEqual={true}
        detail={null}
      />,
    );
    const hint = screen.getByTestId('checksum-hint');
    expect(hint.textContent).toContain('标擦除');
    expect(hint.textContent).toContain('不会自动纠错');
    expect(screen.getByTestId('recovered-value').textContent).toContain('recovered = null');
  });

  it('失败后再次修复：擦除集回到 [1,4] 即可重新 VERIFIED，旧失败不残留', async () => {
    const enc = await encode(ABC, 4, 2);
    const failed = await recoverExperiment(enc, [1, 4, 5]);
    expect(failed.verified).toBe(false);
    expect(failed.decode.recovered).toBeNull();
    const repaired = await recoverExperiment(enc, [1, 4]);
    expect(repaired.verified).toBe(true);
    expect(bytesEqual(repaired.decode.recovered, ABC)).toBe(true);
    expect(repaired.decode.failureReason).toBeNull();
  });
});

describe('ShardWall 键盘与擦除/恢复序列', () => {
  it('Tab 聚焦后按 Enter 激活擦除按钮，回调收到该片索引', async () => {
    const enc = await encode(ABC, 4, 2);
    const onToggleErase = vi.fn();
    const user = userEvent.setup();
    render(<ShardWall shards={enc.shards} erased={[]} onToggleErase={onToggleErase} />);
    const first = screen.getByTestId('toggle-0');
    first.focus();
    expect(document.activeElement).toBe(first);
    await user.keyboard('{Enter}');
    expect(onToggleErase).toHaveBeenCalledTimes(1);
    expect(onToggleErase).toHaveBeenCalledWith(0);
  });

  it('同一按钮点两次形成擦除→恢复序列，回调顺序为 [1, 1]', async () => {
    const enc = await encode(ABC, 4, 2);
    const onToggleErase = vi.fn();
    const user = userEvent.setup();
    render(<ShardWall shards={enc.shards} erased={[]} onToggleErase={onToggleErase} />);
    await user.click(screen.getByTestId('toggle-1'));
    await user.click(screen.getByTestId('toggle-1'));
    expect(onToggleErase).toHaveBeenCalledTimes(2);
    expect(onToggleErase).toHaveBeenNthCalledWith(1, 1);
    expect(onToggleErase).toHaveBeenNthCalledWith(2, 1);
  });

  it('disabled 时按钮不可用，键盘与点击均不触发回调', async () => {
    const enc = await encode(ABC, 4, 2);
    const onToggleErase = vi.fn();
    const user = userEvent.setup();
    render(
      <ShardWall shards={enc.shards} erased={[]} onToggleErase={onToggleErase} disabled />,
    );
    expect((screen.getByTestId('toggle-0') as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByTestId('toggle-0'));
    expect(onToggleErase).not.toHaveBeenCalled();
  });
});
