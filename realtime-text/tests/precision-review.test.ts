import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrecisionReviewer } from '../src/lib/precision-review';
import type { reviewAudio } from '../src/lib/audio-review';
import type { ServerMessage } from '../shared/protocol';
import { TranslationLanguageError } from '../src/lib/translation-language';
import { AudioRequestError } from '../src/lib/api-error';

// 預設是有訊號的聲音；需要數位靜音時明確傳 0。
const pcm = (seconds: number, value = 300) => new Int16Array(seconds * 16000).fill(value).buffer;
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const errored = (events: ServerMessage[]) => events.some(event => event.type === 'precision-status' && event.state === 'error');
const gaps = (events: ServerMessage[]) => events.flatMap(event => event.type === 'precision-gap' ? [[event.startSeconds, event.endSeconds]] : []);
function harness(request?: typeof reviewAudio, sentenceAware = false) {
  const events: ServerMessage[] = [];
  const query = vi.fn(request ?? (async options => {
    if (!options.beforeRequest({ inputTokens: 100, audioTokens: 80, outputTokens: 10, estimated: true })) throw new Error('預算不足');
    return { segments: [{ direction: 'zh-ja' as const, original: '小聲也有收錄', translation: '小さな声' }] };
  }));
  const callbacks = { emit: (event: ServerMessage) => events.push(event), beforeRequest: vi.fn(() => true), onUsage: vi.fn() };
  const reviewer = new PrecisionReviewer('session', { apiKey: 'fake', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving' }, callbacks, query, sentenceAware);
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
  it('設定、金鑰、權限及不支援功能不盲目重試，立即停止並標示未翻譯範圍', async () => {
    vi.useFakeTimers();
    for (const code of [400, 401, 402, 403, 404, 501]) {
      const h = harness(async () => { throw new AudioRequestError(`Google ${code}`, code); });
      h.reviewer.append(pcm(13)); await vi.advanceTimersByTimeAsync(5000);
      expect(h.query).toHaveBeenCalledOnce();
      expect(errored(h.events)).toBe(true);
      expect(gaps(h.events)).toEqual([[0, 13]]);
      h.reviewer.append(pcm(13)); expect(h.query).toHaveBeenCalledOnce();
      h.reviewer.close();
    }
  });
  it('暫時性故障每段最多試三次（間隔 1 秒、3 秒）；放棄這段但不停止收音', async () => {
    vi.useFakeTimers(); const h = harness(async () => { throw new AudioRequestError('Google 503 原因', 503); });
    h.reviewer.append(pcm(13)); await vi.advanceTimersByTimeAsync(999); expect(h.query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2999); expect(h.query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(h.query).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10000); expect(h.query).toHaveBeenCalledTimes(3);
    expect(h.query.mock.calls[2][0].audio).toBe(h.query.mock.calls[0][0].audio);
    expect(h.events.some(event => event.type === 'precision-result')).toBe(false);
    expect(errored(h.events)).toBe(false);
    expect(h.events.some(event => event.type === 'precision-status' && event.state === 'waiting' && event.message.includes('暫時無法翻譯'))).toBe(true);
    // 固定區間模式的下一段原音沒有涵蓋失敗的那段：留下缺口，然後照常送出下一段。
    h.reviewer.append(pcm(12)); await vi.advanceTimersByTimeAsync(0);
    expect(h.query).toHaveBeenCalledTimes(4); expect(gaps(h.events)).toEqual([[0, 12]]);
    h.reviewer.close();
  });
  it('斷網（fetch 的 TypeError）與 429 都會重試；恢復後不留缺口', async () => {
    vi.useFakeTimers();
    for (const failure of [new TypeError('Failed to fetch'), new AudioRequestError('Google 429', 429)]) {
      let attempts = 0;
      const h = harness(async () => {
        if (attempts++ < 2) throw failure;
        return { segments: [{ direction: 'zh-ja', original: '網路恢復', translation: '復旧しました' }] };
      });
      h.reviewer.append(pcm(13)); await vi.advanceTimersByTimeAsync(4000);
      expect(h.query).toHaveBeenCalledTimes(3);
      expect(h.events.filter(event => event.type === 'precision-result')).toHaveLength(1);
      expect(gaps(h.events)).toEqual([]); expect(errored(h.events)).toBe(false);
      h.reviewer.close();
    }
  });
  it('連續三段都失敗才停止整場，每段未翻譯的範圍依序標示', async () => {
    vi.useFakeTimers(); const h = harness(async () => { throw new TypeError('Failed to fetch'); });
    h.reviewer.append(pcm(13)); await vi.advanceTimersByTimeAsync(5000);
    h.reviewer.append(pcm(12)); await vi.advanceTimersByTimeAsync(5000);
    expect(errored(h.events)).toBe(false);
    h.reviewer.append(pcm(12)); await vi.advanceTimersByTimeAsync(5000);
    expect(h.query).toHaveBeenCalledTimes(9);
    expect(h.events.some(event => event.type === 'precision-status' && event.state === 'error' && event.message.includes('連續 3 段'))).toBe(true);
    expect(gaps(h.events)).toEqual([[0, 12], [12, 24], [24, 37]]);
    h.reviewer.append(pcm(13)); expect(h.query).toHaveBeenCalledTimes(9);
    h.reviewer.close();
  });
  it('失敗的那段由下一段連同原音一起補翻，補翻成功就沒有缺口', async () => {
    let attempts = 0;
    const h = harness(async options => {
      if (!attempts++) throw new Error('AI 回覆格式不完整');
      return { segments: [{ direction: 'zh-ja', original: '兩段一起', translation: '二つ分' }],
        ...(options.previous ? { previousSegments: options.previous.segments } : {}) };
    }, true);
    h.reviewer.append(pcm(23, 900)); await settle();
    expect(h.query).toHaveBeenCalledOnce(); expect(errored(h.events)).toBe(false);
    h.reviewer.append(pcm(20, 900)); await settle();
    const recovery = h.query.mock.calls[1][0];
    expect(recovery).toMatchObject({ startSeconds: 0, endSeconds: 40, audio: { startSeconds: 0, endSeconds: 43 } });
    expect(recovery.previous).toBeUndefined();
    expect(h.events.filter(event => event.type === 'precision-result').map(event => [event.window.startSeconds, event.window.endSeconds])).toEqual([[0, 40]]);
    expect(gaps(h.events)).toEqual([]);
    // 補翻那次涵蓋兩段，下一段的原音只從後一段錄起：不拿不完整的前段做銜接校對。
    h.reviewer.append(pcm(20, 900)); await settle();
    expect(h.query.mock.calls[2][0]).toMatchObject({ startSeconds: 40, endSeconds: 60, audio: { startSeconds: 20 } });
    expect(h.query.mock.calls[2][0].previous).toBeUndefined();
    h.reviewer.append(pcm(20, 900)); await settle();
    expect(h.query.mock.calls[3][0].previous).toMatchObject({ startSeconds: 40, endSeconds: 60 });
    h.reviewer.close();
  });
  it('停止時最後一段失敗：沒有下一段可補翻，標示缺口後正常收尾', async () => {
    const h = harness(async () => { throw new Error('AI 回覆格式不完整'); }, true);
    h.reviewer.append(pcm(5, 900)); await h.reviewer.finish();
    expect(gaps(h.events)).toEqual([[0, 5]]); expect(errored(h.events)).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ type: 'precision-status', state: 'stopped', message: expect.stringContaining('未能翻譯') });
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
  it('兩次都是錯誤語言時放棄這段，不保留假的成功結果，也不停止收音', async () => {
    const h = harness(async () => { throw new TranslationLanguageError(); }); h.reviewer.append(pcm(13));
    await settle();
    expect(h.query).toHaveBeenCalledTimes(2); expect(h.events.some(event => event.type === 'precision-result')).toBe(false);
    expect(errored(h.events)).toBe(false);
    expect(h.events.some(event => event.type === 'precision-status' && event.state === 'waiting' && event.message.includes('暫時無法翻譯'))).toBe(true);
    h.reviewer.close();
  });
  it('長停頓後的小聲開頭也完整送出，固定區間有前後文且目標不重疊', async () => {
    const h = harness();
    h.reviewer.append(pcm(10, 0)); h.reviewer.append(pcm(3, 4)); await Promise.resolve();
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

  it('極小聲或沒有原文的片段仍回聽，不會因沒達音量門檻而跳過', async () => {
    const h = harness(async () => ({ segments: [] })); h.reviewer.append(pcm(13, 3)); await Promise.resolve(); await Promise.resolve();
    expect(h.query).toHaveBeenCalledOnce();
    expect(h.events.find(event => event.type === 'precision-result')).toMatchObject({ window: { segments: [] } });
    h.reviewer.close();
  });

  it('整段都是數位靜音（麥克風靜音、分頁沒有播放）才不送出；之後有聲音照常翻譯，不留缺口', async () => {
    const h = harness(undefined, true);
    h.reviewer.append(pcm(40, 0)); h.reviewer.append(pcm(20, 2)); await settle();
    expect(h.query).not.toHaveBeenCalled(); expect(gaps(h.events)).toEqual([]); expect(errored(h.events)).toBe(false);
    expect(h.events.some(event => event.type === 'precision-status' && event.state === 'waiting' && event.message.includes('沒有聲音訊號'))).toBe(true);
    // 段落裡只要有一點訊號（這裡是後文的最後幾個樣本）就會送出。
    h.reviewer.append(pcm(12.5, 0)); h.reviewer.append(pcm(.5, 3)); h.reviewer.append(pcm(3, 0)); await settle();
    expect(h.query).toHaveBeenCalledOnce();
    expect(h.query.mock.calls[0][0].previous).toBeUndefined();
    h.reviewer.close();
  });

  it('有請求進行中或待補翻時不略過靜音段，維持原本的銜接；停止時的靜音尾段也不送出', async () => {
    let release!: () => void;
    const h = harness(options => new Promise(resolve => { release = () => resolve({ segments: [],
      ...(options.previous ? { previousSegments: [] } : {}) }); }), true);
    h.reviewer.append(pcm(23, 900)); expect(h.query).toHaveBeenCalledOnce();
    // 第一個請求還沒回來時切出兩段：前一段含尾音，後一段完全靜音但已在排隊，照常送出。
    h.reviewer.append(pcm(27.4, 0));
    release(); await settle();
    expect(h.query).toHaveBeenCalledTimes(2); expect(h.query.mock.calls[1][0].previous).toBeDefined();
    release(); await settle();
    expect(h.query).toHaveBeenCalledTimes(3); expect(h.query.mock.calls[2][0].previous).toBeDefined();
    release(); await settle(); h.reviewer.append(pcm(2, 0)); await h.reviewer.finish();
    expect(h.query).toHaveBeenCalledTimes(3); expect(gaps(h.events)).toEqual([]);
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

  it('一次只送一個請求；排隊超限時不停止收音，沒送出的範圍依序標示而非默默跳掉', async () => {
    const releases: (() => void)[] = [];
    const h = harness(() => new Promise(resolve => { releases.push(() => resolve({ segments: [] })); }));
    h.reviewer.append(pcm(13)); for (let i = 0; i < 5; i++) h.reviewer.append(pcm(12));
    expect(h.query).toHaveBeenCalledOnce(); expect(errored(h.events)).toBe(false);
    for (let i = 0; i < 4; i++) { releases[i](); await settle(); }
    expect(h.query).toHaveBeenCalledTimes(4);
    expect(h.query.mock.calls.map(call => [call[0].startSeconds, call[0].endSeconds])).toEqual([[0, 12], [12, 24], [24, 36], [36, 48]]);
    expect(gaps(h.events)).toEqual([]);
    h.reviewer.append(pcm(12)); await settle();
    expect(gaps(h.events)).toEqual([[48, 72]]);
    expect(h.events.find(event => event.type === 'precision-gap')).toMatchObject({ message: expect.stringContaining('跟不上') });
    expect(h.query.mock.calls[4][0]).toMatchObject({ startSeconds: 72, endSeconds: 84 });
    h.reviewer.close();
  });

  it('非暫時性的單段失敗不重試、隱藏金鑰，下一段照常送出', async () => {
    const h = harness(async () => { throw new Error('fake denied'); });
    h.reviewer.append(pcm(13)); await settle();
    expect(h.query).toHaveBeenCalledOnce(); expect(errored(h.events)).toBe(false);
    expect(h.events.some(event => event.type === 'precision-status' && event.state === 'waiting' && event.message.includes('[已隱藏金鑰]'))).toBe(true);
    h.reviewer.append(pcm(12)); await settle();
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.events.find(event => event.type === 'precision-gap')).toMatchObject({ message: '[已隱藏金鑰] denied' });
    h.reviewer.close();
  });

  it('每次嘗試 20 秒逾時並中止網路，逾時也會重試；關閉後的晚到回覆不能改寫紀錄', async () => {
    vi.useFakeTimers(); let aborts = 0;
    const h = harness(options => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborts++; reject(options.signal.reason); });
    }));
    h.reviewer.append(pcm(13)); await vi.advanceTimersByTimeAsync(20001); expect(aborts).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); expect(h.query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20000 + 3000 + 20001);
    expect(h.query).toHaveBeenCalledTimes(3); expect(aborts).toBe(3);
    expect(errored(h.events)).toBe(false);
    expect(h.events.some(event => event.type === 'precision-status' && event.state === 'waiting' && event.message.includes('20 秒'))).toBe(true);
    h.reviewer.close();
    let release!: () => void;
    const late = harness(() => new Promise(resolve => { release = () => resolve({ segments: [] }); }));
    late.reviewer.append(pcm(13)); late.reviewer.close(); const count = late.events.length;
    release(); await Promise.resolve(); await Promise.resolve(); expect(late.events).toHaveLength(count);
  });
});
