import { DIRECTIONS } from '../../shared/protocol';
import type { Caption } from './types';
import { sourceText } from './chinese';

// Keep rawOriginal intact. Normalize only Chinese script for the visible comparison.
export function recognitionText(caption: Caption) {
  return sourceText(caption.rawOriginal ?? caption.original, caption.direction);
}

export function exportComparison(captions: Caption[]): string {
  if (!captions.length) return '';
  return ['漏字檢查：語音辨識稿與目前原文對照',
    '辨識稿僅統一繁體字形；目前原文可能經過文字模型校正。',
    '時間是辨識回傳時間，不代表與保留的原音逐句對齊。', '',
    ...captions.map(caption => [
      `【${new Date(caption.receivedAt).toLocaleTimeString('zh-TW', { hour12: false })}｜${DIRECTIONS[caption.direction].sourceLabel} → ${DIRECTIONS[caption.direction].targetLabel}】`,
      `[語音辨識稿${caption.originalFinal ? '' : '・草稿'}] ${recognitionText(caption)}`,
      `[目前原文] ${caption.original}`, `[譯文${caption.translationFinal ? '' : '・草稿'}] ${caption.translation}`,
    ].join('\n'))].join('\n\n');
}

export function audioTime(seconds: number): string {
  const rounded = Math.floor(seconds);
  return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}
