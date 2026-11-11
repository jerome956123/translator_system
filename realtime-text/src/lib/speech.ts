// 朗讀譯文使用瀏覽器內建的語音合成：不呼叫 Gemini、不產生費用，聲音由裝置決定。
const VOICE_LANG: Record<string, string> = { 'zh-Hant-TW': 'zh-TW', ja: 'ja-JP', en: 'en-US' };
// 取消正在唸的內容後，隔這麼久再開始下一段；部分手機瀏覽器會吞掉緊接在 cancel 之後的朗讀。
export const SPEAK_AFTER_CANCEL_MS = 120;
// 送出後這麼久都沒有開始也沒有結束，就當作裝置沒有接受這次朗讀，不讓畫面一直停在「朗讀中」。
export const SPEAK_START_TIMEOUT_MS = 5000;

/** 朗讀沒有正常唸完的原因：not-started 是裝置沒有回應，其餘是瀏覽器回報的錯誤代碼。正常結束或被我們自己取消時沒有原因。 */
export type SpeakProblem = string | undefined;

let unlocked = false;
let waiting: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
// 留住正在唸的那一段，避免瀏覽器在唸完前把它回收而不觸發結束事件。
let current: SpeechSynthesisUtterance | undefined;

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

export function voiceLang(lang: string): string { return VOICE_LANG[lang] ?? lang; }

/** iPhone／iPad：朗讀的聲音受靜音模式影響，畫面需要另外提醒。 */
export function appleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/u.test(navigator.userAgent ?? '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

const busy = (synth: SpeechSynthesis) => Boolean(synth.speaking || synth.pending);

// 支援 Audio Session API 的 Safari：沒有在收音時改用媒體播放類型，讓聲音不被 iPhone 的靜音開關關掉。
// 收音中由收音程式設為錄音類型，這裡不去動它。是否對語音合成有效因系統版本而異，失敗就維持原狀。
function preferPlayback() {
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session && session.type === 'auto') session.type = 'playback';
  } catch { /* 沒有可寫入的 Audio Session API。 */ }
}

export function stopSpeaking() {
  clearTimeout(waiting); waiting = undefined;
  clearTimeout(watchdog); watchdog = undefined;
  if (!speechSupported()) return;
  // 沒有在唸就不呼叫 cancel，避免影響下一次朗讀。
  if (busy(window.speechSynthesis)) window.speechSynthesis.cancel();
}

/**
 * 手機瀏覽器（尤其是 iPhone）只允許在使用者點按的當下開始第一次語音，之後程式才能自己朗讀。
 * 自動朗讀是翻譯回來後才觸發，不在點按當下，所以要在按開始、勾選朗讀、放開說話鍵這些點按裡先送出一段無聲的語音。
 * 確認瀏覽器接受之前，每次點按都會再試一次。
 */
export function unlockSpeech() {
  if (unlocked || !speechSupported()) return;
  const synth = window.speechSynthesis;
  if (busy(synth)) return;
  const primer = new SpeechSynthesisUtterance('');
  primer.volume = 0;
  primer.onstart = primer.onend = () => { unlocked = true; };
  synth.speak(primer);
}

/** 唸出一段文字；新的朗讀會取代正在唸的內容。回傳是否已送出；onEnd 在唸完、被取代或失敗時呼叫一次。 */
export function speak(text: string, lang: string, onEnd?: (problem?: SpeakProblem) => void): boolean {
  const content = text.replace(/\s+/gu, ' ').trim();
  if (!content || !speechSupported()) return false;
  const synth = window.speechSynthesis;
  clearTimeout(waiting); waiting = undefined;
  clearTimeout(watchdog); watchdog = undefined;
  const utterance = new SpeechSynthesisUtterance(content);
  // 只指定語言，由裝置挑選該語言的預設語音；自行從清單挑語音在 Apple 裝置上會挑到趣味語音或尚未下載的語音。
  utterance.lang = voiceLang(lang);
  let settled = false;
  const finished = (problem?: SpeakProblem) => {
    if (settled) return;
    settled = true;
    if (current === utterance) { current = undefined; clearTimeout(watchdog); watchdog = undefined; }
    onEnd?.(problem);
  };
  let started = false;
  utterance.onstart = () => { started = true; };
  utterance.onend = () => finished();
  utterance.onerror = event => {
    const code = (event as SpeechSynthesisErrorEvent | undefined)?.error;
    // 被我們自己的停止或下一段朗讀打斷不算失敗。
    finished(!code || code === 'canceled' || code === 'interrupted' ? undefined : code);
  };
  const begin = () => {
    waiting = undefined; current = utterance;
    preferPlayback();
    synth.speak(utterance);
    if (settled) return;
    watchdog = setTimeout(() => {
      watchdog = undefined;
      if (started || settled || current !== utterance) return;
      if (busy(synth)) synth.cancel();
      finished('not-started');
    }, SPEAK_START_TIMEOUT_MS);
  };
  if (busy(synth)) { synth.cancel(); waiting = setTimeout(begin, SPEAK_AFTER_CANCEL_MS); }
  else begin();
  return true;
}
