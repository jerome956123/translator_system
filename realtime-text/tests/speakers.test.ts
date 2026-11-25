import { afterEach, describe, expect, it, vi } from 'vitest';
import { reviewAudio, reviewPrompt, type ReviewOptions } from '../src/lib/audio-review';
import { RecentAudio } from '../src/audio/recent-audio';
import { PrecisionTranslationSession, speakerNote } from '../src/lib/precision-session';
import type { PrecisionSegment, ServerMessage } from '../shared/protocol';
import { captionHistory } from '../src/lib/history';
import { exportParagraphs, groupCaptions, SPEAKER_TURN_MAX_CHARS } from '../src/lib/paragraphs';
import { loadCaptions, saveCaptions } from '../src/lib/history-store';
import { speakersPreference } from '../src/lib/preferences';
import type { Caption } from '../src/lib/types';

function options(speakers = true): ReviewOptions {
  const buffer = new RecentAudio(); buffer.append(new Int16Array(16000 * 13).fill(5).buffer);
  return { audio: buffer.snapshot()!, startSeconds: 0, endSeconds: 12,
    settings: { apiKey: 'test-review-key', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving', ...(speakers ? { speakers: true } : {}) },
    signal: new AbortController().signal, beforeRequest: vi.fn(() => true), onUsage: vi.fn() };
}
function respond(segments: unknown[] = [], previousSegments?: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candidates: [{
    content: { parts: [{ text: JSON.stringify({ segments, previousSegments }) }] }, finishReason: 'STOP' }] }))));
}
const requestBody = () => JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
function memory() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); } };
}
afterEach(() => vi.unstubAllGlobals());

describe('精準模式的講者標示（試作）：請求內容', () => {
  it('沒有開啟時，請求與提示詞都不出現講者欄位', async () => {
    respond([{ sourceLanguage: 'zh', targetLanguage: 'ja', original: '你好。', translation: 'こんにちは。', speaker: 'A' }]);
    const o = options(false); const { segments } = await reviewAudio(o);
    const body = requestBody(); const items = body.generationConfig.responseJsonSchema.properties.segments.items;
    expect(items.properties.speaker).toBeUndefined();
    expect(items.required).toEqual(['sourceLanguage', 'targetLanguage', 'original', 'translation']);
    expect(body.contents[0].parts[0].text).not.toContain('SPEAKERS'); expect(body.contents[0].parts[0].text).not.toContain('lastKnownSpeakers');
    // 沒有要求講者時，即使回覆裡多了這個欄位也不採用。
    expect(segments[0].speaker).toBeUndefined();
  });

  it('開啟後每段都要求講者 A 或 B，欄位排在最前面，並要求依聲音而非語言判斷', async () => {
    respond([{ speaker: 'B', sourceLanguage: 'ja', targetLanguage: 'zh', original: 'はじめまして。', translation: '初次見面。' }]);
    const { segments } = await reviewAudio(options());
    const body = requestBody(); const items = body.generationConfig.responseJsonSchema.properties.segments.items;
    expect(items.properties.speaker).toEqual({ type: 'string', enum: ['A', 'B'] });
    expect(items.required[0]).toBe('speaker'); expect(items.propertyOrdering[0]).toBe('speaker');
    const prompt = body.contents[0].parts[0].text as string;
    expect(prompt).toContain('SPEAKERS'); expect(prompt).toContain('never by language');
    expect(prompt).toContain('continues across the interval boundary keeps the speaker');
    expect(prompt).toContain('the first voice you hear is "A"');
    expect(segments[0]).toMatchObject({ speaker: 'B', direction: 'ja-zh', translation: '初次見面。' });
  });

  it('有前段時把前段的講者標籤一起給，並要求同一個聲音沿用同一個標籤', async () => {
    const o = options(); o.startSeconds = 6;
    o.previous = { id: 'prior', sessionId: 's', startSeconds: 0, endSeconds: 6,
      segments: [{ direction: 'ja-zh', original: 'こんにちは。', translation: '你好。', speaker: 'A' }] };
    const prior = [{ speaker: 'A', sourceLanguage: 'ja', targetLanguage: 'zh', original: 'こんにちは。', translation: '你好。' }];
    respond([{ speaker: 'B', sourceLanguage: 'ja', targetLanguage: 'zh', original: 'どうも。', translation: '你好啊。' }], prior);
    const result = await reviewAudio(o);
    const body = requestBody(); const prompt = body.contents[0].parts[0].text as string;
    expect(prompt).toContain('Keep labels stable'); expect(prompt).toContain('"speaker":"A"');
    expect(body.generationConfig.responseJsonSchema.properties.previousSegments.items.properties.speaker).toBeDefined();
    expect(result.previousSegments![0].speaker).toBe('A'); expect(result.segments[0].speaker).toBe('B');
  });

  it('知道每位講者最近說過的話時放進參考資料；沒有時不放', () => {
    const o = options();
    expect(reviewPrompt(o, o.settings)).not.toContain('lastKnownSpeakers');
    o.settings.speakerNotes = { A: 'zh: 下週要去青森出差。', B: 'ja: 気をつけて。' };
    const prompt = reviewPrompt(o, o.settings);
    expect(prompt).toContain('"lastKnownSpeakers":{"A":"zh: 下週要去青森出差。","B":"ja: 気をつけて。"}');
    expect(prompt).toContain('weaker hint'); expect(prompt).not.toContain('the first voice you hear is "A"');
  });

  it('講者欄位缺少或不合法時照常保留這段翻譯，只是不標示', async () => {
    respond([{ speaker: 'C', sourceLanguage: 'zh', targetLanguage: 'ja', original: '謝謝。', translation: 'ありがとう。' },
      { sourceLanguage: 'ja', targetLanguage: 'zh', original: 'どういたしまして。', translation: '不客氣。' }]);
    const { segments } = await reviewAudio(options());
    expect(segments).toHaveLength(2); expect(segments[0].speaker).toBeUndefined(); expect(segments[1].speaker).toBeUndefined();
    expect(segments[0].translation).toBe('ありがとう。');
  });
});

