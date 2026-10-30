import { DIRECTIONS, type PrecisionWindow, type ServerMessage } from '../../shared/protocol';
import { audioTime } from './diagnostics';

export function precisionHistory(items: PrecisionWindow[], event: ServerMessage | { type: 'clear-history' }): PrecisionWindow[] {
  if (event.type === 'clear-history') return [];
  if (event.type !== 'precision-result' || event.window.sessionId !== event.sessionId) return items;
  return items.some(item => item.id === event.window.id) ? items : [...items, event.window];
}

export function exportPrecision(items: PrecisionWindow[]): string {
  if (!items.length) return '';
  return ['精準回聽校正：直接根據原音重新辨識與翻譯（可能仍有誤差）',
    '每場時間從 00:00 重新計算。此結果獨立於即時字幕；空白不代表一定沒有說話。', '',
    ...items.map((item, index) => [
      index === 0 || items[index - 1].sessionId !== item.sessionId ? `【場次 ${item.sessionId}】` : '',
      `【收音位置 ${audioTime(item.startSeconds)}–${audioTime(item.endSeconds)}】`,
      ...item.segments.map(segment => `${DIRECTIONS[segment.direction].sourceLabel} → ${DIRECTIONS[segment.direction].targetLabel}\n[原音重辨識] ${segment.original}\n[譯文] ${segment.translation}`),
      !item.segments.length ? '[這段未辨識到清楚語音]' : '',
    ].filter(Boolean).join('\n'))].join('\n\n');
}
