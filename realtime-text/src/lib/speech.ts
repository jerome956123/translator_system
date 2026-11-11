// 朗讀譯文使用瀏覽器內建的語音合成：不呼叫 Gemini、不產生費用，聲音由裝置決定。
const VOICE_LANG: Record<string, string> = { 'zh-Hant-TW': 'zh-TW', ja: 'ja-JP', en: 'en-US' };
// 取消正在唸的內容後，隔這麼久再開始下一段；部分手機瀏覽器會吞掉緊接在 cancel 之後的朗讀。
export const SPEAK_AFTER_CANCEL_MS = 120;

let unlocked = false;
let waiting: ReturnType<typeof setTimeout> | undefined;
// 留住正在唸的那一段，避免瀏覽器在唸完前把它回收而不觸發結束事件。
let current: SpeechSynthesisUtterance | undefined;

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

export function voiceLang(lang: string): string { return VOICE_LANG[lang] ?? lang; }

const busy = (synth: SpeechSynthesis) => Boolean(synth.speaking || synth.pending);

export function stopSpeaking() {
  clearTimeout(waiting); waiting = undefined;
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

/** 唸出一段文字；新的朗讀會取代正在唸的內容。回傳是否已送出。 */
export function speak(text: string, lang: string, onEnd?: () => void): boolean {
  const content = text.replace(/\s+/gu, ' ').trim();
  if (!content || !speechSupported()) return false;
  const synth = window.speechSynthesis;
  clearTimeout(waiting); waiting = undefined;
  const utterance = new SpeechSynthesisUtterance(content);
  utterance.lang = voiceLang(lang);
  // 優先使用與語言完全相符的裝置語音；沒有時交給瀏覽器依 lang 選擇。
  const prefix = utterance.lang.toLowerCase();
  const voice = synth.getVoices().find(item => item.lang.toLowerCase().replace('_', '-') === prefix)
    ?? synth.getVoices().find(item => item.lang.toLowerCase().startsWith(prefix.split('-')[0]));
  if (voice) utterance.voice = voice;
  const finished = () => { if (current === utterance) current = undefined; onEnd?.(); };
  utterance.onend = finished; utterance.onerror = finished;
  const begin = () => { waiting = undefined; current = utterance; synth.speak(utterance); };
  if (busy(synth)) { synth.cancel(); waiting = setTimeout(begin, SPEAK_AFTER_CANCEL_MS); }
  else begin();
  return true;
}
