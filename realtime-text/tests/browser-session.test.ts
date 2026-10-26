import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTranslationSession } from '../src/lib/session';
import type { ServerMessage } from '../shared/protocol';

function harness(budgetUsd?: number) {
  const events: ServerMessage[] = [];
  let audio!: (data: ArrayBuffer) => void;
  let callbacks!: { onInterim: (text: string) => void; onFinal: (text: string) => void; onError: (text: string) => void };
  const capture = { prepare: vi.fn(async () => {}), start: vi.fn(async (next: typeof audio) => { audio = next; }), stop: vi.fn(async () => {}) };
  const stt = { connect: vi.fn(async () => {}), sendAudio: vi.fn(() => true), endAudio: vi.fn(() => callbacks.onFinal('最後一句')), close: vi.fn() };
  const translate = vi.fn(async options => {
    options.onUsage('完整提示與前文', '訳文', 10, 2);
    options.onChunk('訳文'); return { text: '訳文' };
  });
  const session = new BrowserTranslationSession({ apiKey: 'fake-key', direction: 'zh-ja', mode: 'saving', budgetUsd }, event => events.push(event), {
    capture, createSTT: next => { callbacks = next; return stt; }, translate,
  });
  return { session, events, capture, stt, translate, get callbacks() { return callbacks; }, audio: (data: ArrayBuffer) => audio(data) };
}
afterEach(() => vi.useRealTimers());

describe('純前端場次生命週期', () => {
  it('連續開始不會重複取得麥克風或建立兩條連線', async () => {
    const h = harness(); await Promise.all([h.session.start(), h.session.start()]);
    expect(h.capture.prepare).toHaveBeenCalledOnce(); expect(h.stt.connect).toHaveBeenCalledOnce();
    h.session.dispose();
  });
  it('啟動、收到草稿、停止前收尾定稿與譯文，停止後沒有新請求', async () => {
    vi.useFakeTimers();
    const h = harness(); await h.session.start();
    h.audio(new ArrayBuffer(3200));
    h.callbacks.onInterim('最後'); await vi.advanceTimersByTimeAsync(1);
    const stopped = h.session.stop(); await vi.advanceTimersByTimeAsync(2000); await stopped;
    expect(h.capture.stop).toHaveBeenCalled(); expect(h.stt.endAudio).toHaveBeenCalledOnce();
    expect(h.events.some(event => event.type === 'translation' && event.final)).toBe(true);
    expect(h.events.some(event => event.type === 'status' && event.status === 'stopped')).toBe(true);
    const count = h.events.length;
    h.callbacks.onInterim('late'); h.audio(new ArrayBuffer(3200)); await vi.advanceTimersByTimeAsync(5000);
    expect(h.events).toHaveLength(count);
  });

  it('等待麥克風權限時也能停止，權限晚到不會建立語音連線', async () => {
    const h = harness(); let grant!: () => void;
    h.capture.prepare.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const started = h.session.start(); await h.session.stop(); grant(); await started;
    expect(h.stt.connect).not.toHaveBeenCalled();
  });

  it('短停頓未完句接續修正同一字幕，翻譯沿用完整句與相同段落 ID', async () => {
    vi.useFakeTimers();
    const h = harness(); await h.session.start();
    h.callbacks.onFinal('我今天想要'); await vi.advanceTimersByTimeAsync(10);
    h.callbacks.onInterim('買十五個');
    h.callbacks.onFinal('買五十個。'); await vi.advanceTimersByTimeAsync(1600);
    const transcripts = h.events.filter(event => event.type === 'transcript');
    expect(new Set(transcripts.map(event => event.captionId)).size).toBe(1);
    expect(new Set(transcripts.map(event => event.paragraphId)).size).toBe(1);
    expect(transcripts.at(-1)?.text).toBe('我今天想要買五十個。');
    expect(h.translate.mock.calls.at(-1)?.[0].text).toBe('我今天想要買五十個。');
    expect(h.translate.mock.calls.length).toBeLessThanOrEqual(2);
    h.session.dispose();
  });

  it('達預算後中斷串流，沒有新音訊與翻譯', async () => {
    vi.useFakeTimers(); const h = harness(0.000001); await h.session.start();
    h.audio(new ArrayBuffer(3200));
    const sent = h.stt.sendAudio.mock.calls.length;
    h.audio(new ArrayBuffer(3200)); h.callbacks.onInterim('測試'); await vi.advanceTimersByTimeAsync(2000);
    expect(h.stt.sendAudio).toHaveBeenCalledTimes(sent);
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.events.some(event => event.type === 'error' && event.message.includes('上限'))).toBe(true);
  });

  it('斷線明確報錯並釋放收音，不會自動重連', async () => {
    const h = harness(); await h.session.start(); h.callbacks.onError('網路斷線');
    expect(h.capture.stop).toHaveBeenCalledWith(false);
    expect(h.stt.close).toHaveBeenCalledOnce(); expect(h.stt.connect).toHaveBeenCalledOnce();
  });
});
