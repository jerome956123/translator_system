import { describe, expect, it, vi } from 'vitest';
import { TalkHold, bindSpaceToTalk, canUseSpace } from '../src/lib/talk-hold';

function key(type: string, properties: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), { code: 'Space', repeat: false, ...properties }) as KeyboardEvent;
}
describe('空白鍵、按鈕與失焦釋放', () => {
  it('鍵盤長按的 repeat 不重送；keyup 即使焦點已換到輸入框仍釋放', () => {
    const start = vi.fn(() => true), end = vi.fn(), root = new EventTarget();
    const hold = new TalkHold(start, end), cleanup = bindSpaceToTalk(root, hold);
    const down = key('keydown'); root.dispatchEvent(down); expect(down.defaultPrevented).toBe(true);
    root.dispatchEvent(key('keydown', { repeat: true })); root.dispatchEvent(key('keyup'));
    expect(start).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledOnce(); cleanup();
  });
  it('打字、其他按鈕、快捷鍵與輸入法組字時，空白鍵維持原用途', () => {
    for (const properties of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { code: 'Enter' }])
      expect(canUseSpace(key('keydown', properties))).toBe(false);
    const event = key('keydown');
    Object.defineProperty(event, 'target', { value: { closest: (selector: string) => selector.includes('input') ? {} : null } });
    expect(canUseSpace(event)).toBe(false);
    const start = vi.fn(() => false), root = new EventTarget(); const cleanup = bindSpaceToTalk(root, new TalkHold(start, vi.fn()));
    const disabled = key('keydown'); root.dispatchEvent(disabled); expect(disabled.defaultPrevented).toBe(false); cleanup();
  });
  it('鍵盤與手指同時按住時，只在最後一個放開才結束，失焦及卸載不能卡住', () => {
    const start = vi.fn(() => true), end = vi.fn(), hold = new TalkHold(start, end), root = new EventTarget();
    const cleanup = bindSpaceToTalk(root, hold);
    root.dispatchEvent(key('keydown')); hold.press('pointer'); root.dispatchEvent(key('keyup'));
    expect(end).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledOnce();
    root.dispatchEvent(new Event('blur')); expect(end).toHaveBeenCalledOnce();
    hold.press('pointer'); cleanup(); expect(end).toHaveBeenCalledTimes(2); hold.release('pointer'); expect(end).toHaveBeenCalledTimes(2);
  });
});
