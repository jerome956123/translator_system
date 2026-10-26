import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamTranslation } from '../src/lib/translator';
import { UsageTracker } from '../src/lib/usage';

afterEach(() => vi.unstubAllGlobals());

function options() { return { apiKey: 'fake-private-key', text: '你好', context: '', direction: 'zh-ja' as const,
  signal: new AbortController().signal, onChunk: vi.fn(), onUsage: vi.fn() }; }

describe('瀏覽器 SSE 文字串流與費用', () => {
  it('跨網路封包解碼 UTF-8，metadata 用累計值覆寫且忽略 thought', async () => {
    const data = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: '隱藏推理' }, { text: 'こんにちは' }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 2 } })
      + '\r\n\r\ndata: ' + JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 1 } }) + '\n\n';
    const bytes = new TextEncoder().encode(data);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close();
    } }))));
    const o = options(); const tracker = new UsageTracker();
    o.onUsage.mockImplementation((input, output, i, out) => tracker.record('r1', input, output, i, out));
    const result = await streamTranslation(o);
    expect(result.text).toBe('こんにちは'); expect(result.outputTokens).toBe(6);
    expect(tracker.snapshot().inputTokens).toBe(30); expect(tracker.snapshot().outputTokens).toBe(6);
    expect(tracker.snapshot().translationRequests).toBe(1);
    const fetchOptions = vi.mocked(fetch).mock.calls[0][1]!;
    expect(fetchOptions.headers).toMatchObject({ 'x-goog-api-key': 'fake-private-key' });
    expect(vi.mocked(fetch).mock.calls[0][0]).not.toContain('fake-private-key');
  });

  it('失敗與中斷的請求仍記錄用量，截斷不標成成功', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: ' + JSON.stringify({
      candidates: [{ content: { parts: [{ text: '半句' }] }, finishReason: 'MAX_TOKENS' }],
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