describe('精準模式的講者標示（試作）：場次與紀錄', () => {
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  function harness(replies: { segments: PrecisionSegment[]; previousSegments?: PrecisionSegment[] }[], speakerNotes?: Record<string, string>) {
    const events: ServerMessage[] = [];
    let audio!: (chunk: ArrayBuffer) => void;
    const capture = { prepare: vi.fn(async () => {}), start: vi.fn(async (next: typeof audio) => { audio = next; }), stop: vi.fn(async () => {}) };
    const seen: { notes?: unknown; previous?: PrecisionSegment[] }[] = [];
    const reviewAudioMock = vi.fn(async request => {
      const usage = { inputTokens: 516, audioTokens: 416, outputTokens: 20, estimated: false };
      request.beforeRequest(usage); request.onUsage(usage);
      seen.push({ notes: structuredClone(request.settings.speakerNotes), previous: request.previous?.segments });
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
      return { segments: reply.segments, ...(request.previous ? { previousSegments: reply.previousSegments ?? request.previous.segments } : {}) };
    });
    const session = new PrecisionTranslationSession({ apiKey: 'fake', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving', speakers: true,
      ...(speakerNotes ? { speakerNotes } : {}) }, event => events.push(event), { capture, reviewAudio: reviewAudioMock });
    const history = () => events.reduce((items, event) => captionHistory(items, { type: 'message', event, direction: 'zh-ja' }), [] as Caption[]);
    return { session, events, seen, history, audio: (seconds: number) => audio(new Int16Array(Math.round(seconds * 16000)).fill(1000).buffer) };
  }

  it('每段字幕帶著講者；下一次請求收到前段的標籤與每位講者最近說的話', async () => {
    const h = harness([
      { segments: [{ direction: 'zh-ja', original: '下週要去青森出差。', translation: '来週、青森へ出張します。', speaker: 'A' },
        { direction: 'ja-zh', original: '気をつけて。', translation: '路上小心。', speaker: 'B' }] },
      { segments: [{ direction: 'ja-zh', original: 'お土産を買ってきてね。', translation: '記得買伴手禮回來。', speaker: 'B' }] },
    ]);
    await h.session.start(); h.audio(23); await settle();
    expect(h.history().map(item => [item.speaker, item.original])).toEqual([['A', '下週要去青森出差。'], ['B', '気をつけて。']]);
    expect(h.seen[0].notes).toBeUndefined();
    h.audio(20); await settle();
    expect(h.seen[1].previous!.map(segment => segment.speaker)).toEqual(['A', 'B']);
    expect(h.seen[1].notes).toEqual({ A: speakerNote('zh-ja', '下週要去青森出差。'), B: speakerNote('ja-zh', '気をつけて。') });
    expect(h.history().map(item => item.speaker)).toEqual(['A', 'B', 'B']); h.session.dispose();
  });

  it('下一段校對只改了前段的講者標籤時，畫面跟著更新，但不標示為文字校正', async () => {
    const first: PrecisionSegment[] = [{ direction: 'ja-zh', original: 'そうですね。', translation: '是啊。', speaker: 'A' }];
    const h = harness([{ segments: first },
      { segments: [{ direction: 'ja-zh', original: '行きましょう。', translation: '走吧。', speaker: 'A' }],
        previousSegments: [{ ...first[0], speaker: 'B' }] }]);
    await h.session.start(); h.audio(23); await settle();
    expect(h.history()[0]).toMatchObject({ speaker: 'A', corrected: false });
    h.audio(20); await settle();
    const items = h.history();
    expect(items[0]).toMatchObject({ speaker: 'B', original: 'そうですね。', translation: '是啊。', corrected: false });
    expect(items[0].previousTranslation).toBeUndefined(); expect(items[1].speaker).toBe('A'); h.session.dispose();
  });

  it('接續先前紀錄開新場次時，帶入先前每位講者最近說的話', async () => {
    const notes = { A: 'zh: 我們繼續。', B: 'ja: はい。' };
    const h = harness([{ segments: [{ direction: 'ja-zh', original: 'では。', translation: '那麼。', speaker: 'B' }] }], notes);
    await h.session.start(); h.audio(23); await settle();
    expect(h.seen[0].notes).toEqual(notes);
    h.audio(20); await settle();
    expect(h.seen[1].notes).toEqual({ A: 'zh: 我們繼續。', B: speakerNote('ja-zh', 'では。') }); h.session.dispose();
  });
});

