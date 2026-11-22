// 按下到放開短於這個時間算「按一下」：放開後繼續收音，再按一下才結束。
// 比這個久就是「按住說話」：放開就結束。
export const TAP_MS = 400;

/**
 * 說話鍵的兩種用法共用同一顆按鈕（或空白鍵）：
 * - 按住：按下開始，放開結束（對講機）。
 * - 按一下：按下開始，很快放開後維持收音（鎖定），再按一下結束。
 * 鍵盤與手指可以同時按住，最後一個放開才算放開。
 */
export class TalkHold {
  private sources = new Set<string>();
  // 這次按下是用來結束鎖定的，它的放開不代表任何事。
  private spent = new Set<string>();
  private locked = false;
  private startedAt = 0;
  constructor(private start: () => boolean, private end: () => void,
    private now: () => number = Date.now, private onLatch: (latched: boolean) => void = () => {}) {}

  has(source: string) { return this.sources.has(source) || this.spent.has(source); }
  get latched() { return this.locked; }
  private latch(value: boolean) { if (this.locked !== value) { this.locked = value; this.onLatch(value); } }

  press(source: string) {
    if (this.has(source)) return true;
    if (this.locked) {
      this.spent.add(source); this.latch(false); this.end(); return true;
    }
    if (!this.sources.size) {
      if (!this.start()) return false;
      this.startedAt = this.now();
    }
    this.sources.add(source); return true;
  }

  release(source: string) {
    if (this.spent.delete(source)) return;
    if (!this.sources.delete(source) || this.sources.size) return;
    if (this.now() - this.startedAt < TAP_MS) this.latch(true);
    else this.end();
  }

  /** 手指滑出按鈕或被系統取消：直接結束，不當成「按一下」。 */
  cancel(source: string) {
    if (this.spent.delete(source)) return;
    if (this.sources.delete(source) && !this.sources.size) this.end();
  }

  /** 視窗失焦：正按著的鍵收不到放開事件，先結束；已鎖定的收音不受影響。 */
  releaseHeld() {
    this.spent.clear();
    if (!this.sources.size) return;
    this.sources.clear(); this.end();
  }

  /** 按鈕停用、頁面切到背景或卸載：連鎖定中的收音一起結束。 */
  releaseAll() {
    const active = this.sources.size > 0 || this.locked;
    this.sources.clear(); this.spent.clear(); this.latch(false);
    if (active) this.end();
  }

  /** 這一句已經由別處結束（例如場次停止）：只清掉狀態，不再呼叫結束。 */
  reset() { this.sources.clear(); this.spent.clear(); this.latch(false); }
}

export function canUseSpace(event: KeyboardEvent) {
  if (event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return false;
  const element = event.target as Element | null;
  if (element?.closest?.('[data-push-to-talk]')) return true;
  return !element?.closest?.('input,textarea,select,button,a,summary,[role="textbox"],[contenteditable]:not([contenteditable="false"])');
}

export function bindSpaceToTalk(target: EventTarget, hold: TalkHold) {
  const down = (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (!canUseSpace(event)) return;
    if (hold.has('keyboard')) { event.preventDefault(); return; }
    if (!event.repeat && hold.press('keyboard')) event.preventDefault();
  };
  const up = (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (event.code === 'Space' && hold.has('keyboard')) { event.preventDefault(); hold.release('keyboard'); }
  };
  const blur = () => hold.releaseHeld();
  target.addEventListener('keydown', down); target.addEventListener('keyup', up); target.addEventListener('blur', blur);
  return () => {
    target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); target.removeEventListener('blur', blur);
    hold.releaseAll();
  };
}
