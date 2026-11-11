import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCaptions, HISTORY_STORAGE_KEY, loadCaptions, saveCaptions } from '../src/lib/history-store';
import { pairPreference, qualityPreference, pacePreference, themePreference, audioSourcePreference, showOriginalPreference,
  autoResumePreference, autoSpeakPreference, loadBudget, saveBudget, loadFontScale, saveFontScale, clampFontScale } from '../src/lib/preferences';
import { resumeOnReturn, RESUME_WINDOW_MS } from '../src/lib/page-visibility';
import { speak, speechSupported, stopSpeaking, unlockSpeech, voiceLang, SPEAK_AFTER_CANCEL_MS, SPEAK_START_TIMEOUT_MS } from '../src/lib/speech';
import type { Caption } from '../src/lib/types';

afterEach(() => vi.unstubAllGlobals());
const memory = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); } };
};
const caption = (id: string, extra: Partial<Caption> = {}): Caption => ({ id, sessionId: 's', direction: 'ja-zh', receivedAt: 1,
  paragraphId: id, revision: 1, original: '来週、青森に行きます。', translation: '下週要去青森。', translationRevision: 1,
  originalFinal: true, translationFinal: true, origin: 'precision', ...extra });

describe('翻譯紀錄自動保存', () => {
  it('存入後可完整還原，包含校正標示與未翻譯缺口', () => {
    const storage = memory();
    const items = [caption('a', { previousTranslation: '下週去青森', revisedAt: 5, corrected: true }),
      caption('g', { original: '', translation: '', gap: { startSeconds: 20, endSeconds: 32, message: '網路中斷' } })];
    expect(saveCaptions(items, storage)).toBe(true);
    const restored = loadCaptions(storage);
    expect(restored.captions).toEqual(items); expect(restored.savedAt).toBeGreaterThan(0);
  });
  it('沒有內容時移除保存的資料；清除紀錄也會刪除', () => {
    const storage = memory(); saveCaptions([caption('a')], storage);
    expect(storage.data.has(HISTORY_STORAGE_KEY)).toBe(true);
    saveCaptions([], storage); expect(storage.data.has(HISTORY_STORAGE_KEY)).toBe(false);
    saveCaptions([caption('a')], storage); expect(clearCaptions(storage)).toBe(true);
    expect(loadCaptions(storage)).toEqual({ captions: [], savedAt: 0 });
  });
  it('損壞、格式不符或重複的資料不會讓頁面壞掉，只留下有效的句子', () => {
    const storage = memory();
    for (const raw of ['not json', '{"captions":"nope"}', 'null', '[]']) {
      storage.setItem(HISTORY_STORAGE_KEY, raw); expect(loadCaptions(storage).captions).toEqual([]);
    }
    storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ savedAt: 'x', captions: [caption('ok'), caption('ok'),
      { ...caption('bad-direction'), direction: 'zh-fr' }, { ...caption('bad-text'), translation: 5 },
      { ...caption('bad-gap'), gap: { startSeconds: 'a' } }, null, 'text'] }));
    expect(loadCaptions(storage)).toEqual({ captions: [caption('ok')], savedAt: 0 });
  });
  it('超過數量或容量上限時保留最近的內容；儲存失敗回報 false 而不拋錯', () => {
    const storage = memory();
    saveCaptions(Array.from({ length: 450 }, (_, i) => caption(`c${i}`)), storage);
    const kept = loadCaptions(storage).captions;
    expect(kept).toHaveLength(400); expect(kept[0].id).toBe('c50'); expect(kept.at(-1)!.id).toBe('c449');
    saveCaptions(Array.from({ length: 300 }, (_, i) => caption(`big${i}`, { translation: '長'.repeat(3000) })), storage);
    expect(storage.data.get(HISTORY_STORAGE_KEY)!.length).toBeLessThanOrEqual(400_000);
    expect(loadCaptions(storage).captions.at(-1)!.id).toBe('big299');
    expect(saveCaptions([caption('a')], { ...storage, setItem: () => { throw new Error('quota'); } })).toBe(false);
    expect(loadCaptions({ ...storage, getItem: () => { throw new Error('blocked'); } }).captions).toEqual([]);
  });
});