describe('精準模式的講者標示（試作）：顯示、匯出與保存', () => {
  const caption = (id: string, speaker: Caption['speaker'], original: string, translation: string): Caption => ({
    id, sessionId: 's', direction: 'ja-zh', origin: 'precision', receivedAt: 1, paragraphId: 'p1', revision: 1, original, translation,
    translationRevision: 1, originalFinal: true, translationFinal: true, ...(speaker ? { speaker } : {}) });

  it('同一種語言、同一個段落內換了講者就另起一段；同一位講者的連續字幕仍合併', () => {
    const paragraphs = groupCaptions([caption('w-0', 'A', '明日は', '明天'), caption('w-1', 'A', '晴れです。', '是晴天。'),
      caption('w-2', 'B', 'よかった。', '太好了。'), caption('x-0', 'A', '出かけましょう。', '出門吧。')]);
    expect(paragraphs.map(item => [item.speaker, item.original])).toEqual([['A', '明日は晴れです。'], ['B', 'よかった。'], ['A', '出かけましょう。']]);
  });

  const turn = (id: string, speaker: Caption['speaker'], paragraphId: string, original: string, extra: Partial<Caption> = {}): Caption =>
    ({ ...caption(id, speaker, original, `譯：${original}`), paragraphId, ...extra });

  it('同一位講者的話即使被切成不同段落、不同批次送出，也接在同一格；換人才換格', () => {
    const paragraphs = groupCaptions([
      turn('w1-0', 'A', 'p1', 'Three, being afraid of making mistakes. Four,'),
      turn('w2-0', 'A', 'p2', 'not surrounding yourself with enough English.'),
      turn('w2-1', 'A', 'p2', "If you're making any of these mistakes, don't worry."),
      turn('w3-0', 'B', 'p3', 'Exactly.'),
      turn('w3-1', 'A', 'p3', "Let's start."),
    ]);
    expect(paragraphs.map(item => [item.speaker, item.captions.length])).toEqual([['A', 3], ['B', 1], ['A', 1]]);
    expect(paragraphs[0].original).toBe("Three, being afraid of making mistakes. Four, not surrounding yourself with enough English. If you're making any of these mistakes, don't worry.");
    expect(exportParagraphs(paragraphs, false).split('〔講者').length - 1).toBe(3);
  });

  it('同一位講者換了語言、換了場次，或中間有未翻譯的缺口時仍另起一格', () => {
    const paragraphs = groupCaptions([
      turn('w1-0', 'A', 'p1', 'こんにちは。'),
      turn('w2-0', 'A', 'p2', '你好。', { direction: 'zh-ja' }),
      turn('w3-0', 'A', 'p3', '謝謝。', { direction: 'zh-ja', sessionId: 'next' }),
      turn('g-1', undefined, 'g-1', '', { direction: 'zh-ja', sessionId: 'next', gap: { startSeconds: 0, endSeconds: 5, message: '逾時' } }),
      turn('w4-0', 'A', 'p4', '再見。', { direction: 'zh-ja', sessionId: 'next' }),
    ]);
    expect(paragraphs.map(item => item.captions.map(entry => entry.id))).toEqual([['w1-0'], ['w2-0'], ['w3-0'], ['g-1'], ['w4-0']]);
  });

  it('同一個人講很久時，一格超過長度上限後在下一個段落分界另起一格，同一段落內不切開', () => {
    const long = 'あ'.repeat(SPEAKER_TURN_MAX_CHARS);
    const paragraphs = groupCaptions([
      turn('w1-0', 'A', 'p1', long), turn('w1-1', 'A', 'p1', '同じ段落です。'),
      turn('w2-0', 'A', 'p2', '次の段落です。'), turn('w2-1', 'A', 'p2', '続きです。'),
    ]);
    expect(paragraphs.map(item => item.captions.map(entry => entry.id))).toEqual([['w1-0', 'w1-1'], ['w2-0', 'w2-1']]);
  });

  it('沒有講者標示的紀錄照原本的方式分段，不會因此被合併', () => {
    const plain = groupCaptions([turn('w1-0', undefined, 'p1', '一。'), turn('w2-0', undefined, 'p2', '二。')]);
    expect(plain).toHaveLength(2);
  });

  it('沒有講者標示的紀錄照原本的方式分段', () => {
    const paragraphs = groupCaptions([caption('w-0', undefined, '明日は', '明天'), caption('w-1', undefined, '晴れです。', '是晴天。')]);
    expect(paragraphs).toHaveLength(1); expect(paragraphs[0].speaker).toBeUndefined();
  });

  it('TXT 匯出在每段前標出講者', () => {
    const text = exportParagraphs(groupCaptions([caption('w-0', 'A', '明日は晴れです。', '明天是晴天。'), caption('w-1', 'B', 'よかった。', '太好了。')]), true);
    expect(text).toBe('【日本語 → 繁體中文】\n〔講者 A〕\n[原文] 明日は晴れです。\n[譯文] 明天是晴天。\n\n〔講者 B〕\n[原文] よかった。\n[譯文] 太好了。');
  });

  it('講者隨紀錄保存與還原；不合法的講者值視為損壞資料', () => {
    const storage = memory();
    saveCaptions([caption('w-0', 'A', '明日は晴れです。', '明天是晴天。'), caption('w-1', 'B', 'よかった。', '太好了。')], storage);
    expect(loadCaptions(storage).captions.map(item => item.speaker)).toEqual(['A', 'B']);
    storage.setItem('realtime-translator.history.v1', JSON.stringify({ savedAt: 1,
      captions: [{ ...caption('w-0', 'A', 'a', 'b'), speaker: 'C' }, caption('w-1', 'B', 'c', 'd')] }));
    expect(loadCaptions(storage).captions.map(item => item.id)).toEqual(['w-1']);
  });

  it('設定預設關閉，開啟後記住', () => {
    const storage = memory();
    expect(speakersPreference.load(storage)).toBe(false);
    speakersPreference.save(true, storage); expect(speakersPreference.load(storage)).toBe(true);
  });
});
