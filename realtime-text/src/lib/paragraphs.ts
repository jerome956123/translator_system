import type { Caption, CaptionGap } from './types';
import { DIRECTIONS, type Speaker } from '../../shared/protocol';

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
  speaker?: Speaker;
}

export const speakerLabel = (speaker: Speaker) => `講者 ${speaker}`;

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

// 同一位講者連續說的話合併在同一格；單一格的原文超過這個長度後，才在下一個段落分界另起一格，避免一個人講很久時變成一大塊。
export const SPEAKER_TURN_MAX_CHARS = 600;

export function groupCaptions(captions: Caption[]): CaptionParagraph[] {
  const paragraphs: CaptionParagraph[] = [];
  for (const caption of captions) {
    let paragraph = paragraphs.at(-1);
    const sameParagraph = paragraph?.captions.at(-1)?.paragraphId === caption.paragraphId;
    // 有講者標示時以「誰在說」分格：同一位講者、同一個方向、同一場次的連續內容接在一起，不管它被切成幾段送出。
    const sameTurn = Boolean(paragraph && caption.speaker && paragraph.speaker === caption.speaker && !caption.gap && !paragraph.gap
      && paragraph.sessionId === caption.sessionId && paragraph.original.length < SPEAKER_TURN_MAX_CHARS);
    // 換了講者就另起一格，即使語言相同、仍在同一個段落編號內。
    if (!paragraph || !(sameParagraph || sameTurn) || paragraph.direction !== caption.direction
      || paragraph.speaker !== caption.speaker) {
      paragraph = { id: `${caption.paragraphId}-${caption.id}`, captions: [], original: '', translation: '', originalFinal: true, translationFinal: true,
        sessionId: caption.sessionId, direction: caption.direction, receivedAt: caption.receivedAt, corrected: false,
        ...(caption.gap ? { gap: caption.gap } : {}), ...(caption.speaker ? { speaker: caption.speaker } : {}) };
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
    item.speaker ? `〔${speakerLabel(item.speaker)}〕` : '',
    showOriginal ? `[原文${item.originalFinal ? '' : '草稿'}] ${item.original}` : '',
    item.translation ? `[譯文${item.translationFinal ? '' : '（草稿）'}] ${item.translation}` : '',
  ].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
}
