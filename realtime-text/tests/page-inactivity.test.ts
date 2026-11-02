import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_IDLE_MS, watchPageInactivity } from '../src/lib/page-inactivity';
afterEach(() => vi.useRealTimers());
function harness(acceptInput = () => true) {
  vi.useFakeTimers(); const page = new EventTarget(), lifecycle = new EventTarget(), idle = vi.fn();
  const cleanup = watchPageInactivity(page, idle, lifecycle, acceptInput);
  return { page, lifecycle, idle, cleanup };
}
describe('自動收音的本頁閒置期限', () => {
  it('未滿一小時不暫停，到期只觸發一次', async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(PAGE_IDLE_MS - 1); expect(h.idle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(h.idle).toHaveBeenCalledOnce();
    h.page.dispatchEvent(new Event('mousemove')); await vi.advanceTimersByTimeAsync(PAGE_IDLE_MS); expect(h.idle).toHaveBeenCalledOnce();
  });
  it('本頁滑鼠、鍵盤、觸控或滾輪會重新計時', async () => {
    const h = harness();
    for (const type of ['mousemove', 'pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'touchmove']) {
      await vi.advanceTimersByTimeAsync(PAGE_IDLE_MS / 2); h.page.dispatchEvent(new Event(type));
      await vi.advanceTimersByTimeAsync(1); expect(h.idle).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(PAGE_IDLE_MS); expect(h.idle).toHaveBeenCalledOnce();
  });
  it('字幕自動捲動、音訊更新與其他視窗滑鼠活動不延長期限', async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(PAGE_IDLE_MS - 1);
    for (const type of ['scroll', 'audio-level', 'mousemove']) (type === 'mousemove' ? h.lifecycle : h.page).dispatchEvent(new Event(type));
    await vi.advanceTimersByTimeAsync(1); expect(h.idle).toHaveBeenCalledOnce();
  });
  it('背景計時延誤，返回或第一個滑鼠事件仍會先處理已到期暫停', () => {
    for (const resume of ['visibilitychange', 'focus', 'pageshow', 'mousemove']) {
      const h = harness(); vi.setSystemTime(Date.now() + PAGE_IDLE_MS + 1);
      (resume === 'focus' || resume === 'pageshow' ? h.lifecycle : h.page).dispatchEvent(new Event(resume));
      expect(h.idle).toHaveBeenCalledOnce(); h.cleanup();
    }
  });
  it('合成活動不計入，停止／卸載清理後不會再觸發舊期限', async () => {
    const h = harness(() => false); await vi.advanceTimersByTimeAsync(PAGE_IDLE_MS - 1);
    h.page.dispatchEvent(new Event('mousemove')); await vi.advanceTimersByTimeAsync(1); expect(h.idle).toHaveBeenCalledOnce();
    const stopped = harness(); stopped.cleanup(); stopped.page.dispatchEvent(new Event('mousemove'));
    await vi.advanceTimersByTimeAsync(PAGE_IDLE_MS * 2); expect(stopped.idle).not.toHaveBeenCalled();
  });
});
