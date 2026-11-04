import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrecisionReviewer } from '../src/lib/precision-review';
import type { reviewAudio } from '../src/lib/audio-review';
import type { ServerMessage } from '../shared/protocol';
import { TranslationLanguageError } from '../src/lib/translation-language';
import { AudioRequestError } from '../src/lib/api-error';

const pcm = (seconds: number, value = 0) => new Int16Array(seconds * 16000).fill(value).buffer;
function harness(request?: typeof reviewAudio) {
  const events: ServerMessage[] = [];
  const query = vi.fn(request ?? (async options => {
    if (!options.beforeRequest({ inputTokens: 100, audioTokens: 80, outputTokens: 10, estimated: true })) throw new Error('預算不足');
    return { segments: [{ direction: 'zh-ja' as const, original: '小聲也有收錄', translation: '小さな声' }] };
  }));
  const callbacks = { emit: (event: ServerMessage) => events.push(event), beforeRequest: vi.fn(() => true), onUsage: vi.fn() };
  const reviewer = new PrecisionReviewer('session', { apiKey: 'fake', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving' }, callbacks, query);
  return { reviewer, query, events, callbacks };
}
afterEach(() => vi.useRealTimers());

describe('回聽不受 VAD／即時文字影響', () => {
  it('Google 503 保留同段原音，一秒後最多重試一次，兩次請求分開計費', async () => {
    vi.useFakeTimers(); let attempts = 0;
    const h = harness(async options => {
      options.onUsage({ inputTokens: 100, audioTokens: 80, outputTokens: 10, estimated: false });
      if (!attempts++) throw new AudioRequestError('Google 暫時異常', 503);
      return { segments: [{ direction: 'zh-ja', original: '沒有遺失這段', translation: '音声を保持しました' }] };
    });
    h.reviewer.append(pcm(13, 4)); await vi.advanceTimersByTimeAsync(999);
    expect(h.query).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.query.mock.calls[1][0].audio).toBe(h.query.mock.calls[0][0].audio);
    expect(h.callbacks.onUsage).toHaveBeenCalledTimes(2);
    expect(new Set(h.callbacks.onUsage.mock.calls.map(call => call[0])).size).toBe(2);
    expect(h.events.filter(event => event.type === 'precision-result')).toHaveLength(1);
    h.reviewer.close();
  });
  it('設定、金鑰、權限、額度及不支援功能不盲目重試', async () => {
    vi.useFakeTimers();
    for (const code of [400, 401, 402, 403, 404, 429, 501]) {
      const h = harness(async () => { throw new AudioRequestError(`Google ${code}`, code); });
      h.reviewer.append(pcm(13)); await vi.advanceTimersByTimeAsync(1500);
      expect(h.query).toHaveBeenCalledOnce();
      expect(h.events.some(event => event.type === 'precision-status' && event.state === 'error')).toBe(true);
      h.reviewer.close();
    }
  });
  it('連續服務故障只試兩次，後續收音不會再產生請求或空的成功結果', async () => {
    vi.useFakeTimers(); const h = harness(async () => { throw new AudioRequestError('Google 503 原因', 503); });
    h.reviewer.append(pcm(13)); await vi.advanceTimersByTimeAsync(5000); h.reviewer.append(pcm(40));
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.events.some(event => event.type === 'precision-result')).toBe(false);
    expect(h.events.some(event => event.type === 'precision-status' && event.state === 'error' && event.message.includes('Google 503 原因'))).toBe(true);
    h.reviewer.close();
  });
  it('等待重試期間取消，不能再上傳或回寫', async () => {
    vi.useFakeTimers(); const h = harness(async () => { throw new AudioRequestError('Google unavailable', 503); });
    h.reviewer.append(pcm(13)); await vi.advanceTimersByTimeAsync(100); h.reviewer.close(); const count = h.events.length;
    await vi.advanceTimersByTimeAsync(5000); expect(h.query).toHaveBeenCalledOnce(); expect(h.events).toHaveLength(count);
  });
  it('服務重試與語言修復各限一次，不能相互重設造成無限請求', async () => {
    vi.useFakeTimers(); let attempts = 0;
    const h = harness(async () => {
      if (!attempts++) throw new AudioRequestError('Google unavailable', 503);
      throw new TranslationLanguageError();
    });
    h.reviewer.append(pcm(13)); await vi.advanceTimersByTimeAsync(5000);
    expect(h.query).toHaveBeenCalledTimes(3);
    expect(h.query.mock.calls[2][0].languageRetry).toBe(true);
    expect(h.events.some(event => event.type === 'precision-result')).toBe(false); h.reviewer.close();
  });
  it('語言錯誤只重試一次，每次請求分別計費，修正完成才加入結果', async () => {
    let attempts = 0;
    const h = harness(async options => {
      options.onUsage({ inputTokens: 100, audioTokens: 80, outputTokens: 10, estimated: false });
      if (!attempts++) throw new TranslationLanguageError();
      expect(options.languageRetry).toBe(true);
      return { segments: [{ direction: 'ja-zh', original: '青森に行きます。', translation: '要去青森。' }] };
    }); h.reviewer.append(pcm(13));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(h.query).toHaveBeenCalledTimes(2); expect(h.callbacks.onUsage).toHaveBeenCalledTimes(2);
    expect(new Set(h.callbacks.onUsage.mock.calls.map(call => call[0])).size).toBe(2);
    expect(h.events.filter(event => event.type === 'precision-result')).toHaveLength(1); h.reviewer.close();
  });
  it('兩次都是錯誤語言時明確失敗，不保留假的成功結果', async () => {
    const h = harness(async () => { throw new TranslationLanguageError(); }); h.reviewer.append(pcm(13));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(h.query).toHaveBeenCalledTimes(2); expect(h.events.some(event => event.type === 'precision-result')).toBe(false);
    expect(h.events.some(event => event.type === 'precision-status' && event.state === 'error')).toBe(true); h.reviewer.close();
  });
  it('長停頓後的小聲開頭也完整送出，固定區間有前後文且目標不重疊', async () => {
    const h = harness();
    h.reviewer.append(pcm(10)); h.reviewer.append(pcm(3, 4)); await Promise.resolve();
    expect(h.query).toHaveBeenCalledTimes(1);
    const first = h.query.mock.calls[0][0]; expect(first).toMatchObject({ startSeconds: 0, endSeconds: 12 });
    const samples = new Int16Array(first.audio.wav.slice(44));
    expect(samples[160000 - 1]).toBe(0); expect(samples[160000]).toBe(4); expect(samples.at(-1)).toBe(4);
    h.reviewer.append(pcm(12, 6)); await Promise.resolve(); await Promise.resolve();
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.query.mock.calls[1][0]).toMatchObject({ startSeconds: 12, endSeconds: 24,
      audio: { startSeconds: 10, endSeconds: 25, durationSeconds: 15 } });
    h.reviewer.close();
  });

  it('純安靜仍回聽，不會因沒達音量門檻或沒有原文而跳過', async () => {
    const h = harness(async () => ({ segments: [] })); h.reviewer.append(pcm(13)); await Promise.resolve(); await Promise.resolve();
    expect(h.query).toHaveBeenCalledOnce();
    expect(h.events.find(event => event.type === 'precision-result')).toMatchObject({ window: { segments: [] } });
    h.reviewer.close();
  });

  it('停止時送出最後不足 12 秒的尾段，按收音順序收尾', async () => {
    const h = harness(); h.reviewer.append(pcm(13, 7)); await Promise.resolve();
    h.reviewer.append(pcm(2, 8)); await h.reviewer.finish();
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.query.mock.calls[1][0]).toMatchObject({ startSeconds: 12, endSeconds: 15, audio: { startSeconds: 10, endSeconds: 15 } });
    const windows = h.events.filter(event => event.type === 'precision-result').map(event => event.window);
    expect(windows.map(w => [w.startSeconds, w.endSeconds])).toEqual([[0, 12], [12, 15]]);
    h.reviewer.append(pcm(13)); expect(h.query).toHaveBeenCalledTimes(2); h.reviewer.close();
  });

  it('一次只送一個請求；排隊超限時明確暫停而非默默跳掉音訊', async () => {
    let release!: () => void;
    const h = harness(() => new Promise(resolve => { release = () => resolve({ segments: [] }); }));
    h.reviewer.append(pcm(13)); h.reviewer.append(pcm(12)); h.reviewer.append(pcm(12));
    expect(h.query).toHaveBeenCalledOnce(); h.reviewer.append(pcm(12));
    expect(h.events.some(event => event.type === 'precision-status' && event.state === 'error' && event.message.includes('跟不上'))).toBe(true);
    release(); await Promise.resolve(); h.reviewer.append(pcm(13)); expect(h.query).toHaveBeenCalledOnce(); h.reviewer.close();
  });

  it('失敗會停止額外回聽、隱藏金鑰，不能無限重試增加費用', async () => {
    const h = harness(async () => { throw new Error('fake denied'); });
    h.reviewer.append(pcm(13)); await Promise.resolve(); await Promise.resolve(); h.reviewer.append(pcm(20));
    expect(h.query).toHaveBeenCalledOnce();
    const error = h.events.find(event => event.type === 'precision-status' && event.state === 'error');
    expect(error).toMatchObject({ message: expect.stringContaining('[已隱藏金鑰]') }); h.reviewer.close();
  });

  it('20 秒逾時中止網路；關閉後的晚到回覆不能改寫紀錄', async () => {
    vi.useFakeTimers(); let aborted = false;
    const h = harness(options => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); });
    }));
    h.reviewer.append(pcm(13)); await vi.advanceTimersByTimeAsync(20001); expect(aborted).toBe(true);
    expect(h.events.some(event => event.type === 'precision-status' && event.state === 'error')).toBe(true); h.reviewer.close();
    let release!: () => void;
    const late = harness(() => new Promise(resolve => { release = () => resolve({ segments: [] }); }));
    late.reviewer.append(pcm(13)); late.reviewer.close(); const count = late.events.length;
    release(); await Promise.resolve(); await Promise.resolve(); expect(late.events).toHaveLength(count);
  });
});
