import { afterEach, describe, expect, it, vi } from 'vitest';
import { PACES, PRICES, QUALITY_MODELS, pricesFor } from '../src/lib/config';
import { PhraseBoundaries } from '../src/audio/phrase-boundaries';
import { reviewAudio, reviewCost, reviewPrompt, type ReviewOptions } from '../src/lib/audio-review';
import { streamTranslation, translationPrompt } from '../src/lib/translator';
import { RecentAudio } from '../src/audio/recent-audio';
import { UsageTracker } from '../src/lib/usage';
import { recentPairs } from '../src/lib/guidance';
import { PrecisionTranslationSession } from '../src/lib/precision-session';
import type { ServerMessage } from '../shared/protocol';

afterEach(() => vi.unstubAllGlobals());
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const pcm = (seconds: number, value = 1000) => new Int16Array(Math.round(seconds * 16000)).fill(value).buffer;

function review(quality?: 'economy' | 'quality'): ReviewOptions {
  const buffer = new RecentAudio(); buffer.append(pcm(13, 5));
  return { audio: buffer.snapshot()!, startSeconds: 0, endSeconds: 12,
    settings: { apiKey: 'test-review-key', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving', quality },
    signal: new AbortController().signal, beforeRequest: vi.fn(() => true), onUsage: vi.fn() };
}
const reply = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ segments: [] }) }] }, finishReason: 'STOP' }] }));

