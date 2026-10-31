// P0002-T018 QA_UI — 实验状态机与 A/B 对比回归测试（tests/ui-session.spec.tsx）。
//
// 覆盖（实施计划 T018 后半：失败后再次修复、旧状态丢弃、A/B 对比、键盘点击）：
// - ExperimentSession 完整生命周期：ENCODED → ERASED → VERIFIED；
// - 失败（擦除 3 片）后修复一格擦除并重新 VERIFIED，旧失败不残留；
// - 任意擦除开关变动同步废止上一轮恢复；输入/参数修改与 reset 废止旧证据；
// - ComparisonPanel 用真实解码结果构造 A/B：A 可恢复、B 失败且无虚构数据；
//   stale 横幅与键盘重新冻结；frozenA 为 null 时只显示空态。
//
// 反作弊约定：A/B 方案均由真实 encode/recoverExperiment 填写；
// 失败方案的逆阵/选行/哈希按接口约定显式为 null，面板不得凭空补数据。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ComparisonPanel from '../src/components/ComparisonPanel';
import type { ComparisonCase } from '../src/components/ComparisonPanel';
import { encode } from '../src/core/encode';
import {
  ExperimentSession,
  recoverExperiment,
} from '../src/state/session';

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

/** 由真实解码结果构造对比方案：失败时逆阵/选行/哈希一律为 null。 */
async function buildCase(
  label: string,
  erased: number[],
): Promise<ComparisonCase> {
  const enc = await encode(ABC, 4, 2);
  const outcome = await recoverExperiment(enc, erased);
  const alive = enc.shards
    .map((s) => s.index)
    .filter((i) => !erased.includes(i));
  const d = outcome.decode;
  return {
    label,
    erased: [...erased].sort((a, b) => a - b),
    alive,
    selectedIndices: d.recoverable ? d.selectedIndices : null,
    selectedMatrix: d.recoverable ? d.Gs : null,
    inverse: d.recoverable ? d.inverse : null,
    recoverable: d.recoverable,
    failureReason: d.failureReason,
    verified: outcome.verified,
    recoveredSha256: d.recoverable ? outcome.recoveredSha256 : null,
  };
}

describe('ExperimentSession 生命周期与失败后修复', () => {
  it('编码 → 擦除 [1,4] → 恢复 VERIFIED，恢复字节等于原文', async () => {
    const s = new ExperimentSession();
    expect(s.getState().phase).toBe('CLEAN');
    await s.encode();
    expect(s.getState().phase).toBe('ENCODED');
    expect(s.getState().encoded?.shards).toHaveLength(6);
    s.toggleErase(1);
    s.toggleErase(4);
    expect(s.getState().phase).toBe('ERASED');
    expect(s.getState().erased).toEqual([1, 4]);
    await s.recover();
    const st = s.getState();
    expect(st.phase).toBe('VERIFIED');
    expect(st.failureReason).toBeNull();
    expect(bytesEqual(st.recovery?.decode.recovered ?? null, ABC)).toBe(true);
  });

  it('失败后再次修复：擦除 [1,4,5] FAILED → 恢复一格 → 重新 VERIFIED', async () => {
    const s = new ExperimentSession();
    await s.encode();
    s.toggleErase(1);
    s.toggleErase(4);
    s.toggleErase(5);
    await s.recover();
    expect(s.getState().phase).toBe('FAILED');
    expect(s.getState().failureReason).toBe('INSUFFICIENT_SHARDS');
    expect(s.getState().recovery?.decode.recovered).toBeNull();
    expect(s.getState().recovery?.decode.inverse).toBeNull();

    // 修复：恢复分片 5，旧失败证据必须同步废止（未重算前 recovery 为 null）。
    s.toggleErase(5);
    expect(s.getState().erased).toEqual([1, 4]);
    expect(s.getState().recovery).toBeNull();
    expect(s.getState().failureReason).toBeNull();
    await s.recover();
    expect(s.getState().phase).toBe('VERIFIED');
    expect(bytesEqual(s.getState().recovery?.decode.recovered ?? null, ABC)).toBe(true);
  });

  it('任意擦除开关变动同步废止上一轮 VERIFIED，不呈现过期通过', async () => {
    const s = new ExperimentSession();
    await s.encode();
    s.toggleErase(1);
    s.toggleErase(4);
    await s.recover();
    expect(s.getState().phase).toBe('VERIFIED');
    s.toggleErase(2);
    const st = s.getState();
    expect(st.phase).toBe('ERASED');
    expect(st.recovery).toBeNull();
    expect(st.failureReason).toBeNull();
  });

  it('输入/参数修改与 reset 废止旧证据：不保留过期分片与恢复', async () => {
    const s = new ExperimentSession();
    await s.encode();
    s.toggleErase(1);
    s.toggleErase(4);
    await s.recover();
    expect(s.getState().phase).toBe('VERIFIED');

    s.setInputText('XYZ');
    let st = s.getState();
    expect(st.phase).toBe('CLEAN');
    expect(st.encoded).toBeNull();
    expect(st.recovery).toBeNull();
    expect(st.erased).toEqual([]);

    await s.encode();
    expect(s.getState().phase).toBe('ENCODED');
    s.setParams(4, 3);
    st = s.getState();
    expect(st.phase).toBe('CLEAN');
    expect(st.encoded).toBeNull();
    expect(st.recovery).toBeNull();

    s.setInputText('ABC');
    await s.encode();
    s.toggleErase(1);
    await s.recover();
    expect(s.getState().phase).toBe('VERIFIED');
    s.reset();
    st = s.getState();
    expect(st.phase).toBe('CLEAN');
    expect(st.inputText).toBe('');
    expect(st.encoded).toBeNull();
    expect(st.recovery).toBeNull();
    expect(st.erased).toEqual([]);
  });

  it('越界擦除索引被忽略；clearErase 回到 ENCODED 并废止旧证据', async () => {
    const s = new ExperimentSession();
    await s.encode();
    s.toggleErase(99);
    s.toggleErase(-1);
    expect(s.getState().erased).toEqual([]);
    s.toggleErase(1);
    s.toggleErase(4);
    await s.recover();
    expect(s.getState().phase).toBe('VERIFIED');
    s.clearErase();
    const st = s.getState();
    expect(st.erased).toEqual([]);
    expect(st.phase).toBe('ENCODED');
    expect(st.recovery).toBeNull();
  });
});

