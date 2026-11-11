import { LANGUAGE_PAIRS, type Direction, type Language, type LanguagePair, type TalkState } from '../../shared/protocol';
import { inlineText, joinSpeech } from './paragraphs';
import type { Caption } from './types';

// 面對面對講：一支手機放在兩人中間，兩側各有一顆按住說話的按鈕。
// 每一側只顯示該側語言的文字：對方的話顯示譯文，自己的話顯示辨識到的原文。

export const LANG_TAG: Record<Language, string> = { zh: 'zh-Hant-TW', ja: 'ja', en: 'en' };

/** 兩側的語言：near 是手機主人這一側，far 是對面。儲存的語言不在配對內時用配對的第一種。 */
export function faceLanguages(pair: LanguagePair, near?: Language): { near: Language; far: Language } {
  const [first, second] = LANGUAGE_PAIRS[pair].languages;
  return near === second ? { near: second, far: first } : { near: first, far: second };
}

export interface FaceTurn {
  id: string;
  direction: Direction;
  original: string;
  translation: string;
  originalFinal: boolean;
  translationFinal: boolean;
}

/** 一次按住說話是一輪；較長的一句會被拆成數則字幕，這裡依說話輪次合併回來。 */
export function faceTurns(captions: Caption[]): FaceTurn[] {
  const turns: FaceTurn[] = [];
  let key = '';
  for (const caption of captions) {
    if (caption.gap || caption.origin === 'precision') continue;
    const next = `${caption.id.replace(/-c\d+$/u, '')}|${caption.direction}`;
    let turn = turns.at(-1);
    if (!turn || next !== key) {
      key = next;
      turn = { id: caption.id, direction: caption.direction, original: '', translation: '', originalFinal: true, translationFinal: true };
      turns.push(turn);
    }
    turn.original = joinSpeech(turn.original, caption.original);
    turn.translation = joinSpeech(turn.translation, caption.translation);
    turn.originalFinal &&= caption.originalFinal;
    turn.translationFinal &&= caption.translationFinal;
  }
  return turns;
}

export interface FaceLine { id: string; own: boolean; text: string; final: boolean }

/** 某一側看到的內容：自己說的顯示原文，對方說的顯示譯文；還沒有文字的那一輪先不顯示。 */
export function faceLines(turns: FaceTurn[], language: Language): FaceLine[] {
  return turns.map(turn => {
    const own = turn.direction.slice(0, 2) === language;
    return { id: turn.id, own, text: inlineText(own ? turn.original : turn.translation),
      final: own ? turn.originalFinal : turn.translationFinal };
  }).filter(line => line.text);
}

export type FaceButtonState = 'preparing' | 'idle' | 'speaking' | 'finishing' | 'waiting' | 'ended';

/** 一側按鈕的狀態：同一時間只有一個人能說話，另一側顯示等待。 */
export function faceButtonState(listening: boolean, ended: boolean, talk: TalkState, speaker: Language | null, language: Language): FaceButtonState {
  if (ended || talk === 'closed') return 'ended';
  if (!listening) return 'preparing';
  if (talk === 'idle') return 'idle';
  if (speaker !== language) return 'waiting';
  return talk === 'finishing' ? 'finishing' : 'speaking';
}

interface FaceText {
  name: string;
  button: Record<FaceButtonState, string>;
  hint: string;
  own: string;
  other: string;
  draft: string;
}

// 每一側的介面文字用該側的語言，對方不必看得懂中文也能操作。
export const FACE_TEXT: Record<Language, FaceText> = {
  zh: {
    name: '繁體中文',
    button: { preparing: '準備中…', idle: '按住說話', speaking: '正在聽，放開結束', finishing: '翻譯中…', waiting: '對方說話中…', ended: '已結束' },
    hint: '按住下方按鈕說話，放開後對方會看到翻譯。',
    own: '你說', other: '對方', draft: '翻譯中',
  },
  ja: {
    name: '日本語',
    button: { preparing: '準備中…', idle: '押しながら話す', speaking: '聞いています。離すと終了', finishing: '翻訳中…', waiting: '相手が話しています…', ended: '終了しました' },
    hint: '下のボタンを押しながら話してください。離すと相手に翻訳が表示されます。',
    own: 'あなた', other: '相手', draft: '翻訳中',
  },
  en: {
    name: 'English',
    button: { preparing: 'Getting ready…', idle: 'Hold to talk', speaking: 'Listening. Release to finish', finishing: 'Translating…', waiting: 'The other person is speaking…', ended: 'Ended' },
    hint: 'Hold the button below and speak. Release to show the translation to the other person.',
    own: 'You', other: 'Them', draft: 'Translating',
  },
};
