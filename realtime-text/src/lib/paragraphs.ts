import type { Caption, CaptionGap } from './types';
import { DIRECTIONS } from '../../shared/protocol';

export interface CaptionParagraph {
  id: string;
  captions: Caption[];
  original: string;
  translation: string;
  originalFinal: boolean;
  translationFinal: boolean;
  sessionId: string;
  direction: Caption['direction'];
  receivedAt: number;
  corrected: boolean;
  gap?: CaptionGap;
}

const clock = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds) % 60).padStart(2, '0')}`;
/** 缺口標記的顯示文字；時間是本場收音的位置。 */
export const gapText = (gap: CaptionGap) => `收音 ${clock(gap.startSeconds)}–${clock(gap.endSeconds)} 這段未能翻譯：${gap.message}`;

export function inlineText(value: string): string { return value.replace(/\s+/gu, ' ').trim(); }

// 中日文不插入多餘空格；英文單字及句子之間保留間隔。
export function joinSpeech(left: string, right: string): string {
  const a = inlineText(left); const b = inlineText(right);
  if (!a || !b) return a || b;
  const gap = /[\p{Script=Latin}\p{N}][.!?,;:"'’”)]*$/u.test(a)
    && /^["'“‘(]*[\p{Script=Latin}\p{N}]/u.test(b) ? ' ' : '';
  return a + gap + b;
}

/** 兩版文字之間被改動的範圍（以新版的位置表示）；用共同的開頭與結尾夾出中間的差異。 */
export function changedRange(before: string, after: string): { start: number; end: number } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { start, end: after.length - tail };
}

export function groupCaptions(captions: Caption[]): CaptionParagraph[] {
  const paragraphs: CaptionParagraph[] = [];
  for (const caption of captions) {
    let paragraph = paragraphs.at(-1);
    if (!paragraph || paragraph.captions.at(-1)?.paragraphId !== caption.paragraphId || paragraph.direction !== caption.direction) {
      paragraph = { id: `${caption.paragraphId}-${caption.id}`, captions: [], original: '', translation: '', originalFinal: true, translationFinal: true,
        sessionId: caption.sessionId, direction: caption.direction, receivedAt: caption.receivedAt, corrected: false,
        ...(caption.gap ? { gap: caption.gap } : {}) };
      paragraphs.push(paragraph);
    }
    paragraph.captions.push(caption);
    paragraph.original = joinSpeech(paragraph.original, caption.original);
    paragraph.translation = joinSpeech(paragraph.translation, caption.translation);
    paragraph.originalFinal &&= caption.originalFinal;
    paragraph.translationFinal &&= caption.translationFinal;
    paragraph.corrected ||= Boolean(caption.corrected);
  }
  return paragraphs;
}

export function exportParagraphs(paragraphs: CaptionParagraph[], showOriginal: boolean): string {
  return paragraphs.map((item, index) => item.gap ? `[未翻譯] ${gapText(item.gap)}` : [
    index === 0 || paragraphs[index - 1].gap || paragraphs[index - 1].sessionId !== item.sessionId || paragraphs[index - 1].direction !== item.direction
      ? `【${DIRECTIONS[item.direction].sourceLabel} → ${DIRECTIONS[item.direction].targetLabel}】` : '',
    showOriginal ? `[原文${item.originalFinal ? '' : '草稿'}] ${item.original}` : '',
    item.translation ? `[譯文${item.translationFinal ? '' : '（草稿）'}] ${item.translation}` : '',
  ].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
}
