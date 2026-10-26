// 2026-10-26 臺灣銀行美元即期賣出牌告；是可調整的參考值，不是即時匯率。
export const DEFAULT_USD_TWD = 32.58;
export const EXCHANGE_RATE_DATE = '2026-10-26';
export const EXCHANGE_RATE_SOURCE = 'https://rate.bot.com.tw/xrt?Lang=zh-TW';
export const validExchangeRate = (rate: number) => Number.isFinite(rate) && rate > 0;
export function usdToTwd(usd: number, rate: number): number {
  if (!validExchangeRate(rate)) throw new Error('換算匯率請填大於 0 的數字。');
  return usd * rate;
}
export function twdBudgetToUsd(amount: string, rate: number): number | undefined {
  if (!validExchangeRate(rate)) throw new Error('換算匯率請填大於 0 的數字。');
  if (!amount.trim()) return undefined;
  const twd = Number(amount);
  if (!Number.isFinite(twd) || twd <= 0) throw new Error('預算請填大於 0 的台幣金額，或留空。');
  return twd / rate;
}
export function formatTwd(amount: number): string {
  if (amount > 0 && amount < 0.01) return '< NT$0.01';
  return `NT$${amount.toLocaleString('zh-TW', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
}