describe('記住介面選擇', () => {
  it('語言配對、品質、速度、外觀與音訊來源會記住，不認得的值回到預設', () => {
    const storage = memory();
    expect([pairPreference.load(storage), qualityPreference.load(storage), pacePreference.load(storage), themePreference.load(storage), audioSourcePreference.load(storage)])
      .toEqual(['zh-ja', 'economy', 'standard', 'auto', 'microphone']);
    pairPreference.save('ja-en', storage); qualityPreference.save('quality', storage); pacePreference.save('fast', storage);
    themePreference.save('light', storage); audioSourcePreference.save('display', storage);
    expect([pairPreference.load(storage), qualityPreference.load(storage), pacePreference.load(storage), themePreference.load(storage), audioSourcePreference.load(storage)])
      .toEqual(['ja-en', 'quality', 'fast', 'light', 'display']);
    for (const key of [...storage.data.keys()]) storage.setItem(key, 'bogus');
    expect([pairPreference.load(storage), qualityPreference.load(storage), pacePreference.load(storage), themePreference.load(storage)])
      .toEqual(['zh-ja', 'economy', 'standard', 'auto']);
    pairPreference.save('zh-ja', storage); expect(storage.data.has('realtime-translator.pair.v1')).toBe(false);
  });
  it('開關、預算與字級會記住；字級限制在可讀範圍', () => {
    const storage = memory();
    expect([showOriginalPreference.load(storage), autoResumePreference.load(storage), autoSpeakPreference.load(storage)]).toEqual([true, true, false]);
    showOriginalPreference.save(false, storage); autoResumePreference.save(false, storage); autoSpeakPreference.save(true, storage);
    expect([showOriginalPreference.load(storage), autoResumePreference.load(storage), autoSpeakPreference.load(storage)]).toEqual([false, false, true]);
    saveBudget(' 50 ', storage); expect(loadBudget(storage)).toBe('50'); saveBudget('', storage); expect(loadBudget(storage)).toBe('');
    expect(loadFontScale(storage)).toBe(1); saveFontScale(1.3, storage); expect(loadFontScale(storage)).toBe(1.3);
    expect([clampFontScale(9), clampFontScale(.1), clampFontScale(Number.NaN), clampFontScale(1.15)]).toEqual([1.8, .85, 1, 1.15]);
    storage.setItem('realtime-translator.font-scale.v1', 'huge'); expect(loadFontScale(storage)).toBe(1);
  });
  it('只在離開背景不久後自動繼續，沒有被背景中斷或離開太久都不重開麥克風', () => {
    expect(resumeOnReturn(undefined, 1000)).toBe(false);
    expect(resumeOnReturn(1000, 1000 + RESUME_WINDOW_MS)).toBe(true);
    expect(resumeOnReturn(1000, 1001 + RESUME_WINDOW_MS)).toBe(false);
    expect(resumeOnReturn(5000, 1000)).toBe(false);
  });
});