describe('翻譯品質、出字速度與前後一致', () => {
  it('高品質使用較強的模型與它支援的最低思考量；價格在官方公告的日期加倍', () => {
    expect(QUALITY_MODELS.economy).toMatchObject({ model: 'gemini-3.1-flash-lite', thinkingLevel: 'minimal' });
    expect(QUALITY_MODELS.quality).toMatchObject({ model: 'gemini-3.8-flash', thinkingLevel: 'low' });
    expect(pricesFor()).toBe(PRICES); expect(pricesFor('economy')).toBe(PRICES);
    expect(pricesFor('quality', Date.UTC(2026, 11, 31, 23))).toMatchObject({ textInputPerMillion: .75, audioInputPerMillion: .75, textOutputPerMillion: 3.75, sttPerMinute: PRICES.sttPerMinute });
    expect(pricesFor('quality', Date.UTC(2027, 0, 1))).toMatchObject({ textInputPerMillion: 1.5, audioInputPerMillion: 1.5, textOutputPerMillion: 7.5 });
    const usage = { inputTokens: 1_000_000, audioTokens: 400_000, outputTokens: 100_000, estimated: false };
    expect(reviewCost(usage)).toBeCloseTo(.6 * .25 + .4 * .5 + .1 * 1.5);
    expect(reviewCost(usage, pricesFor('quality', 0))).toBeCloseTo(.75 + .375);
  });

  it('原音翻譯與文字翻譯都依品質設定選模型；費用用同一組價格估算', async () => {
    const audio = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply()); vi.stubGlobal('fetch', audio);
    await reviewAudio(review()); await reviewAudio(review('quality'));
    expect(String(audio.mock.calls[0][0])).toContain('/models/gemini-3.1-flash-lite:generateContent');
    expect(String(audio.mock.calls[1][0])).toContain('/models/gemini-3.8-flash:generateContent');
    expect(JSON.parse(audio.mock.calls[0][1]!.body as string).generationConfig.thinkingConfig.thinkingLevel).toBe('minimal');
    expect(JSON.parse(audio.mock.calls[1][1]!.body as string).generationConfig.thinkingConfig.thinkingLevel).toBe('low');

    const text = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('data: ' + JSON.stringify({ candidates: [{
      content: { parts: [{ text: JSON.stringify({ original: '你好', translation: 'こんにちは', corrections: [] }) }] }, finishReason: 'STOP' }] }) + '\n\n'));
    vi.stubGlobal('fetch', text);
    await streamTranslation({ apiKey: 'k', text: '你好', context: '', direction: 'zh-ja', quality: 'quality',
      signal: new AbortController().signal, onChunk: vi.fn(), onUsage: vi.fn() });
    expect(String(text.mock.calls[0][0])).toContain('/models/gemini-3.8-flash:streamGenerateContent');
    expect(JSON.parse(text.mock.calls[0][1]!.body as string).generationConfig.thinkingConfig.thinkingLevel).toBe('low');

    const cheap = new UsageTracker(), strong = new UsageTracker(pricesFor('quality', 0));
    for (const tracker of [cheap, strong]) tracker.record('a', '', '', 1_000_000, 1_000_000);
    expect(cheap.snapshot().estimatedUsd).toBeCloseTo(.25 + 1.5); expect(strong.snapshot().estimatedUsd).toBeCloseTo(.75 + 3.75);
  });

  it('快速節奏較早切段，停頓與後文規則不變；無效設定會被拒絕', () => {
    expect(PACES.standard).toMatchObject({ minSeconds: 12, maxSeconds: 20, lookaheadSeconds: 3 });
    const fast = new PhraseBoundaries(PACES.fast), standard = new PhraseBoundaries();
    expect(fast.append(pcm(13.9))).toEqual([]); expect(fast.append(pcm(.1))).toEqual([12]);
    expect(standard.append(pcm(14))).toEqual([]);
    const pause = new PhraseBoundaries(PACES.fast);
    pause.append(pcm(6)); pause.append(pcm(.7, 0));
    const cuts = pause.append(pcm(2, 4));
    expect(cuts).toHaveLength(1); expect(cuts[0]).toBeCloseTo(6.35);
    expect(() => new PhraseBoundaries({ minSeconds: 10, maxSeconds: 5, lookaheadSeconds: 1 })).toThrow();
  });

  it('先前的原文與譯文對照有數量與長度上限，空的不帶入；提示要求沿用譯名但不重複輸出', () => {
    const many = Array.from({ length: 10 }, (_, i) => [`原文${i}`, `訳${i}`] as [string, string]);
    expect(recentPairs(many)).toEqual(many.slice(-6));
    expect(recentPairs([['', '空'], ['有', ''], ['留下', '残す']])).toEqual([['留下', '残す']]);
    expect(recentPairs([['短', '短い'], ['長'.repeat(500), '長'.repeat(500)]])).toHaveLength(1);
    expect(recentPairs([['長'.repeat(900), '長'.repeat(900)]])[0][0]).toHaveLength(350);
    const prompt = reviewPrompt(review(), { ...review().settings, recent: [['國立中央大學', '国立中央大学']] });
    expect(prompt).toContain('RECENT lists earlier'); expect(prompt).toContain('never output them again');
    expect(JSON.parse(prompt.slice(prompt.lastIndexOf('REFERENCE DATA ONLY: ') + 21)).recent).toEqual([['國立中央大學', '国立中央大学']]);
    expect(reviewPrompt(review(), review().settings)).not.toContain('RECENT');
    const text = translationPrompt('我在中央大學', '', 'zh-ja', [], '', [], 'zh-ja', undefined, undefined, [['中央大學', '中央大学']]);
    expect(text).toContain('RECENT lists earlier'); expect(text).toContain('"recent":[["中央大學","中央大学"]]');
    expect(translationPrompt('你好', '', 'zh-ja')).not.toContain('"recent"');
  });

  it('精準場次：快速節奏約 6–12 秒送出，下一段帶著前面的譯文，高品質以對應價格計費', async () => {
    const events: ServerMessage[] = []; let audio!: (chunk: ArrayBuffer) => void;
    const capture = { prepare: vi.fn(async () => {}), start: vi.fn(async (next: typeof audio) => { audio = next; }), stop: vi.fn(async () => {}) };
    const usage = { inputTokens: 1000, audioTokens: 400, outputTokens: 100, estimated: false };
    const sentRecent: unknown[] = [];
    const request = vi.fn(async options => {
      // 設定物件在場次中會更新，這裡記下送出當下帶的內容。
      sentRecent.push(structuredClone(options.settings.recent));
      options.onUsage(usage);
      return { segments: [{ direction: 'zh-ja' as const, original: '我在國立中央大學', translation: '国立中央大学にいます' }],
        ...(options.previous ? { previousSegments: options.previous.segments } : {}) };
    });
    const session = new PrecisionTranslationSession({ apiKey: 'fake', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving', pace: 'fast', quality: 'quality',
      recent: [['早安', 'おはようございます']] }, event => events.push(event), { capture, reviewAudio: request });
    await session.start();
    expect(events.find(event => event.type === 'status' && event.status === 'listening')).toMatchObject({ message: expect.stringContaining('6–12 秒') });
    audio(pcm(13.9)); expect(request).not.toHaveBeenCalled();
    audio(pcm(.1)); await settle();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toMatchObject({ startSeconds: 0, endSeconds: 12, audio: { endSeconds: 14 } });
    expect(sentRecent[0]).toEqual([['早安', 'おはようございます']]);
    audio(pcm(12)); await settle();
    expect(sentRecent[1]).toEqual([['早安', 'おはようございます'], ['我在國立中央大學', '国立中央大学にいます']]);
    const total = events.filter(event => event.type === 'usage').at(-1)!.usage;
    expect(total.estimatedUsd).toBeCloseTo(2 * reviewCost(usage, pricesFor('quality')));
    session.dispose();
  });
});