describe('ComparisonPanel：真实 A/B 对比与过期重冻', () => {
  it('A 擦除 [1,4] 可恢复、B 擦除 [1,4,5] 失败：结论与首个差异正确，B 无虚构数据', async () => {
    const a = await buildCase('冻结 A', [1, 4]);
    const b = await buildCase('当前 B', [1, 4, 5]);
    expect(a.recoverable).toBe(true);
    expect(a.selectedIndices).toEqual([0, 2, 3, 5]);
    expect(b.recoverable).toBe(false);
    expect(b.failureReason).toBe('INSUFFICIENT_SHARDS');
    expect(b.inverse).toBeNull();
    expect(b.selectedIndices).toBeNull();
    expect(b.recoveredSha256).toBeNull();

    render(<ComparisonPanel frozenA={a} currentB={b} stale={false} />);
    const panel = screen.getByTestId('comparison-panel');
    expect(panel.textContent).toContain('结论：A 可恢复、B 不可恢复（INSUFFICIENT_SHARDS）');
    expect(panel.textContent).toContain('首个差异：擦除集不同：A=[1,4]，B=[1,4,5]');
    const caseB = screen.getByTestId('case-b');
    expect(caseB.textContent).toContain('逆阵 R：null');
    expect(caseB.textContent).toContain('恢复 SHA-256：null');
    expect(caseB.textContent).toContain('不显示虚构数据');
    expect(screen.queryByTestId('comparison-stale')).toBeNull();
  });

  it('stale 时显示过期横幅；键盘 Enter 激活重新冻结', async () => {
    const a = await buildCase('冻结 A', [1, 4]);
    const b = await buildCase('当前 B', [1, 4, 5]);
    const onRefreeze = vi.fn();
    const user = userEvent.setup();
    render(
      <ComparisonPanel frozenA={a} currentB={b} stale onRefreeze={onRefreeze} />,
    );
    expect(screen.getByTestId('comparison-stale').textContent).toContain('比较已过期');
    const btn = screen.getByTestId('refreeze-button');
    btn.focus();
    expect(document.activeElement).toBe(btn);
    await user.keyboard('{Enter}');
    expect(onRefreeze).toHaveBeenCalledTimes(1);
  });

  it('frozenA 为 null 时只显示空态，不编造 A 方案', async () => {
    const b = await buildCase('当前 B', [1, 4]);
    render(<ComparisonPanel frozenA={null} currentB={b} stale={false} />);
    expect(screen.getByTestId('comparison-empty').textContent).toContain('尚未冻结 A');
    expect(screen.queryByTestId('case-a')).toBeNull();
    expect(screen.queryByTestId('comparison-diff')).toBeNull();
  });

  it('相同方案对比：首个差异为完全一致，结论为均可恢复', async () => {
    const a = await buildCase('冻结 A', [1, 4]);
    const b = await buildCase('当前 B', [1, 4]);
    render(<ComparisonPanel frozenA={a} currentB={b} stale={false} />);
    const panel = screen.getByTestId('comparison-panel');
    expect(panel.textContent).toContain('结论：A、B 均可恢复');
    expect(panel.textContent).toContain('首个差异：完全一致');
  });
});
