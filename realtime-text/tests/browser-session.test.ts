import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTranslationSession } from '../src/lib/session';
import type { LanguagePair, ServerMessage } from '../shared/protocol';
import { captionHistory } from '../src/lib/history';
import { defaultDirection } from '../src/lib/languages';
import { twdBudgetToUsd, usdToTwd } from '../src/lib/currency';
import type { Caption } from '../src/lib/types';

function harness(budgetUsd?: number, context?: string, pair?: LanguagePair) {
  const events: ServerMessage[] = [];
  let audio!: (data: ArrayBuffer) => void;
  let callbacks!: { onInterim: (text: string, languageCode?: string) => void; onFinal: (text: string, languageCode?: string) => void; onError: (text: string) => void };
  let captureError: ((message: string) => void) | undefined;
  const capture = { prepare: vi.fn(async () => {}), start: vi.fn(async (next: typeof audio, onError?: (message: string) => void) => { audio = next; captureError = onError; }), stop: vi.fn(async () => {}) };
  const stt = { connect: vi.fn(async () => {}), sendAudio: vi.fn(() => true), endAudio: vi.fn(() => callbacks.onFinal('最後一句')), close: vi.fn() };
  const translate = vi.fn(async options => {
    options.onUsage('完整提示與前文', '訳文', 10, 2);
    options.onChunk('訳文'); return { text: '訳文' };
  });
  const session = new BrowserTranslationSession({ apiKey: 'fake-key', direction: pair ? defaultDirection(pair) : 'zh-ja', pair, mode: 'saving', budgetUsd, context }, event => events.push(event), {
    capture, createSTT: next => { callbacks = next; return stt; }, translate,
  });
  return { session, events, capture, stt, translate, get callbacks() { return callbacks; }, audio: (data: ArrayBuffer) => audio(data), captureError: (message: string) => captureError?.(message) };
}
afterEach(() => vi.useRealTimers());

