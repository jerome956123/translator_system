/** Combine keyboard and pointer holds; one released input cannot end another held input. */
export class TalkHold {
  private sources = new Set<string>();
  constructor(private start: () => boolean, private end: () => void) {}
  has(source: string) { return this.sources.has(source); }
  press(source: string) {
    if (this.sources.has(source)) return true;
    if (!this.sources.size && !this.start()) return false;
    this.sources.add(source); return true;
  }
  release(source: string) {
    if (this.sources.delete(source) && !this.sources.size) this.end();
  }
  releaseAll() {
    if (!this.sources.size) return;
    this.sources.clear(); this.end();
  }
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
  const blur = () => hold.releaseAll();
  target.addEventListener('keydown', down); target.addEventListener('keyup', up); target.addEventListener('blur', blur);
  return () => {
    target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); target.removeEventListener('blur', blur);
    hold.releaseAll();
  };
}
