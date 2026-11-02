import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrecisionTranslationSession } from '../src/lib/precision-session';
import type { ServerMessage } from '../shared/protocol';
import { captionHistory } from '../src/lib/history';
import { reviewCost } from '../src/lib/audio-review';
import { exportParagraphs, groupCaptions } from '../src/lib/paragraphs';

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function harness(budgetUsd?: number) {
  const events: ServerMessage[] = [];
  let audio!: (chunk: ArrayBuffer) => void;
  const capture = { prepare: vi.fn(async () => {}), start: vi.fn(async (next: typeof audio) => { audio = next; }), stop: vi.fn(async () => {}) };
  const reviewAudio = vi.fn(async options => {
    const usage = { inputTokens: 516, audioTokens: 416, outputTokens: 20, estimated: false };
    if (!options.beforeRequest(usage)) throw new Error('預算不足');
    options.onUsage(usage);
    return { segments: [{ direction: 'ja-zh' as const, original: '来週、青森に行きます。', translation: '下週要去青森。' }],
      ...(options.previous ? { previousSegments: options.previous.segments } : {}) };
  });
  const session = new PrecisionTranslationSession({ apiKey: 'fake', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving', budgetUsd },
    event => events.push(event), { capture, reviewAudio });
  return { session, events, capture, reviewAudio, audio: (seconds: number, value = 1000) => audio(new Int16Array(Math.round(seconds * 16000)).fill(value).buffer) };
}
afterEach(() => vi.unstubAllGlobals());

describe('以原音翻譯作為唯一主流程', () => {
  it('不建立 Live 連線或文字串流，連續說話最多等 20 秒與 3 秒後文後送出', async () => {
    const socket = vi.fn(() => { throw new Error('unexpected Live'); }), fetcher = vi.fn();
    vi.stubGlobal('WebSocket', socket); vi.stubGlobal('fetch', fetcher);
    const h = harness(); await h.session.start(); h.audio(20); expect(h.reviewAudio).not.toHaveBeenCalled();
    h.audio(3); await settle();
    expect(h.reviewAudio).toHaveBeenCalledOnce(); expect(socket).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    const history = h.events.reduce((items, event) => captionHistory(items, { type: 'message', event, direction: 'zh-ja' }), [] as Parameters<typeof captionHistory>[0]);
    expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ origin: 'precision', direction: 'ja-zh', original: '来週、青森に行きます。', translation: '下週要去青森。', translationFinal: true });
    expect(h.capture.start).toHaveBeenCalledOnce(); h.session.dispose();
  });

  it('原音與文字用量會計費，但不加上未使用的 Live 辨識費；後續片段帶入前文', async () => {
    const h = harness(); await h.session.start(); h.audio(23); await settle();
    const usage = h.events.filter(event => event.type === 'usage').at(-1)!.usage;
    expect(usage).toMatchObject({ audioSeconds: 23, translationRequests: 0, reviewRequests: 1, reviewAudioSeconds: 23 });
    expect(usage.estimatedUsd).toBeCloseTo(reviewCost({ inputTokens: 516, audioTokens: 416, outputTokens: 20, estimated: false }));
    h.audio(20); await settle(); expect(h.reviewAudio.mock.calls[1][0].settings.context).toContain('青森');
    expect(h.reviewAudio.mock.calls[1][0].previous.segments[0].original).toContain('青森');
    expect(h.reviewAudio.mock.calls[1][0].audio).toMatchObject({ startSeconds: 0, endSeconds: 43 });
    h.session.dispose();
  });

  it('停止時最後不足 12 秒及尾包也會翻譯，原音仍能回放', async () => {
    const h = harness(); await h.session.start(); h.audio(2);
    h.capture.stop.mockImplementationOnce(async () => { h.audio(.1, 9); }); await h.session.stop();
    expect(h.reviewAudio).toHaveBeenCalledOnce(); expect(h.reviewAudio.mock.calls[0][0].audio.durationSeconds).toBe(2.1);
    expect(h.session.snapshotAudio()!.durationSeconds).toBe(2.1);
    expect(h.events.some(event => event.type === 'status' && event.status === 'stopped')).toBe(true);
  });

  it('剩餘預算不足或翻譯失敗會停止收音，不暗中改回即時流程', async () => {
    const h = harness(.000001); await h.session.start(); h.audio(23); await settle();
    expect(h.events.some(event => event.type === 'error' && event.message.includes('預算'))).toBe(true);
    expect(h.capture.stop).toHaveBeenCalledWith(false); expect(h.session.snapshotAudio()).toBeDefined();
    const failed = harness(); failed.reviewAudio.mockRejectedValueOnce(new Error('model failed'));
    await failed.session.start(); failed.audio(23); await settle(); failed.audio(23); await settle();
    expect(failed.reviewAudio).toHaveBeenCalledOnce(); expect(failed.events.some(event => event.type === 'error')).toBe(true);
  });

  it('取消準備或晚到回覆不能重新啟動收音／改寫已清除紀錄', async () => {
    const h = harness(); let prepared!: () => void;
    h.capture.prepare.mockImplementationOnce(() => new Promise(resolve => { prepared = resolve; }));
    const opening = h.session.start(); await h.session.stop(); prepared(); await opening;
    expect(h.capture.start).not.toHaveBeenCalled();
    const late = harness(); let complete!: () => void;
    late.reviewAudio.mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve({ segments: [{ direction: 'ja-zh', original: '青森', translation: '青森' }] }); }));
    await late.session.start(); late.audio(23); late.session.dispose(); const count = late.events.length;
    complete(); await settle(); expect(late.events).toHaveLength(count);
  });

  it('後段否定修正前段原譯文，替換同一筆且縮短段數不留舊字，TXT 只含新結果', async () => {
    const h = harness();
    h.reviewAudio.mockImplementationOnce(async options => {
      options.onUsage({ inputTokens: 500, audioTokens: 400, outputTokens: 20, estimated: false });
      return { segments: [
      { direction: 'ja-zh', original: '青森に行くつもり', translation: '我打算去青森' },
      { direction: 'ja-zh', original: 'です', translation: '的' },
    ] }; });
    await h.session.start(); h.audio(23); await settle();
    h.reviewAudio.mockImplementationOnce(async options => {
      options.onUsage({ inputTokens: 1500, audioTokens: 1400, outputTokens: 40, estimated: false });
      return {
      previousSegments: [{ direction: 'ja-zh', original: '青森に行くつもり', translation: '我沒有打算去青森' }],
      segments: [{ direction: 'ja-zh', original: 'はありません。', translation: '。' }],
    }; });
    h.audio(20); await settle();
    const history = h.events.reduce((items, event) => captionHistory(items, { type: 'message', event, direction: 'zh-ja' }), [] as Parameters<typeof captionHistory>[0]);
    expect(history).toHaveLength(2); expect(history[0]).toMatchObject({ revision: 2, translation: '我沒有打算去青森', corrected: true });
    expect(history[1].original).toBe('はありません。');
    expect(h.reviewAudio).toHaveBeenCalledTimes(2); // Correction shares the ordinary next request.
    expect(h.reviewAudio.mock.calls[1][0].audio).toMatchObject({ startSeconds: 0, endSeconds: 43 });
    expect(h.events.filter(event => event.type === 'usage').at(-1)!.usage.reviewAudioSeconds).toBe(66);
    expect(h.reviewAudio.mock.calls[1][0].settings.context).not.toContain('です');
    const exported = exportParagraphs(groupCaptions(history), true);
    expect(exported).toContain('我沒有打算去青森'); expect(exported).not.toContain('我打算去青森');
    expect(exported).not.toContain('です');
    h.session.dispose();
  });

  it('短暫停頓後才送出，原音中的小聲／安靜樣本原封不動保留', async () => {
    const h = harness(); await h.session.start(); h.audio(12); h.audio(.7, 0);
    expect(h.reviewAudio).not.toHaveBeenCalled(); h.audio(2.7, 4); await settle();
    expect(h.reviewAudio).toHaveBeenCalledOnce();
    const input = h.reviewAudio.mock.calls[0][0]; expect(input.endSeconds).toBeCloseTo(12.35);
    expect(input.audio.endSeconds).toBeCloseTo(15.35);
    const samples = new Int16Array(input.audio.wav.slice(44));
    expect(samples[12 * 16000 - 1]).toBe(1000); expect(samples[12 * 16000]).toBe(0); expect(samples.at(-1)).toBe(4);
    await h.session.stop();
    expect(h.reviewAudio.mock.calls[1][0]).toMatchObject({ startSeconds: input.endSeconds, endSeconds: 15.4 });
  });

  it('排隊片段等待前段完成後取得正確的銜接對象；長時間仍保留整個前段', async () => {
    const h = harness(); let release!: () => void;
    h.reviewAudio.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({
      segments: [{ direction: 'ja-zh', original: '最初の話', translation: '第一段' }],
    }); }));
    await h.session.start(); h.audio(23); h.audio(20);
    expect(h.reviewAudio).toHaveBeenCalledOnce(); release(); await settle();
    expect(h.reviewAudio.mock.calls[1][0].previous.segments[0].original).toBe('最初の話');
    for (let i = 0; i < 5; i++) { h.audio(20); await settle(); }
    const input = h.reviewAudio.mock.calls.at(-1)![0];
    expect(input.audio.startSeconds).toBe(input.previous.startSeconds);
    expect(input.audio.endSeconds).toBe(input.endSeconds + 3);
    expect(input.audio.durationSeconds).toBe(43);
    h.session.dispose();
  });

  it('前段銜接回覆缺失時保留已完成紀錄並停止，取消後回覆也不能改寫', async () => {
    const h = harness(); await h.session.start(); h.audio(23); await settle();
    const results = () => h.events.filter(event => event.type === 'transcript' || event.type === 'translation');
    const count = results().length;
    h.reviewAudio.mockResolvedValueOnce({ segments: [] }); h.audio(20); await settle();
    expect(results()).toHaveLength(count); expect(h.events.some(event => event.type === 'error')).toBe(true);
    expect(h.capture.stop).toHaveBeenCalledWith(false);
    const late = harness(); await late.session.start(); late.audio(23); await settle(); let release!: () => void;
    late.reviewAudio.mockImplementationOnce(options => new Promise(resolve => { release = () => resolve({
      previousSegments: options.previous.segments, segments: [],
    }); }));
    late.audio(20); late.session.dispose(); const before = late.events.length;
    release(); await settle(); expect(late.events).toHaveLength(before);
  });
});
