// 朗讀譯文使用瀏覽器內建的語音合成：不呼叫 Gemini、不產生費用，聲音由裝置決定。
const VOICE_LANG: Record<string, string> = { 'zh-Hant-TW': 'zh-TW', ja: 'ja-JP', en: 'en-US' };

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

export function voiceLang(lang: string): string { return VOICE_LANG[lang] ?? lang; }

export function stopSpeaking() {
  if (speechSupported()) window.speechSynthesis.cancel();
}

/** 唸出一段文字；新的朗讀會取代正在唸的內容。回傳是否已送出。 */
export function speak(text: string, lang: string, onEnd?: () => void): boolean {
  const content = text.replace(/\s+/gu, ' ').trim();
  if (!content || !speechSupported()) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(content);
  utterance.lang = voiceLang(lang);
  // 優先使用與語言完全相符的裝置語音；沒有時交給瀏覽器依 lang 選擇。
  const prefix = utterance.lang.toLowerCase();
  const voice = synth.getVoices().find(item => item.lang.toLowerCase().replace('_', '-') === prefix)
    ?? synth.getVoices().find(item => item.lang.toLowerCase().startsWith(prefix.split('-')[0]));
  if (voice) utterance.voice = voice;
  if (onEnd) { utterance.onend = onEnd; utterance.onerror = onEnd; }
  synth.speak(utterance);
  return true;
}
