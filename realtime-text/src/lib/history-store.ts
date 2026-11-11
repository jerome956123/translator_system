import { isDirection } from '../../shared/protocol';
import type { Caption } from './types';

// 翻譯紀錄（只有文字）自動保存在此瀏覽器，重新整理或分頁被系統回收後可還原。
// 原音、API 用量與費用不保存。按「清除紀錄」會一併刪除。
export const HISTORY_STORAGE_KEY = 'realtime-translator.history.v1';
const MAX_CAPTIONS = 400;
const MAX_CHARS = 400_000;
type HistoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const text = (value: unknown): value is string => typeof value === 'string';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function validCaption(value: unknown): value is Caption {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const gap = item.gap as Record<string, unknown> | undefined;
  return text(item.id) && text(item.sessionId) && isDirection(item.direction) && count(item.receivedAt)
    && text(item.paragraphId) && count(item.revision) && text(item.original) && text(item.translation)
    && count(item.translationRevision) && typeof item.originalFinal === 'boolean' && typeof item.translationFinal === 'boolean'
    && (item.origin === undefined || item.origin === 'precision' || item.origin === 'live')
    && (item.rawOriginal === undefined || text(item.rawOriginal))
    && (item.previousTranslation === undefined || text(item.previousTranslation))
    && (item.revisedAt === undefined || count(item.revisedAt))
    && (item.corrected === undefined || typeof item.corrected === 'boolean')
    && (gap === undefined || (typeof gap === 'object' && gap !== null && count(gap.startSeconds) && count(gap.endSeconds) && text(gap.message)));
}

export function saveCaptions(captions: Caption[], storage?: HistoryStorage): boolean {
  try {
    const target = storage ?? window.localStorage;
    if (!captions.length) { target.removeItem(HISTORY_STORAGE_KEY); return true; }
    // 超過上限時從最舊的開始捨棄，保留最近的內容。
    let kept = captions.slice(-MAX_CAPTIONS);
    let payload = JSON.stringify({ savedAt: Date.now(), captions: kept });
    while (payload.length > MAX_CHARS && kept.length > 1) {
      kept = kept.slice(Math.ceil(kept.length / 4));
      payload = JSON.stringify({ savedAt: Date.now(), captions: kept });
    }
    target.setItem(HISTORY_STORAGE_KEY, payload);
    return true;
  } catch { return false; }
}

/** 讀不到、格式不符或已損壞時回傳空紀錄，不影響正常使用。 */
export function loadCaptions(storage?: HistoryStorage): { captions: Caption[]; savedAt: number } {
  try {
    const raw = (storage ?? window.localStorage).getItem(HISTORY_STORAGE_KEY);
    if (!raw) return { captions: [], savedAt: 0 };
    const data = JSON.parse(raw) as { savedAt?: unknown; captions?: unknown };
    if (!Array.isArray(data.captions)) return { captions: [], savedAt: 0 };
    const seen = new Set<string>();
    const captions = data.captions.filter(validCaption).filter(item => !seen.has(item.id) && Boolean(seen.add(item.id)))
      .slice(-MAX_CAPTIONS);
    return { captions, savedAt: count(data.savedAt) ? data.savedAt : 0 };
  } catch { return { captions: [], savedAt: 0 }; }
}

export function clearCaptions(storage?: HistoryStorage): boolean {
  try { (storage ?? window.localStorage).removeItem(HISTORY_STORAGE_KEY); return true; }
  catch { return false; }
}
