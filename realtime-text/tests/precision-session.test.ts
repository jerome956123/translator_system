import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrecisionTranslationSession } from '../src/lib/precision-session';
import type { ServerMessage } from '../shared/protocol';
import { captionHistory } from '../src/lib/history';
import { reviewCost } from '../src/lib/audio-review';

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function harness(budgetUsd?: number) {
  const events: ServerMessage[] = [];
  let audio!: (chunk: ArrayBuffer) => void;
  const capture = { prepare: vi.fn(async () => {}), start: vi.fn(async (next: typeof audio) => { audio = next; }), stop: vi.fn(async () => {}) };
  const reviewAudio = vi.fn(async options => {
    const usage = { inputTokens: 516, audioTokens: 416, outputTokens: 20, estimated: false };
    if (!options.beforeRequest(usage)) throw new Error('預算不足');
    options.onUsage(usage);
    return [{ direction: 'ja-zh' as const, original: '来週、青森に行きます。', translation: '下週要去青森。' }];
  });
  const session = new PrecisionTranslationSession({ apiKey: 'fake', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving', budgetUsd },
    event => events.push(event), { capture, reviewAudio });
  return { session, events, capture, reviewAudio, audio: (seconds: number, value = 5) => audio(new Int16Array(Math.round(seconds * 16000)).fill(value).buffer) };
}
afterEach(() => vi.unstubAllGlobals());

describe('以原音翻譯作為唯一主流程', () => {
  it('不建立 Live 連線或文字串流，13 秒後完成的日文→中文結果直接進入主紀錄', async () => {
    const socket = vi.fn(() => { throw new Error('unexpected Live'); }), fetcher = vi.fn();
    vi.stubGlobal('WebSocket', socket); vi.stubGlobal('fetch', fetcher);
    const h = harness(); await h.session.start(); h.audio(12); expect(h.reviewAudio).not.toHaveBeenCalled();
    h.audio(1); await settle();
    expect(h.reviewAudio).toHaveBeenCalledOnce(); expect(socket).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    const history = h.events.reduce((items, event) => captionHistory(items, { type: 'message', event, direction: 'zh-ja' }), [] as Parameters<typeof captionHistory>[0]);
    expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ origin: 'precision', direction: 'ja-zh', original: '来週、青森に行きます。', translation: '下週要去青森。', translationFinal: true });
    expect(h.capture.start).toHaveBeenCalledOnce(); h.session.dispose();
  });

  it('原音與文字用量會計費，但不加上未使用的 Live 辨識費；後續片段帶入前文', async () => {
    const h = harness(); await h.session.start(); h.audio(13); await settle();
    const usage = h.events.filter(event => event.type === 'usage').at(-1)!.usage;
    expect(usage).toMatchObject({ audioSeconds: 13, translationRequests: 0, reviewRequests: 1, reviewAudioSeconds: 13 });
    expect(usage.estimatedUsd).toBeCloseTo(reviewCost({ inputTokens: 516, audioTokens: 416, outputTokens: 20, estimated: false }));
    h.audio(12); await settle(); expect(h.reviewAudio.mock.calls[1][0].settings.context).toContain('青森');
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
    const h = harness(.000001); await h.session.start(); h.audio(13); await settle();
    expect(h.events.some(event => event.type === 'error' && event.message.includes('預算'))).toBe(true);
    expect(h.capture.stop).toHaveBeenCalledWith(false); expect(h.session.snapshotAudio()).toBeDefined();
    const failed = harness(); failed.reviewAudio.mockRejectedValueOnce(new Error('model failed'));
    await failed.session.start(); failed.audio(13); await settle(); failed.audio(13); await settle();
    expect(failed.reviewAudio).toHaveBeenCalledOnce(); expect(failed.events.some(event => event.type === 'error')).toBe(true);
  });

  it('取消準備或晚到回覆不能重新啟動收音／改寫已清除紀錄', async () => {
    const h = harness(); let prepared!: () => void;
    h.capture.prepare.mockImplementationOnce(() => new Promise(resolve => { prepared = resolve; }));
    const opening = h.session.start(); await h.session.stop(); prepared(); await opening;
    expect(h.capture.start).not.toHaveBeenCalled();
    const late = harness(); let complete!: () => void;
    late.reviewAudio.mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve([{ direction: 'ja-zh', original: '青森', translation: '青森' }]); }));
    await late.session.start(); late.audio(13); late.session.dispose(); const count = late.events.length;
    complete(); await settle(); expect(late.events).toHaveLength(count);
  });
});
