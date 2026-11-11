import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTranslationSession } from '../src/lib/session';
import type { Direction, ServerMessage } from '../shared/protocol';
import { FACE_TEXT, faceButtonState, faceLanguages, faceLines, faceTurns } from '../src/lib/face';
import { faceFlipPreference, faceNearPreference, faceSpeakPreference, loadTranslationMode, saveTranslationMode } from '../src/lib/preferences';
import type { Caption } from '../src/lib/types';

function harness() {
  const events: ServerMessage[] = [];
  let audio!: (data: ArrayBuffer) => void;
  let callbacks!: { onInterim: (text: string, languageCode?: string) => void; onFinal: (text: string, languageCode?: string) => void; onTurnComplete?: () => void };
  const capture = { prepare: vi.fn(async () => {}), start: vi.fn(async (next: typeof audio) => { audio = next; }), stop: vi.fn(async () => {}) };
  const stt = { connect: vi.fn(async () => {}), sendAudio: vi.fn(() => true), startActivity: vi.fn(() => true), endActivity: vi.fn(() => true), endAudio: vi.fn(), close: vi.fn() };
  const translate = vi.fn(async options => { options.onChunk('訳文'); return { text: '訳文' }; });
  const session = new BrowserTranslationSession({ apiKey: 'fake-key', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving', listeningMode: 'push-to-talk' },
    event => events.push(event), { capture, createSTT: next => { callbacks = next; return stt; }, translate });
  return { session, events, stt, translate, get callbacks() { return callbacks; }, audio: (data: ArrayBuffer) => audio(data) };
}
afterEach(() => vi.useRealTimers());

const caption = (id: string, direction: Direction, original: string, translation: string, extra: Partial<Caption> = {}): Caption => ({
  id, sessionId: 's', direction, receivedAt: 1, paragraphId: 'p', revision: 1, original, translation, translationRevision: 1,
  originalFinal: true, translationFinal: true, ...extra });

describe('面對面對講：按哪一側就是哪一種語言', () => {
  it('只有漢字、辨識服務標成中文的日文，按日文那一側仍以日文翻成中文', async () => {
    vi.useFakeTimers(); const h = harness(); await h.session.start();
    expect(h.session.pressTalk('ja')).toBe(true);
    h.callbacks.onInterim('東京大学', 'cmn-Hans-CN'); await vi.advanceTimersByTimeAsync(10);
    const task = h.translate.mock.calls[0][0];
    expect(task.audioLanguage).toBe('ja'); expect(task.direction).toBe('ja-zh'); h.session.dispose();
  });

  it('按中文那一側時，沒有語言標記的漢字句子固定為中文翻成日文', async () => {
    vi.useFakeTimers(); const h = harness(); await h.session.start();
    h.session.pressTalk('ja'); h.session.releaseTalk(); h.audio(new Int16Array(4800).fill(9).buffer);
    h.callbacks.onFinal('東京大学', 'ja-JP');
    expect(h.session.pressTalk('zh')).toBe(true);
    h.callbacks.onInterim('東京大學'); await vi.advanceTimersByTimeAsync(2000);
    const task = h.translate.mock.calls.at(-1)![0];
    expect(task.audioLanguage).toBe('zh'); expect(task.direction).toBe('zh-ja'); h.session.dispose();
  });

  it('按錯邊（中文側說出明顯的日文）時不硬套，退回自動判斷方向', async () => {
    vi.useFakeTimers(); const h = harness(); await h.session.start();
    h.session.pressTalk('zh');
    h.callbacks.onInterim('来週は青森に行きます。', 'ja-JP'); await vi.advanceTimersByTimeAsync(10);
    const task = h.translate.mock.calls[0][0];
    expect(task.audioLanguage).toBeUndefined(); expect(task.direction).toBe('ja-zh'); h.session.dispose();
  });

  it('一側還沒說完時，另一側按下不會接進同一句；同一側可以接續', async () => {
    const h = harness(); await h.session.start();
    expect(h.session.pressTalk('zh')).toBe(true);
    expect(h.session.pressTalk('ja')).toBe(false);
    h.session.releaseTalk();
    expect(h.session.pressTalk('ja')).toBe(false);
    expect(h.session.pressTalk('zh')).toBe(true);
    expect(h.stt.startActivity).toHaveBeenCalledOnce();
    h.session.releaseTalk(); h.audio(new Int16Array(4800).fill(9).buffer);
    h.callbacks.onFinal('你好。'); expect(h.session.pressTalk('ja')).toBe(true);
    expect(h.stt.startActivity).toHaveBeenCalledTimes(2); h.session.dispose();
  });

  it('不在語言配對內的語言不會被採用', async () => {
    vi.useFakeTimers(); const h = harness(); await h.session.start();
    h.session.pressTalk('en'); h.callbacks.onInterim('你好嗎', 'cmn-Hans-CN'); await vi.advanceTimersByTimeAsync(10);
    expect(h.translate.mock.calls[0][0].audioLanguage).toBe('zh'); h.session.dispose();
  });
});

describe('面對面對講：兩側各自看到的內容', () => {
  it('依配對決定兩側語言，儲存的語言不在配對內時用配對的第一種', () => {
    expect(faceLanguages('zh-ja')).toEqual({ near: 'zh', far: 'ja' });
    expect(faceLanguages('zh-ja', 'ja')).toEqual({ near: 'ja', far: 'zh' });
    expect(faceLanguages('ja-en', 'zh')).toEqual({ near: 'ja', far: 'en' });
    expect(faceLanguages('zh-en', 'en')).toEqual({ near: 'en', far: 'zh' });
  });

  it('同一輪被拆開的字幕合併成一則；每一輪各自成一則', () => {
    const turns = faceTurns([
      caption('s-u1-c1', 'zh-ja', '今天天氣很好，', '今日は天気がよくて、'),
      caption('s-u1-c2', 'zh-ja', '我們去散步吧。', '散歩に行きましょう。'),
      caption('s-u2-c1', 'ja-zh', 'いいですね。', '好啊。'),
      caption('s-u3-c1', 'ja-zh', 'どこへ行きますか。', '', { translationFinal: false }),
    ]);
    expect(turns.map(turn => turn.original)).toEqual(['今天天氣很好，我們去散步吧。', 'いいですね。', 'どこへ行きますか。']);
    expect(turns[0].translation).toBe('今日は天気がよくて、散歩に行きましょう。');
    expect(turns[2].translationFinal).toBe(false);
  });

  it('自己說的顯示原文，對方說的顯示譯文；還沒譯出的那一輪不顯示空白', () => {
    const turns = faceTurns([
      caption('s-u1-c1', 'zh-ja', '你好。', 'こんにちは。'),
      caption('s-u2-c1', 'ja-zh', 'はじめまして。', '', { translationFinal: false }),
    ]);
    expect(faceLines(turns, 'zh')).toEqual([{ id: 's-u1-c1', own: true, text: '你好。', final: true }]);
    expect(faceLines(turns, 'ja')).toEqual([
      { id: 's-u1-c1', own: false, text: 'こんにちは。', final: true },
      { id: 's-u2-c1', own: true, text: 'はじめまして。', final: true },
    ]);
  });

  it('精準模式的紀錄與未翻譯標記不會出現在對講畫面', () => {
    expect(faceTurns([
      caption('w-1', 'zh-ja', '舊紀錄', '古い記録', { origin: 'precision' }),
      caption('g-1', 'zh-ja', '', '', { gap: { startSeconds: 0, endSeconds: 5, message: '逾時' } }),
    ])).toEqual([]);
  });

  it('同一時間只有一側能說話，另一側顯示等待', () => {
    expect(faceButtonState(false, false, 'idle', null, 'zh')).toBe('preparing');
    expect(faceButtonState(true, false, 'idle', 'ja', 'zh')).toBe('idle');
    expect(faceButtonState(true, false, 'speaking', 'zh', 'zh')).toBe('speaking');
    expect(faceButtonState(true, false, 'speaking', 'zh', 'ja')).toBe('waiting');
    expect(faceButtonState(true, false, 'finishing', 'zh', 'zh')).toBe('finishing');
    expect(faceButtonState(true, false, 'finishing', 'zh', 'ja')).toBe('waiting');
    expect(faceButtonState(false, true, 'closed', 'zh', 'zh')).toBe('ended');
  });

  it('三種語言都有完整的按鈕文字', () => {
    for (const text of Object.values(FACE_TEXT))
      expect(Object.values(text.button).every(Boolean) && text.hint && text.own && text.other).toBeTruthy();
  });
});

describe('面對面對講：記住的選擇', () => {
  function memory() {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); } };
  }
  it('記住對講模式、自己這一側的語言與是否顛倒', () => {
    const storage = memory();
    expect(loadTranslationMode(storage)).toBe('precision');
    saveTranslationMode('face-to-face', storage); expect(loadTranslationMode(storage)).toBe('face-to-face');
    expect(faceNearPreference.load(storage)).toBe('zh');
    faceNearPreference.save('ja', storage); expect(faceNearPreference.load(storage)).toBe('ja');
    expect(faceFlipPreference.load(storage)).toBe('auto');
    faceFlipPreference.save('off', storage); expect(faceFlipPreference.load(storage)).toBe('off');
    // 自動朗讀預設關閉，勾選後才記住為開啟。
    expect(faceSpeakPreference.load(storage)).toBe(false);
    faceSpeakPreference.save(true, storage); expect(faceSpeakPreference.load(storage)).toBe(true);
  });
});
