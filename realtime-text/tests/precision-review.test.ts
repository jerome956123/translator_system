import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrecisionReviewer } from '../src/lib/precision-review';
import type { reviewAudio } from '../src/lib/audio-review';
import type { ServerMessage } from '../shared/protocol';

const pcm = (seconds: number, value = 0) => new Int16Array(seconds * 16000).fill(value).buffer;
function harness(request?: typeof reviewAudio) {
  const events: ServerMessage[] = [];
  const query = vi.fn(request ?? (async options => {
    if (!options.beforeRequest({ inputTokens: 100, audioTokens: 80, outputTokens: 10, estimated: true })) throw new Error('預算不足');
    return [{ direction: 'zh-ja' as const, original: '小聲也有收錄', translation: '小さな声' }];
  }));
  const callbacks = { emit: (event: ServerMessage) => events.push(event), beforeRequest: vi.fn(() => true), onUsage: vi.fn() };
  const reviewer = new PrecisionReviewer('session', { apiKey: 'fake', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving' }, callbacks, query);
  return { reviewer, query, events, callbacks };
}
afterEach(() => vi.useRealTimers());

describe('回聽不受 VAD／即時文字影響', () => {
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
    const h = harness(async () => []); h.reviewer.append(pcm(13)); await Promise.resolve(); await Promise.resolve();
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
    const h = harness(() => new Promise(resolve => { release = () => resolve([]); }));
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
    const late = harness(() => new Promise(resolve => { release = () => resolve([]); }));
    late.reviewer.append(pcm(13)); late.reviewer.close(); const count = late.events.length;
    release(); await Promise.resolve(); await Promise.resolve(); expect(late.events).toHaveLength(count);
  });
});
