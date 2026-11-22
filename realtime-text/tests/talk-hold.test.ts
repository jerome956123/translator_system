import { describe, expect, it, vi } from 'vitest';
import { TalkHold, TAP_MS, bindSpaceToTalk, canUseSpace } from '../src/lib/talk-hold';

function key(type: string, properties: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), { code: 'Space', repeat: false, ...properties }) as KeyboardEvent;
}
function harness(accept = true) {
  let time = 1000;
  const start = vi.fn(() => accept), end = vi.fn(), latch = vi.fn();
  const hold = new TalkHold(start, end, () => time, latch);
  return { start, end, latch, hold, wait: (ms: number) => { time += ms; } };
}

describe('空白鍵、按鈕與失焦釋放', () => {
  it('鍵盤長按的 repeat 不重送；keyup 即使焦點已換到輸入框仍釋放', () => {
    const h = harness(), root = new EventTarget(), cleanup = bindSpaceToTalk(root, h.hold);
    const down = key('keydown'); root.dispatchEvent(down); expect(down.defaultPrevented).toBe(true);
    root.dispatchEvent(key('keydown', { repeat: true })); h.wait(TAP_MS + 200); root.dispatchEvent(key('keyup'));
    expect(h.start).toHaveBeenCalledOnce(); expect(h.end).toHaveBeenCalledOnce(); expect(h.latch).not.toHaveBeenCalled(); cleanup();
  });
  it('打字、其他按鈕、快捷鍵與輸入法組字時，空白鍵維持原用途', () => {
    for (const properties of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { code: 'Enter' }])
      expect(canUseSpace(key('keydown', properties))).toBe(false);
    const event = key('keydown');
    Object.defineProperty(event, 'target', { value: { closest: (selector: string) => selector.includes('input') ? {} : null } });
    expect(canUseSpace(event)).toBe(false);
    const h = harness(false), root = new EventTarget(); const cleanup = bindSpaceToTalk(root, h.hold);
    const disabled = key('keydown'); root.dispatchEvent(disabled); expect(disabled.defaultPrevented).toBe(false); cleanup();
  });
  it('鍵盤與手指同時按住時，只在最後一個放開才結束，失焦及卸載不能卡住', () => {
    const h = harness(), root = new EventTarget(), cleanup = bindSpaceToTalk(root, h.hold);
    root.dispatchEvent(key('keydown')); h.hold.press('pointer'); h.wait(TAP_MS + 200); root.dispatchEvent(key('keyup'));
    expect(h.end).not.toHaveBeenCalled(); expect(h.start).toHaveBeenCalledOnce();
    root.dispatchEvent(new Event('blur')); expect(h.end).toHaveBeenCalledOnce();
    h.hold.press('pointer'); cleanup(); expect(h.end).toHaveBeenCalledTimes(2); h.hold.release('pointer'); expect(h.end).toHaveBeenCalledTimes(2);
  });
});

describe('按住說話與按一下開始共用同一顆鍵', () => {
  it('按住超過 0.4 秒再放開：放開就結束（對講機）', () => {
    const h = harness();
    expect(h.hold.press('pointer')).toBe(true); h.wait(TAP_MS); h.hold.release('pointer');
    expect(h.end).toHaveBeenCalledOnce(); expect(h.hold.latched).toBe(false); expect(h.latch).not.toHaveBeenCalled();
  });

  it('很快按一下：放開後繼續收音，再按一下才結束，那次的放開不再有作用', () => {
    const h = harness();
    h.hold.press('pointer'); h.wait(TAP_MS - 1); h.hold.release('pointer');
    expect(h.end).not.toHaveBeenCalled(); expect(h.hold.latched).toBe(true); expect(h.latch).toHaveBeenLastCalledWith(true);
    h.wait(60000);
    expect(h.hold.press('pointer')).toBe(true);
    expect(h.end).toHaveBeenCalledOnce(); expect(h.hold.latched).toBe(false); expect(h.latch).toHaveBeenLastCalledWith(false);
    expect(h.start).toHaveBeenCalledOnce();
    h.wait(50); h.hold.release('pointer');
    expect(h.end).toHaveBeenCalledOnce(); expect(h.hold.latched).toBe(false); expect(h.start).toHaveBeenCalledOnce();
  });

  it('結束之後可以立刻開始下一句，按一下或按住都可以', () => {
    const h = harness();
    h.hold.press('pointer'); h.wait(100); h.hold.release('pointer');
    h.wait(3000); h.hold.press('pointer'); h.wait(100); h.hold.release('pointer');
    h.wait(500); h.hold.press('pointer'); h.wait(2000); h.hold.release('pointer');
    expect(h.start).toHaveBeenCalledTimes(2); expect(h.end).toHaveBeenCalledTimes(2); expect(h.hold.latched).toBe(false);
  });

  it('空白鍵也一樣：很快按一下持續收音，再按一下結束；用手指也能結束鍵盤開始的收音', () => {
    const h = harness(), root = new EventTarget(), cleanup = bindSpaceToTalk(root, h.hold);
    root.dispatchEvent(key('keydown')); h.wait(120); root.dispatchEvent(key('keyup'));
    expect(h.hold.latched).toBe(true); expect(h.end).not.toHaveBeenCalled();
    h.wait(5000);
    const again = key('keydown'); root.dispatchEvent(again); expect(again.defaultPrevented).toBe(true);
    expect(h.end).toHaveBeenCalledOnce();
    const up = key('keyup'); root.dispatchEvent(up); expect(up.defaultPrevented).toBe(true); expect(h.end).toHaveBeenCalledOnce();

    root.dispatchEvent(key('keydown')); h.wait(120); root.dispatchEvent(key('keyup')); expect(h.hold.latched).toBe(true);
    h.hold.press('pointer'); expect(h.end).toHaveBeenCalledTimes(2); h.hold.release('pointer');
    expect(h.end).toHaveBeenCalledTimes(2); cleanup();
  });

  it('手指滑出按鈕或被系統取消時直接結束，不會變成持續收音', () => {
    const h = harness();
    h.hold.press('pointer'); h.wait(100); h.hold.cancel('pointer');
    expect(h.end).toHaveBeenCalledOnce(); expect(h.hold.latched).toBe(false);
  });

  it('視窗失焦只結束正按著的鍵，持續收音不受影響；按鈕停用或頁面切到背景則一併結束', () => {
    const h = harness();
    h.hold.press('pointer'); h.wait(100); h.hold.release('pointer');
    h.hold.releaseHeld(); expect(h.end).not.toHaveBeenCalled(); expect(h.hold.latched).toBe(true);
    h.hold.releaseAll(); expect(h.end).toHaveBeenCalledOnce(); expect(h.hold.latched).toBe(false);
    h.hold.releaseAll(); expect(h.end).toHaveBeenCalledOnce();
  });

  it('這一句已由別處結束時只清狀態，不重複結束；之後可以重新開始', () => {
    const h = harness();
    h.hold.press('pointer'); h.wait(100); h.hold.release('pointer');
    h.hold.reset(); expect(h.end).not.toHaveBeenCalled(); expect(h.hold.latched).toBe(false);
    expect(h.hold.press('pointer')).toBe(true); expect(h.start).toHaveBeenCalledTimes(2);
  });

  it('開始被拒絕（還沒待命或對方正在說）時不進入任何狀態', () => {
    const h = harness(false);
    expect(h.hold.press('pointer')).toBe(false); h.wait(100); h.hold.release('pointer');
    expect(h.hold.latched).toBe(false); expect(h.end).not.toHaveBeenCalled();
  });
});
