import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { Language, TalkState } from '../shared/protocol';
import { PushToTalkButton } from './PushToTalkButton';
import { FACE_TEXT, LANG_TAG, faceButtonState, faceLines, faceTurns, type FaceTurn } from './lib/face';
import type { Caption } from './lib/types';

interface Props {
  near: Language;
  far: Language;
  /** 對面那一半上下顛倒，讓坐在對面的人正著看。 */
  flip: boolean;
  captions: Caption[];
  listening: boolean;
  ended: boolean;
  failed: boolean;
  finishing: boolean;
  message: string;
  talkState: TalkState;
  speaker: Language | null;
  canSpeak: boolean;
  autoSpeak: boolean;
  fontScale: number;
  onPress: (language: Language) => boolean;
  onRelease: () => void;
  onSwap: () => void;
  onFlip: () => void;
  onAutoSpeak: (value: boolean) => void;
  onRestart: () => void;
  onClose: () => void;
}

function Side(props: Props & { language: Language; side: 'near' | 'far'; turns: FaceTurn[] }) {
  const { language, talkState, speaker } = props;
  const text = FACE_TEXT[language];
  const lines = faceLines(props.turns, language);
  const state = faceButtonState(props.listening, props.ended, talkState, speaker, language);
  const pane = useRef<HTMLDivElement>(null);
  const tail = lines.at(-1);
  useEffect(() => { if (pane.current) pane.current.scrollTop = pane.current.scrollHeight; }, [lines.length, tail?.text]);
  return <section className={`face-side face-${props.side}`} lang={LANG_TAG[language]}>
    <div className="face-lines" ref={pane} aria-live="polite">
      {!lines.length && <p className="face-hint">{text.hint}</p>}
      {lines.map(line => <p key={line.id} className={`face-line ${line.own ? 'own' : 'other'} ${line.final ? '' : 'draft'}`}>
        <small>{line.own ? text.own : text.other}{!line.final && !line.own ? ` · ${text.draft}` : ''}</small>{line.text}</p>)}
    </div>
    <PushToTalkButton keyboard={false} className={`face-talk face-${state}`} label={text.button[state]}
      disabled={state !== 'idle' && state !== 'speaking'} state={speaker === language ? talkState : 'idle'}
      onPress={() => props.onPress(language)} onRelease={props.onRelease} />
    <span className="face-name">{text.name}</span>
  </section>;
}

export function FaceToFace(props: Props) {
  const turns = useMemo(() => faceTurns(props.captions), [props.captions]);
  const busy = props.talkState === 'speaking' || props.talkState === 'tail';
  const summary = props.ended ? props.message
    : props.finishing ? '正在收尾…'
    : !props.listening ? '正在準備麥克風與連線…'
      : busy && props.speaker ? `${FACE_TEXT[props.speaker].name} 說話中`
        : props.talkState === 'finishing' ? '翻譯中…' : '可以開始對話：各自按住自己那一側的按鈕說話';
  // 對講畫面蓋住整頁時，底下的頁面不跟著捲動。
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  return <div className={`face ${props.flip ? 'face-flip' : ''}`} role="dialog" aria-modal="true" aria-label="面對面對講"
    style={{ '--caption-scale': props.fontScale } as CSSProperties}>
    <Side {...props} language={props.far} side="far" turns={turns} />
    <div className={`face-bar ${props.failed ? 'face-failed' : ''}`}>
      <span className="face-status" role="status"><i className={props.ended ? '' : busy ? 'live' : props.listening ? 'ready' : 'wait'} />{summary}</span>
      <div className="face-actions">
        {props.ended ? <button className="primary" onClick={props.onRestart}>重新開始</button> : <>
          <button onClick={props.onSwap} disabled={props.talkState !== 'idle' && props.listening} aria-label="兩側語言對調">⇅ 對調</button>
          <button onClick={props.onFlip} aria-pressed={props.flip} aria-label="對面那一半上下顛倒">⟳ 對面顛倒</button>
          {props.canSpeak && <button onClick={() => props.onAutoSpeak(!props.autoSpeak)} aria-pressed={props.autoSpeak}>朗讀譯文</button>}
        </>}
        <button className={props.ended ? '' : 'stop'} onClick={props.onClose}>{props.ended ? '返回' : '結束'}</button>
      </div>
    </div>
    <Side {...props} language={props.near} side="near" turns={turns} />
  </div>;
}
