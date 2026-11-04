import { describe, expect, it } from 'vitest';
import { audioRequestError } from '../src/lib/api-error';

const reply = (code: number, message: string, status = 'INVALID_ARGUMENT') =>
  new Response(JSON.stringify({ error: { message, status } }), { status: code });

describe('原音 API 錯誤原因', () => {
  it('顯示 Google 實際格式錯誤，不誤認為沒有聲音或一律歸咎金鑰', async () => {
    const error = await audioRequestError(reply(400, 'Invalid schema: propertyOrdering is invalid.'), 'test-key');
    expect(error.message).toContain('400 / INVALID_ARGUMENT');
    expect(error.message).toContain('Google 原因：Invalid schema');
    expect(error.message).toContain('設定');
  });
  it('金鑰失效、權限、額度、模型及服務故障有不同提示', async () => {
    expect((await audioRequestError(reply(400, 'API key not valid.'), '')).message).toContain('拒絕此 API Key');
    expect((await audioRequestError(reply(403, 'Permission denied', 'PERMISSION_DENIED'), '')).message).toContain('權限');
    expect((await audioRequestError(reply(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED'), '')).message).toContain('額度');
    expect((await audioRequestError(reply(404, 'Model not found', 'NOT_FOUND'), '')).message).toContain('模型');
    expect((await audioRequestError(reply(503, 'Service unavailable', 'UNAVAILABLE'), '')).message).toContain('暫時');
  });
  it('不回顯金鑰，非 JSON 的伺服器錯誤也有說明', async () => {
    const error = await audioRequestError(reply(403, 'Denied: secret-key https://example.test?key=another-secret&x=1 AIzaNotARealKey'), 'secret-key');
    expect(error.message).not.toContain('secret-key'); expect(error.message).not.toContain('another-secret');
    expect(error.message).not.toContain('AIza'); expect(error.message).toContain('[已隱藏金鑰]');
    expect((await audioRequestError(new Response('<html>Bad gateway</html>', { status: 502 }), '')).message).toContain('502');
  });
});