describe('朗讀譯文', () => {
  it('不支援語音合成的環境安靜略過', () => {
    expect(speechSupported()).toBe(false); expect(speak('你好', 'zh-Hant-TW')).toBe(false); expect(() => stopSpeaking()).not.toThrow();
  });
  class Utterance { lang = ''; volume = 1; voice?: { lang: string }; onstart?: () => void; onend?: () => void; onerror?: (event?: { error?: string }) => void; constructor(public text: string) {} }
  function fakeSynth(play: (item: Utterance) => void = item => item.onend?.()) {
    const spoken: Utterance[] = [];
    const synth = { speaking: false, pending: false, cancel: vi.fn(), speak: vi.fn((item: Utterance) => { spoken.push(item); play(item); }),
      getVoices: () => [{ lang: 'en-US' }, { lang: 'ja_JP' }, { lang: 'zh-TW' }] };
    vi.stubGlobal('window', { speechSynthesis: synth }); vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    return { synth, spoken };
  }
  it('只指定目標語言、語音交給裝置挑選，空白文字不朗讀；沒有在唸時不呼叫 cancel', () => {
    const { synth, spoken } = fakeSynth();
    expect(speechSupported()).toBe(true);
    const done = vi.fn();
    expect(speak('  来週、\n青森に行きます。 ', 'ja', done)).toBe(true);
    expect(spoken[0]).toMatchObject({ text: '来週、 青森に行きます。', lang: 'ja-JP' }); expect(spoken[0].voice).toBeUndefined();
    expect(done).toHaveBeenCalledOnce(); expect(done).toHaveBeenCalledWith(undefined);
    expect(speak('下週要去青森。', 'zh-Hant-TW')).toBe(true); expect(spoken[1]).toMatchObject({ lang: 'zh-TW' });
    expect(speak('   ', 'en')).toBe(false); expect(synth.speak).toHaveBeenCalledTimes(2);
    stopSpeaking(); expect(synth.cancel).not.toHaveBeenCalled();
    expect([voiceLang('en'), voiceLang('ja'), voiceLang('fr-FR')]).toEqual(['en-US', 'ja-JP', 'fr-FR']);
  });
  it('裝置沒有回應時 5 秒後回報「沒有開始」；有開始就不算，瀏覽器回報的錯誤照實回報', () => {
    vi.useFakeTimers();
    try {
      const silent = fakeSynth(() => {});
      const stuck = vi.fn();
      speak('沒有回應', 'zh-Hant-TW', stuck);
      vi.advanceTimersByTime(SPEAK_START_TIMEOUT_MS - 1); expect(stuck).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); expect(stuck).toHaveBeenCalledExactlyOnceWith('not-started');
      silent.spoken[0].onend?.(); expect(stuck).toHaveBeenCalledOnce();

      const started = fakeSynth(item => item.onstart?.());
      const long = vi.fn();
      speak('很長的一段話', 'zh-Hant-TW', long);
      vi.advanceTimersByTime(SPEAK_START_TIMEOUT_MS * 4); expect(long).not.toHaveBeenCalled();
      started.spoken[0].onend?.(); expect(long).toHaveBeenCalledExactlyOnceWith(undefined);

      fakeSynth(item => item.onerror?.({ error: 'synthesis-failed' }));
      const failed = vi.fn(); speak('失敗', 'ja', failed); expect(failed).toHaveBeenCalledExactlyOnceWith('synthesis-failed');
      fakeSynth(item => item.onerror?.({ error: 'canceled' }));
      const cancelled = vi.fn(); speak('被取消', 'ja', cancelled); expect(cancelled).toHaveBeenCalledExactlyOnceWith(undefined);
      vi.advanceTimersByTime(SPEAK_START_TIMEOUT_MS * 2); expect(cancelled).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('正在唸時先取消、稍候才唸新的內容；等待期間按停止就不會再唸', () => {
    vi.useFakeTimers();
    try {
      const { synth, spoken } = fakeSynth(() => {});
      synth.speaking = true;
      expect(speak('first', 'en')).toBe(true);
      expect(synth.cancel).toHaveBeenCalledOnce(); expect(synth.speak).not.toHaveBeenCalled();
      vi.advanceTimersByTime(SPEAK_AFTER_CANCEL_MS); expect(spoken.map(item => item.text)).toEqual(['first']);
      speak('second', 'en'); speak('third', 'en');
      vi.advanceTimersByTime(SPEAK_AFTER_CANCEL_MS); expect(spoken.map(item => item.text)).toEqual(['first', 'third']);
      speak('fourth', 'en'); stopSpeaking();
      vi.advanceTimersByTime(SPEAK_AFTER_CANCEL_MS * 3); expect(synth.speak).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('解鎖語音：點按時送出無聲語音，瀏覽器接受之前每次點按都重試，接受後不再送', () => {
    let accept = false;
    const { synth, spoken } = fakeSynth(item => { if (accept) item.onstart?.(); });
    unlockSpeech(); unlockSpeech();
    expect(synth.speak).toHaveBeenCalledTimes(2); expect(spoken[0]).toMatchObject({ text: '', volume: 0 });
    synth.speaking = true; unlockSpeech(); expect(synth.speak).toHaveBeenCalledTimes(2);
    synth.speaking = false; accept = true; unlockSpeech(); expect(synth.speak).toHaveBeenCalledTimes(3);
    unlockSpeech(); expect(synth.speak).toHaveBeenCalledTimes(3);
  });
});
