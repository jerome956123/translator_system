import { describe, expect, it } from 'vitest';
import { splitCaption, TranscriptAssembler } from '../src/lib/transcripts';

describe('字幕修正與長句', () => {
  it('保持原始文字順序並將長句限制在有限字幕單位', () => {
    const text = '我要說一段很長的話，'.repeat(60);
    const parts = splitCaption(text);
    expect(parts.join('')).toBe(text);
    expect(parts.every(part => part.length <= 110)).toBe(true);
  });
  it('草稿替換、定稿和相同句子再說一次有不同 ID', () => {
    const assembler = new TranscriptAssembler('s', 'zh-ja');
    const first = assembler.update('我要買十五個', false).changed[0];
    const corrected = assembler.update('我不買十五個', false).changed[0];
    expect(corrected.captionId).toBe(first.captionId);
    expect(corrected.revision).toBeGreaterThan(first.revision);
    expect(assembler.update('我不買十五個', true).changed[0].final).toBe(true);
    expect(assembler.update('我不買十五個', true).changed[0].captionId).not.toBe(first.captionId);
  });
  it('完整定稿變短時移除多餘的暫定字幕，沒有殘留重複文字', () => {
    const assembler = new TranscriptAssembler('s', 'zh-ja');
    const draft = assembler.update('長'.repeat(240), false);
    expect(draft.changed).toHaveLength(3);
    const final = assembler.update('更正後的一句話', true);
    expect(final.removed).toHaveLength(2);
    expect(final.changed[0].text).toBe('更正後的一句話');
  });
});
