import type { Caption } from './types';

export interface CaptionParagraph {
  id: string;
  captions: Caption[];
  original: string;
  translation: string;
  originalFinal: boolean;
  translationFinal: boolean;
}

export function inlineText(value: string): string { return value.replace(/\s+/gu, ' ').trim(); }

// 中日文不插入多餘空格；英文單字及句子之間保留間隔。
export function joinSpeech(left: string, right: string): string {
  const a = inlineText(left); const b = inlineText(right);
  if (!a || !b) return a || b;
  const gap = /[\p{Script=Latin}\p{N}][.!?,;:"'’”)]*$/u.test(a)
    && /^["'“‘(]*[\p{Script=Latin}\p{N}]/u.test(b) ? ' ' : '';
  return a + gap + b;
}

export function groupCaptions(captions: Caption[]): CaptionParagraph[] {
  const paragraphs: CaptionParagraph[] = [];
  for (const caption of captions) {
    let paragraph = paragraphs.at(-1);
    if (paragraph?.id !== caption.paragraphId) {
      paragraph = { id: caption.paragraphId, captions: [], original: '', translation: '', originalFinal: true, translationFinal: true };
      paragraphs.push(paragraph);
    }
    paragraph.captions.push(caption);
    paragraph.original = joinSpeech(paragraph.original, caption.original);
    paragraph.translation = joinSpeech(paragraph.translation, caption.translation);
    paragraph.originalFinal &&= caption.originalFinal;
    paragraph.translationFinal &&= caption.translationFinal;
  }
  return paragraphs;
}

export function exportParagraphs(paragraphs: CaptionParagraph[], showOriginal: boolean): string {
  return paragraphs.map(item => [
    showOriginal ? `[原文${item.originalFinal ? '' : '草稿'}] ${item.original}` : '',
    item.translation ? `[譯文${item.translationFinal ? '' : '（草稿）'}] ${item.translation}` : '',
  ].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
}
