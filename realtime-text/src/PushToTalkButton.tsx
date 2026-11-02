import { useEffect, useRef } from 'react';
import type { TalkState } from '../shared/protocol';
import { TalkHold, bindSpaceToTalk } from './lib/talk-hold';

export function PushToTalkButton(props: { disabled: boolean; state: TalkState; onPress: () => boolean; onRelease: () => void }) {
  const current = useRef(props); current.current = props;
  const hold = useRef<TalkHold | null>(null);
  if (!hold.current) hold.current = new TalkHold(() => !current.current.disabled && current.current.onPress(), () => current.current.onRelease());
  const pointerId = useRef<number | null>(null);
  useEffect(() => {
    const unbind = bindSpaceToTalk(window, hold.current!);
    const hidden = () => { if (document.hidden) hold.current?.releaseAll(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { unbind(); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => { if (props.disabled) hold.current?.releaseAll(); }, [props.disabled]);
  const releasePointer = (id?: number) => {
    if (id !== undefined && pointerId.current !== id) return;
    pointerId.current = null; hold.current?.release('pointer');
  };
  return <button type="button" data-push-to-talk className={`talk-button talk-${props.state}`}
    aria-label="按住說話（空白鍵）" aria-keyshortcuts="Space" aria-pressed={props.state === 'speaking'} disabled={props.disabled}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || !hold.current?.press('pointer')) return;
      event.preventDefault(); pointerId.current = event.pointerId;
      event.currentTarget.focus({ preventScroll: true });
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* cancelled gesture */ }
    }}
    onPointerMove={event => {
      if (pointerId.current !== event.pointerId) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) {
        releasePointer();
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      }
    }}
    onPointerUp={event => releasePointer(event.pointerId)} onPointerCancel={event => releasePointer(event.pointerId)}
    onLostPointerCapture={event => releasePointer(event.pointerId)}
    onContextMenu={event => event.preventDefault()} onClick={event => event.preventDefault()}>
    {props.state === 'speaking' ? '● 正在收音翻譯 · 放開結束' : props.state === 'tail' ? '收完尾音中 · 可按住接續'
      : props.state === 'finishing' ? '正在完成這句…' : '按住說話 · 空白鍵 / 長按'}
  </button>;
}