describe('純前端場次生命週期', () => {
  it('等待第一包音訊時不宣稱聆聽中，收音啟動失敗會釋放連線', async () => {
    const h = harness(); let rejectCapture!: (error: Error) => void;
    h.capture.start.mockImplementation(() => new Promise((_resolve, reject) => { rejectCapture = reject; }));
    const starting = h.session.start();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.events.some(event => event.type === 'status' && event.status === 'listening')).toBe(false);
    rejectCapture(new Error('沒有送出音訊')); await starting;
    expect(h.events.some(event => event.type === 'error' && event.message.includes('沒有送出音訊'))).toBe(true);
    expect(h.stt.close).toHaveBeenCalled(); expect(h.capture.stop).toHaveBeenCalledWith(false);
  });

  it('音量依送出的 PCM 更新；有聲音但無辨識回覆時提示，恢復文字後解除提示', async () => {
    vi.useFakeTimers(); const h = harness(); await h.session.start();
    h.audio(new ArrayBuffer(3200));
    expect(h.events.find(event => event.type === 'audio-level')).toMatchObject({ level: 0 });
    await vi.advanceTimersByTimeAsync(16000);
    for (let i = 0; i < 21; i++) h.audio(new Int16Array(1600).fill(2000).buffer);
    expect(h.events.filter(event => event.type === 'warning')).toHaveLength(1);
    expect(h.events.some(event => event.type === 'audio-level' && event.level > 0)).toBe(true);
    h.callbacks.onInterim('測試');
    expect(h.events.some(event => event.type === 'status' && event.message?.includes('已收到辨識文字'))).toBe(true);
    h.session.dispose();
  });

  it('音軌或處理器中斷會停止，停止後的中斷事件不能重新改寫狀態', async () => {
    const h = harness(); await h.session.start(); h.captureError('麥克風已中斷');
    expect(h.events.some(event => event.type === 'error' && event.message === '麥克風已中斷')).toBe(true);
    expect(h.capture.stop).toHaveBeenCalledWith(false);
    const count = h.events.length; h.captureError('晚到的事件'); expect(h.events).toHaveLength(count);
  });

  it('收得到 PCM 但無法送到辨識服務時立即停止，不能顯示零用量繼續計時', async () => {
    const h = harness(); await h.session.start(); h.stt.sendAudio.mockReturnValue(false);
    h.audio(new ArrayBuffer(3200));
    expect(h.events.some(event => event.type === 'error' && event.message.includes('未能傳送'))).toBe(true);
    expect(h.capture.stop).toHaveBeenCalledWith(false);
  });

  it('先依聲音標記處理純漢字日文，同句定稿沿用標記，下句中文不沿用上一句日文', async () => {
    vi.useFakeTimers(); const h=harness(undefined,undefined,'zh-ja');
    h.translate.mockImplementation(async options=>({original:options.text,text:'譯文',direction:options.direction}));
    await h.session.start(); h.callbacks.onInterim('青森大学','ja-JP'); await vi.advanceTimersByTimeAsync(10);
    h.callbacks.onFinal('青森大学'); await vi.advanceTimersByTimeAsync(1600);
    const first=h.events.find(event=>event.type==='transcript');
    expect(first).toMatchObject({text:'青森大学',direction:'ja-zh'});
    expect(h.translate.mock.calls[0][0].audioLanguage).toBe('ja');
    h.callbacks.onFinal('今天去慶生。','cmn-Hans-CN'); await vi.advanceTimersByTimeAsync(1600);
    expect(h.translate.mock.calls.at(-1)?.[0]).toMatchObject({direction:'zh-ja',audioLanguage:'zh'});
    h.session.dispose();
  });
  it.each([
    {pair:'zh-ja' as const, turns:[{text:'下周二去青森',direction:'zh-ja',translation:'来週火曜日に青森へ行きます。'},
      {text:'来週火曜日に青森へ行きます。',direction:'ja-zh',translation:'下周二去青森。'}]},
    {pair:'zh-en' as const, turns:[{text:'下周二出发',direction:'zh-en',translation:'We leave next Tuesday.'},
      {text:'We leave next Tuesday.',direction:'en-zh',translation:'下周二出发。'}]},
    {pair:'ja-en' as const, turns:[{text:'来週出発します',direction:'ja-en',translation:'We leave next week.'},
      {text:'We leave next week.',direction:'en-ja',translation:'来週出発します。'}]},
  ])('$pair 同一條收音連線雙向輪流翻譯，保留各句方向與日文漢字', async ({pair, turns}) => {
    vi.useFakeTimers(); const h = harness(undefined,undefined,pair);
    h.translate.mockImplementation(async options => {
      const turn = turns.find(item=>item.text===options.text)!;
      options.onChunk(turn.translation, turn.direction);
      return {text:turn.translation,original:turn.text,direction:turn.direction};
    });
    await h.session.start();
    for (const turn of turns) { h.callbacks.onFinal(turn.text); await vi.advanceTimersByTimeAsync(1600); }
    expect(h.stt.connect).toHaveBeenCalledOnce();
    expect(h.stt.connect).toHaveBeenCalledWith('fake-key',[],undefined);
    expect(h.capture.start).toHaveBeenCalledOnce();
    expect(h.translate).toHaveBeenCalledTimes(2);
    expect(h.translate.mock.calls.map(call=>call[0].text)).toEqual(turns.map(turn=>turn.text));
    let history: Caption[] = [];
    for (const event of h.events) history = captionHistory(history,{type:'message',event,direction:defaultDirection(pair)});
    expect(history).toHaveLength(2);
    expect(history.map(item=>item.direction)).toEqual(turns.map(turn=>turn.direction));
    expect(history.every(item=>item.translationFinal)).toBe(true);
    for (const item of history) {
      if (item.direction.startsWith('ja-')) expect(item.original).toContain('来週');
      if (item.direction.endsWith('-zh')) expect(item.translation).toContain('下週');
    }
    h.session.dispose();
  });

  it('AI 可重新判斷只有漢字的日文，還原日文字形及正確翻譯方向', async () => {
    vi.useFakeTimers(); const h = harness(undefined,undefined,'zh-ja');
    h.translate.mockImplementation(async () => ({original:'青森大学',text:'青森大學',direction:'ja-zh'}));
    await h.session.start(); h.callbacks.onFinal('青森大学'); await vi.advanceTimersByTimeAsync(10);
    const correction = h.events.find(event=>event.type==='caption-correction');
    expect(correction).toMatchObject({original:'青森大学',translation:'青森大學',direction:'ja-zh'});
    h.session.dispose();
  });

  it('雙向上下文校正沿用被校正句自己的方向，不套用目前另一位說話者的方向', async () => {
    vi.useFakeTimers(); const h = harness(undefined,undefined,'zh-ja');
    h.translate.mockImplementation(async options => {
      if (!options.text.includes('弘前')) return {original:options.text,text:'お祝いに行きます。',direction:'zh-ja'};
      const previous = options.review[0];
      return {original:options.text,text:'我們要去弘前城。',direction:'ja-zh',corrections:[{
        captionId:previous.captionId,revision:previous.revision,original:'下週二去青森',translation:'来週火曜日に青森へ行きます。',
        confidence:'high',sourceLanguage:'zh',evidence:'後句日文提到青森的弘前城',
      }]};
    });
    await h.session.start(); h.callbacks.onFinal('下週二去慶生'); await vi.advanceTimersByTimeAsync(1600);
    h.callbacks.onFinal('青森の弘前城に行きます。'); await vi.advanceTimersByTimeAsync(1600);
    expect(h.events.filter(event=>event.type==='caption-correction')).toContainEqual(expect.objectContaining({
      direction:'zh-ja', original:'下週二去青森',translation:'来週火曜日に青森へ行きます。',
    }));
    h.session.dispose();
  });

  it('以台幣設定的預算達到後停止，不能誤當成美元上限', async () => {
    const rate = 32.58; const h = harness(twdBudgetToUsd('1', rate),undefined,'zh-ja'); await h.session.start();
    for (let i=0; i<205; i++) h.audio(new ArrayBuffer(32000));
    expect(h.events.some(event=>event.type==='error' && event.message.includes('上限'))).toBe(true);
    const usage = h.events.filter(event=>event.type==='usage').at(-1)!;
    expect(usdToTwd(usage.usage.estimatedUsd,rate)).toBeGreaterThanOrEqual(1);
    expect(usdToTwd(usage.usage.estimatedUsd,rate)).toBeLessThan(1.01);
    h.session.dispose();
  });
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
