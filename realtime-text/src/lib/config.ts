export const MODELS = {
  stt: 'gemini-3.5-transcribe-live',
  translation: 'gemini-3.1-flash-lite',
} as const;

// 2026-10-30 查閱官方價格；顯示的是估算，不包含稅與供應商額外的上下文計費。
export const PRICES = { sttPerMinute: 0.009, textInputPerMillion: 0.25, audioInputPerMillion: 0.5, textOutputPerMillion: 1.5 };
export type Prices = typeof PRICES;

/** 翻譯品質：省錢用 Flash-Lite；高品質用同代最強的 Flash，較慢也較貴。 */
export type Quality = 'economy' | 'quality';
export const isQuality = (value: unknown): value is Quality => value === 'economy' || value === 'quality';
// 2026-11-11 查閱官方模型與價格頁。gemini-3.8-flash 不支援 thinkingLevel: minimal（會回錯誤），最低為 low。
export const QUALITY_MODELS: Record<Quality, { model: string; thinkingLevel: 'minimal' | 'low'; label: string }> = {
  economy: { model: MODELS.translation, thinkingLevel: 'minimal', label: '標準（Flash-Lite，最省費用）' },
  quality: { model: 'gemini-3.8-flash', thinkingLevel: 'low', label: '高品質（3.8 Flash，費用約 3 倍）' },
};
// 官方公告 gemini-3.8-flash 自 2027-01-01 起輸入與輸出價格加倍；價格頁沒有另列音訊輸入價，以同一輸入價估算。
const QUALITY_PRICE_CHANGE = Date.UTC(2027, 0, 1);
export function pricesFor(quality: Quality = 'economy', now = Date.now()): Prices {
  if (quality !== 'quality') return PRICES;
  const input = now < QUALITY_PRICE_CHANGE ? 0.75 : 1.5;
  return { sttPerMinute: PRICES.sttPerMinute, textInputPerMillion: input, audioInputPerMillion: input,
    textOutputPerMillion: now < QUALITY_PRICE_CHANGE ? 3.75 : 7.5 };
}

/** 精準模式的分段節奏：快速較早出字，但請求次數與費用約加倍。 */
export type Pace = 'standard' | 'fast';
export const isPace = (value: unknown): value is Pace => value === 'standard' || value === 'fast';
export const PACES: Record<Pace, { minSeconds: number; maxSeconds: number; lookaheadSeconds: number; label: string }> = {
  standard: { minSeconds: 12, maxSeconds: 20, lookaheadSeconds: 3, label: '標準（約 12–20 秒一段）' },
  fast: { minSeconds: 6, maxSeconds: 12, lookaheadSeconds: 2, label: '快速（約 6–12 秒一段，費用約 2 倍）' },
};

export const CONTEXT_MAX_CHARS = 512;
export const MAX_OUTPUT_TOKENS = 1024;

export function readableError(error: unknown) {
  if (error instanceof Error && error.name === 'AbortError') return '本次請求已停止。';
  return error instanceof Error ? error.message : '發生未知錯誤。';
}

export function redactKey(message: string, key: string) {
  return (key ? message.split(key).join('[已隱藏金鑰]') : message).slice(0, 240);
}
