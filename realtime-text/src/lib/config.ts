export const MODELS = {
  stt: 'gemini-3.5-transcribe-live',
  translation: 'gemini-3.1-flash-lite',
} as const;

// 2026-10-30 查閱官方價格；顯示的是估算，不包含稅與供應商額外的上下文計費。
export const PRICES = { sttPerMinute: 0.009, textInputPerMillion: 0.25, audioInputPerMillion: 0.5, textOutputPerMillion: 1.5 };
export const CONTEXT_MAX_CHARS = 512;
export const MAX_OUTPUT_TOKENS = 1024;

export function readableError(error: unknown) {
  if (error instanceof Error && error.name === 'AbortError') return '本次請求已停止。';
  return error instanceof Error ? error.message : '發生未知錯誤。';
}

export function redactKey(message: string, key: string) {
  return (key ? message.split(key).join('[已隱藏金鑰]') : message).slice(0, 240);
}
