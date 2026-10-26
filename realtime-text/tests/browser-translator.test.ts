import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamTranslation } from '../src/lib/translator';
import { UsageTracker } from '../src/lib/usage';

afterEach(() => vi.unstubAllGlobals());

function options() { return { apiKey: 'fake-private-key', text: '你好', context: '', direction: 'zh-ja' as const,
  signal: new AbortController().signal, onChunk: vi.fn(), onUsage: vi.fn() }; }

describe('瀏覽器 SSE 文字串流與費用', () => {
  it('回覆方向與語音標記衝突時，不先顯示反方向的串流譯文', async () => {
    const json=JSON.stringify({sourceLanguage:'zh',original:'青森大学',translation:'青森大學',corrections:[]});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('data: '+JSON.stringify({candidates:[{
      content:{parts:[{text:json}]},finishReason:'STOP',
    }]})+'\n\n')));
    const o={...options(),pair:'zh-ja' as const,audioLanguage:'ja' as const};
    await expect(streamTranslation(o)).rejects.toThrow('不一致');
    expect(o.onChunk).not.toHaveBeenCalled();
    const config=JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).generationConfig;
    expect(config.responseJsonSchema.properties.sourceLanguage.enum).toEqual(['ja']);
  });
  it.each([
    {language:'ja',original:'来週青森へ行きます。',translation:'下周去青森。',expected:'下週去青森。',direction:'ja-zh'},
    {language:'zh',original:'下周去青森。',translation:'来週青森へ行きます。',expected:'来週青森へ行きます。',direction:'zh-ja'},
  ])('雙向串流以 AI 判定的 $language 語言決定方向與中文轉字', async data => {
    const json = JSON.stringify({sourceLanguage:data.language,original:data.original,translation:data.translation,corrections:[]});
    const body = [json.slice(0,35),json.slice(35)].map(text => 'data: '+JSON.stringify({
      candidates:[{content:{parts:[{text}]}}],
    })+'\n\n').join('') + 'data: '+JSON.stringify({candidates:[{finishReason:'STOP'}]})+'\n\n';
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(body)));
    const o = {...options(),pair:'zh-ja' as const,text:data.original};
    const result = await streamTranslation(o);
    expect(result.direction).toBe(data.direction); expect(result.text).toBe(data.expected);
    expect(o.onChunk).toHaveBeenLastCalledWith(data.expected,data.direction);
    if (data.language==='ja') expect(result.original).toContain('来週');
    const config = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).generationConfig;
    expect(config.responseJsonSchema.properties.sourceLanguage.enum).toEqual(['zh','ja']);
  });
  it('不將配對外語言的回覆當成成功雙向翻譯，避免顯示錯誤方向', async () => {
    const json = JSON.stringify({sourceLanguage:'en',original:'Hello',translation:'你好',corrections:[]});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('data: '+JSON.stringify({candidates:[{
      content:{parts:[{text:json}]},finishReason:'STOP',
    }]})+'\n\n')));
    const o = {...options(),pair:'zh-ja' as const};
    await expect(streamTranslation(o)).rejects.toThrow('語言');
    expect(o.onChunk).not.toHaveBeenCalled();
  });
  it('跨網路封包解碼 UTF-8，metadata 用累計值覆寫且忽略 thought', async () => {
    const json = JSON.stringify({original: '你好', translation: 'こんにちは', corrections: []});
    const data = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: '隱藏推理' }, { text: json.slice(0, 38) }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 2 } })
      + '\n\ndata: ' + JSON.stringify({candidates: [{content: {parts: [{text: json.slice(38)}]}}]})
      + '\r\n\r\ndata: ' + JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 1 } }) + '\n\n';
    const bytes = new TextEncoder().encode(data);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close();
    } }))));
    const o = options(); const tracker = new UsageTracker();
    o.onUsage.mockImplementation((input, output, i, out) => tracker.record('r1', input, output, i, out));
    const result = await streamTranslation(o);
    expect(result.text).toBe('こんにちは'); expect(result.outputTokens).toBe(6);
    expect(result.original).toBe('你好');
    expect(o.onChunk).toHaveBeenCalledWith('こんにちは');
    expect(o.onChunk.mock.calls.every(call => !call[0].includes('"translation"'))).toBe(true);
    expect(tracker.snapshot().inputTokens).toBe(30); expect(tracker.snapshot().outputTokens).toBe(6);
    expect(tracker.snapshot().translationRequests).toBe(1);
    const fetchOptions = vi.mocked(fetch).mock.calls[0][1]!;
    expect(fetchOptions.headers).toMatchObject({ 'x-goog-api-key': 'fake-private-key' });
    expect(vi.mocked(fetch).mock.calls[0][0]).not.toContain('fake-private-key');
    expect(JSON.parse(fetchOptions.body as string).generationConfig.responseMimeType).toBe('application/json');
  });

  it('失敗與中斷的請求仍記錄用量，截斷不標成成功', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: ' + JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"original":"你好","translation":"半句' }] }, finishReason: 'MAX_TOKENS' }],
    }) + '\n\n')));
    const o = options(); await expect(streamTranslation(o)).rejects.toThrow('長度限制');
    expect(o.onChunk).toHaveBeenCalledWith('半句'); expect(o.onUsage).toHaveBeenCalled();
  });

  it('HTTP 權限錯誤以可理解訊息呈現，不輸出原始金鑰', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private upstream', { status: 403 })));
    const o = options(); await expect(streamTranslation(o)).rejects.toThrow('API Key');
    expect(o.onUsage).toHaveBeenCalled();
  });
});
