import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTranslationSession } from '../src/lib/session';
import type { ServerMessage } from '../shared/protocol';

function harness(budgetUsd?: number, context?: string) {
  const events: ServerMessage[] = [];
  let audio!: (data: ArrayBuffer) => void;
  let callbacks!: { onInterim: (text: string) => void; onFinal: (text: string) => void; onError: (text: string) => void };
  const capture = { prepare: vi.fn(async () => {}), start: vi.fn(async (next: typeof audio) => { audio = next; }), stop: vi.fn(async () => {}) };
  const stt = { connect: vi.fn(async () => {}), sendAudio: vi.fn(() => true), endAudio: vi.fn(() => callbacks.onFinal('最後一句')), close: vi.fn() };
  const translate = vi.fn(async options => {
    options.onUsage('完整提示與前文', '訳文', 10, 2);
    options.onChunk('訳文'); return { text: '訳文' };
  });
  const session = new BrowserTranslationSession({ apiKey: 'fake-key', direction: 'zh-ja', mode: 'saving', budgetUsd, context }, event => events.push(event), {
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

  it('初稿先轉繁體，後句提供線索時同時回頭修正原文與譯文', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.translate.mockImplementation(async options => {
      if (!options.text.includes('弘前')) return {text:'来週火曜日にお祝いに行きます。',original:options.text};
      const previous = options.review[0];
      return {text:'弘前城へ行きます。', original:options.text, corrections:[{
        captionId:previous.captionId,revision:previous.revision,original:'下周二要去青森。',
        translation:'来週火曜日に青森へ行きます。',confidence:'high',evidence:'後句提到日本東北的弘前城',
      }]};
    });
    await h.session.start();
    h.callbacks.onFinal('下周二要去庆生。'); await vi.advanceTimersByTimeAsync(10);
    const first = h.events.find(event => event.type === 'transcript');
    expect(first?.type === 'transcript' && first.text).toBe('下週二要去慶生。');
    h.callbacks.onFinal('我們要去日本東北的弘前城。'); await vi.advanceTimersByTimeAsync(1600);
    const edits = h.events.filter(event => event.type === 'caption-correction');
    expect(edits.some(event => event.captionId === (first?.type === 'transcript' ? first.captionId : '')
      && event.original === '下週二要去青森。' && event.translation.includes('青森'))).toBe(true);
    expect(h.translate).toHaveBeenCalledTimes(2);
    h.session.dispose();
  });

  it('不接受未提供的紀錄或過時修訂編號，即使模型要求校正', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.translate.mockImplementation(async options => ({text:'訳文',original:options.text,corrections:[
      {captionId:'別人的紀錄',revision:1,original:'錯誤',translation:'wrong',confidence:'high',evidence:'假線索'},
      ...(options.review?.map((item: {captionId:string;revision:number}) => ({...item,revision:item.revision+1,
        original:'錯誤',translation:'wrong',confidence:'high',evidence:'假線索'})) ?? []),
    ]}));
    await h.session.start(); h.callbacks.onFinal('第一句。'); await vi.advanceTimersByTimeAsync(10);
    h.callbacks.onFinal('第二句。'); await vi.advanceTimersByTimeAsync(1600);
    expect(h.events.filter(event => event.type === 'caption-correction').some(event=>event.original==='錯誤')).toBe(false);
    h.session.dispose();
  });

  it('舊句翻譯晚到，不能把已更新的草稿改回舊原文', async () => {
    vi.useFakeTimers();
    const h = harness(); let finish!: (value: {text:string;original:string}) => void;
    h.translate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await h.session.start(); h.callbacks.onInterim('我要去慶生'); await vi.advanceTimersByTimeAsync(1);
    h.callbacks.onInterim('我要去青森旅遊');
    finish({text:'旧訳',original:'我要去慶生'}); await vi.advanceTimersByTimeAsync(1);
    expect(h.events.filter(event => event.type === 'caption-correction')).toHaveLength(0);
    h.session.dispose();
  });

  it('換語言開新場次時，延續提供少量先前對話作為語意背景', async () => {
    vi.useFakeTimers();
    const h = harness(undefined, '繁體中文: 我們下週二要去青森。');
    await h.session.start(); h.callbacks.onFinal('之後去弘前。'); await vi.advanceTimersByTimeAsync(10);
    expect(h.translate.mock.calls[0][0].context).toContain('下週二要去青森');
    h.session.dispose();
  });

  it('斷線明確報錯並釋放收音，不會自動重連', async () => {
    const h = harness(); await h.session.start(); h.callbacks.onError('網路斷線');
    expect(h.capture.stop).toHaveBeenCalledWith(false);
    expect(h.stt.close).toHaveBeenCalledOnce(); expect(h.stt.connect).toHaveBeenCalledOnce();
  });
});
