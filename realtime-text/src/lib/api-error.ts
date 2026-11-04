import { redactKey } from './config';

export class AudioRequestError extends Error {
  readonly retryable: boolean;
  constructor(message: string, readonly httpStatus: number) {
    super(message); this.name = 'AudioRequestError';
    this.retryable = [500, 502, 503, 504].includes(httpStatus);
  }
}

/** Keep the provider's reason visible without exposing credentials or echoing a response body. */
export async function audioRequestError(response: Response, apiKey: string): Promise<AudioRequestError> {
  let reason = '';
  let status = '';
  try {
    const data = await response.json();
    if (typeof data?.error?.message === 'string') reason = data.error.message;
    if (typeof data?.error?.status === 'string') status = data.error.status;
  } catch { /* Non-JSON proxy/service errors still get an HTTP-specific explanation. */ }
  const clean = (text: string) => redactKey(text, apiKey)
    .replace(/AIza[\w-]+/g, '[已隱藏金鑰]')
    .replace(/([?&](?:key|api_key)=)[^&\s"']+/gi, '$1[已隱藏金鑰]')
    .replace(/\s+/g, ' ').trim();
  reason = clean(reason); status = /^[A-Z_]{1,48}$/.test(status) ? status : '';
  const keyError = /API_KEY_INVALID|API_KEY_EXPIRED|API key not valid|API key expired|API key was reported as leaked/i.test(reason);
  const hint = keyError ? 'Google 拒絕此 API Key，請在 AI Studio 確認金鑰狀態後更新。'
    : status === 'FAILED_PRECONDITION' ? 'Google 專案尚未符合使用條件，請依下方原因檢查專案與帳單狀態。'
    : response.status === 400 ? 'Google 不接受這次請求的設定；請提供下方原因以便修正。'
      : response.status === 401 ? 'API Key 無法通過驗證，請確認貼上的金鑰。'
        : response.status === 402 ? 'Google 專案的可用點數不足，請到 AI Studio 確認帳單及剩餘點數。'
          : response.status === 403 ? '此金鑰或專案沒有使用權限，請檢查金鑰限制、專案與帳單狀態。'
          : response.status === 404 ? 'Google 找不到指定的翻譯模型，請確認模型是否仍可使用。'
            : response.status === 429 ? '已達 Google 的額度或請求速率限制，請到 AI Studio 查看用量及可用額度。'
              : response.status === 413 ? 'Google 拒絕了音訊大小，這段原音尚未完成翻譯。'
                : response.status === 501 ? 'Google 目前不支援這次請求的功能，請提供下方原因以便修正。'
                  : response.status >= 500 ? 'Google 翻譯服務暫時無法處理，請稍後重新開始。'
                  : 'Google 未完成這次原音翻譯，請查看下方原因。';
  return new AudioRequestError(`精準回聽失敗（${response.status}${status ? ` / ${status}` : ''}）。${hint}${reason ? ` Google 原因：${reason}` : ''}`, response.status);
}

export function waitForAudioRetry(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 1000);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
