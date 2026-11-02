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
function respond(segments: unknown[] = [], metadata?: unknown, finishReason = 'STOP', previousSegments?: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candidates: [{
    content: { parts: [{ thought: true, text: 'ignore' }, { text: JSON.stringify({ segments, previousSegments }) }] }, finishReason,
  }], usageMetadata: metadata }))));
}
afterEach(() => vi.unstubAllGlobals());

describe('直接原音回聽與額外費用', () => {
  it('前段原音缺失或區間不銜接時在上傳和記帳之前停止', async () => {
    respond(); const o = options(); o.startSeconds = 6;
    o.previous = { id: 'old', sessionId: 's', startSeconds: 0, endSeconds: 6, segments: [] };
    o.audio = { ...o.audio, startSeconds: 1 };
    await expect(reviewAudio(o)).rejects.toThrow('範圍不完整');
    o.audio = { ...o.audio, startSeconds: 0 }; o.previous.endSeconds = 5;
    await expect(reviewAudio(o)).rejects.toThrow('範圍不完整');
    expect(fetch).not.toHaveBeenCalled(); expect(o.onUsage).not.toHaveBeenCalled();
  });
  it('完整重聽上一段且在同一請求回傳兩段，校對也做語言檢查並計入輸出預留', async () => {
    const o = options(); o.previous = { id: 'prior', sessionId: 's', startSeconds: 0, endSeconds: 6,
      segments: [{ direction: 'ja-zh', original: '青森に行くつもり', translation: '打算去青森' }] };
    o.startSeconds = 6;
    const corrected = [{ sourceLanguage: 'ja', targetLanguage: 'zh', original: '青森に行くつもり', translation: '沒有打算去青森' }];
    respond([{ sourceLanguage: 'ja', targetLanguage: 'zh', original: 'はありません。', translation: '。' }], undefined, 'STOP', corrected);
    const result = await reviewAudio(o);
    expect(result.previousSegments![0].translation).toContain('沒有');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.contents[0].parts[0].text).toContain('ENTIRE previous interval [0.000, 6.000)');
    expect(body.contents[0].parts[0].text).toContain('negation');
    expect(body.generationConfig.responseJsonSchema.required).toContain('previousSegments');
    expect(body.generationConfig.maxOutputTokens).toBe(4096);
    expect(o.onUsage).toHaveBeenCalledWith(expect.objectContaining({ outputTokens: 4096 }));
    respond([], undefined, 'STOP', [{ ...corrected[0], translation: '青森に行くつもり' }]);
    await expect(reviewAudio(o)).rejects.toThrow('目標');
    respond([]); await expect(reviewAudio(o)).rejects.toThrow('格式');
  });
  it('不接受假裝是中文的日文譯文，並在 schema 中要求目標語言', async () => {
    respond([{ sourceLanguage: 'ja', targetLanguage: 'zh', original: '青森に行きます。', translation: '青森に行きます。' }]);
    await expect(reviewAudio(options())).rejects.toThrow('目標');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.generationConfig.responseJsonSchema.properties.segments.items.required).toContain('targetLanguage');
  });
  it('傳送實際 WAV（含安靜樣本），不依賴辨識稿；開關外不增加錄音裝置', async () => {
    respond([{ sourceLanguage: 'zh', original: '下周二去青森。', translation: '来週火曜日に青森へ行きます。' }]);
    const o = options(); const { segments: result } = await reviewAudio(o);
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
    const { segments: result } = await reviewAudio(options());
    expect(result.map(s => s.direction)).toEqual(['ja-zh', 'zh-ja']);
    expect(result[0].original).toContain('来週'); expect(result[0].translation).toContain('下週');
    expect(result[1].original).toBe('謝謝。');
  });

  it('靜音可回傳空段落；無效語言或不完整回覆不能顯示成校正成功', async () => {
    respond(); expect(await reviewAudio(options())).toEqual({ segments: [] });
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
