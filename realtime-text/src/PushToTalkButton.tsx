import { useEffect, useRef } from 'react';
import type { TalkState } from '../shared/protocol';
import { TalkHold, bindSpaceToTalk } from './lib/talk-hold';

interface Props {
  disabled: boolean;
  state: TalkState;
  onPress: () => boolean;
  onRelease: () => void;
  /** 面對面對講有兩顆按鈕：不綁空白鍵，文字由各側的語言決定。 */
  keyboard?: boolean;
  label?: string;
  className?: string;
}

export function PushToTalkButton(props: Props) {
  const keyboard = props.keyboard ?? true;
  const current = useRef(props); current.current = props;
  const hold = useRef<TalkHold | null>(null);
  if (!hold.current) hold.current = new TalkHold(() => !current.current.disabled && current.current.onPress(), () => current.current.onRelease());
  const pointerId = useRef<number | null>(null);
  useEffect(() => {
    const unbind = keyboard ? bindSpaceToTalk(window, hold.current!) : () => hold.current?.releaseAll();
    const hidden = () => { if (document.hidden) hold.current?.releaseAll(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { unbind(); document.removeEventListener('visibilitychange', hidden); };
  }, [keyboard]);
  useEffect(() => { if (props.disabled) hold.current?.releaseAll(); }, [props.disabled]);
  const releasePointer = (id?: number) => {
    if (id !== undefined && pointerId.current !== id) return;
    pointerId.current = null; hold.current?.release('pointer');
  };
  return <button type="button" data-push-to-talk className={`talk-button talk-${props.state} ${props.className ?? ''}`}
    aria-label={props.label ?? '按住說話（空白鍵）'} aria-keyshortcuts={keyboard ? 'Space' : undefined}
    aria-pressed={props.state === 'speaking'} disabled={props.disabled}
    onPointerDown={event => {
      // 兩人共用一支手機時，另一人的手指可能還放在螢幕上：對講按鈕不要求是第一根手指。
      if ((keyboard && !event.isPrimary) || event.button !== 0 || pointerId.current !== null || !hold.current?.press('pointer')) return;
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
    {props.label ?? (props.state === 'speaking' ? '● 正在收音翻譯 · 放開結束' : props.state === 'tail' ? '收完尾音中 · 可按住接續'
      : props.state === 'finishing' ? '正在完成這句…' : '按住說話 · 空白鍵 / 長按')}
  </button>;
}
