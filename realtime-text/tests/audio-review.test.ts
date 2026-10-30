import { afterEach, describe, expect, it, vi } from 'vitest';
import { reviewAudio, reviewCost, type ReviewOptions } from '../src/lib/audio-review';
import { RecentAudio } from '../src/audio/recent-audio';
import { UsageTracker } from '../src/lib/usage';

function options(): ReviewOptions {
  const buffer = new RecentAudio(); buffer.append(new Int16Array(16000 * 13).fill(5).buffer);
  return { audio: buffer.snapshot()!, startSeconds: 0, endSeconds: 12,
    settings: { apiKey: 'test-review-key', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving', customVocabulary: ['青森'] },
    signal: new AbortController().signal, beforeRequest: vi.fn(() => true), onUsage: vi.fn() };
}
function respond(segments: unknown[] = [], metadata?: unknown, finishReason = 'STOP') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candidates: [{
    content: { parts: [{ thought: true, text: 'ignore' }, { text: JSON.stringify({ segments }) }] }, finishReason,
  }], usageMetadata: metadata }))));
}
afterEach(() => vi.unstubAllGlobals());

describe('直接原音回聽與額外費用', () => {
  it('傳送實際 WAV（含安靜樣本），不依賴辨識稿；開關外不增加錄音裝置', async () => {
    respond([{ sourceLanguage: 'zh', original: '下周二去青森。', translation: '来週火曜日に青森へ行きます。' }]);
    const o = options(); const result = await reviewAudio(o);
    expect(result[0]).toMatchObject({ direction: 'zh-ja', original: '下週二去青森。' });
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain(':generateContent'); expect(url).not.toContain(o.settings.apiKey);
    expect(request!.headers).toMatchObject({ 'x-goog-api-key': o.settings.apiKey });
    const body = JSON.parse(request!.body as string); const parts = body.contents[0].parts;
    expect(parts[0].text).toContain('[0.000, 12.000)'); expect(parts[0].text).toContain('quiet speech');
    expect(parts[0].text).toContain('青森'); expect(parts[1].inlineData.mimeType).toBe('audio/wav');
    const wav = Uint8Array.from(atob(parts[1].inlineData.data), c => c.charCodeAt(0));
    expect(wav).toEqual(new Uint8Array(o.audio.wav));
    expect(o.onUsage).toHaveBeenCalledWith(expect.objectContaining({ audioTokens: 416, estimated: true }));
  });

  it('每段各自判斷雙向語言，日文保留字形、中文轉繁體', async () => {
    respond([{ sourceLanguage: 'ja', original: '来週は青森へ。', translation: '下周去青森。' },
      { sourceLanguage: 'zh', original: '谢谢。', translation: 'ありがとう。' }]);
    const result = await reviewAudio(options());
    expect(result.map(s => s.direction)).toEqual(['ja-zh', 'zh-ja']);
    expect(result[0].original).toContain('来週'); expect(result[0].translation).toContain('下週');
    expect(result[1].original).toBe('謝謝。');
  });

  it('靜音可回傳空段落；無效語言或不完整回覆不能顯示成校正成功', async () => {
    respond(); expect(await reviewAudio(options())).toEqual([]);
    respond([{ sourceLanguage: 'en', original: 'Hi', translation: '你好' }]);
    await expect(reviewAudio(options())).rejects.toThrow('語言');
    respond([], undefined, 'MAX_TOKENS'); await expect(reviewAudio(options())).rejects.toThrow('不完整');
    respond([null]); await expect(reviewAudio(options())).rejects.toThrow();
  });

  it('預算不足或事先取消時不送請求、不記帳', async () => {
    respond(); const o = options(); o.beforeRequest = () => false;
    await expect(reviewAudio(o)).rejects.toThrow('預算');
    expect(fetch).not.toHaveBeenCalled(); expect(o.onUsage).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(reviewAudio({ ...options(), signal: controller.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('metadata 覆寫預留值，音訊和文字費率分開，重複快照不重複收費', async () => {
    respond([], { promptTokenCount: 516, candidatesTokenCount: 20, thoughtsTokenCount: 3,
      promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 416 }, { modality: 'TEXT', tokenCount: 100 }] });
    const tracker = new UsageTracker(); tracker.addAudioBytes(32000 * 13); tracker.record('live', 'x', 'y', 10, 5);
    const o = options(); o.onUsage = usage => tracker.recordReview('review-1', 13, usage);
    await reviewAudio(o); const usage = tracker.snapshot();
    const expectedReview = (100 * .25 + 416 * .5 + 23 * 1.5) / 1e6;
    expect(usage).toMatchObject({ reviewRequests: 1, reviewAudioSeconds: 13, inputTokens: 526, outputTokens: 28, tokenEstimate: false });
    expect(usage.reviewEstimatedUsd).toBeCloseTo(expectedReview);
    expect(usage.estimatedUsd).toBeCloseTo(13 / 60 * .009 + (10 * .25 + 5 * 1.5) / 1e6 + expectedReview);
    expect(tracker.snapshot()).toEqual(usage);
  });

  it('失敗或沒有完整 metadata 時保留保守估算，不把已上傳原音算成免費', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not exposed', { status: 429 })));
    const o = options(), tracker = new UsageTracker(); o.onUsage = usage => tracker.recordReview('failed', 13, usage);
    await expect(reviewAudio(o)).rejects.toThrow('429');
    expect(tracker.snapshot()).toMatchObject({ reviewRequests: 1, tokenEstimate: true, outputTokens: 2048 });
    expect(tracker.snapshot().reviewEstimatedUsd).toBeGreaterThan(0);
    expect(reviewCost({ inputTokens: 100, audioTokens: 80, outputTokens: 10, estimated: true })).toBeCloseTo(.00006);
  });
});
