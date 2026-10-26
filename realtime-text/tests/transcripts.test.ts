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
    const first = assembler.update('我要買十五個。', false).changed[0];
    const corrected = assembler.update('我不買十五個。', false).changed[0];
    expect(corrected.captionId).toBe(first.captionId);
    expect(corrected.revision).toBeGreaterThan(first.revision);
    expect(assembler.update('我不買十五個。', true).changed[0].final).toBe(true);
    expect(assembler.update('我不買十五個。', true).changed[0].captionId).not.toBe(first.captionId);
  });
  it('完整定稿變短時移除多餘的暫定字幕，沒有殘留重複文字', () => {
    const assembler = new TranscriptAssembler('s', 'zh-ja');
    const draft = assembler.update('長'.repeat(240), false);
    expect(draft.changed).toHaveLength(3);
    const final = assembler.update('更正後的一句話', true);
    expect(final.removed).toHaveLength(2);
    expect(final.changed[0].text).toBe('更正後的一句話');
  });

  it('短暫停頓後延續未完成句，修正同一字幕的完整譯文而不製造新行', () => {
    let now = 1000;
    const assembler = new TranscriptAssembler('s', 'zh-ja', () => now);
    const start = assembler.update('我今天想要', true).changed[0];
    now += 900;
    const draft = assembler.update('買十五', false).changed[0];
    expect(draft.captionId).toBe(start.captionId);
    expect(draft.paragraphId).toBe(start.paragraphId);
    expect(draft.text).toBe('我今天想要買十五');
    const final = assembler.update('買五十個。', true).changed[0];
    expect(final.text).toBe('我今天想要買五十個。');
    expect(final.context).not.toContain('我今天想要');
    expect(final.revision).toBeGreaterThan(draft.revision);
  });

  it('英文換氣後補上空格，重複說的內容不會被當成重複事件丟掉', () => {
    const assembler = new TranscriptAssembler('s', 'en-zh', () => 1000);
    assembler.update('I would like', true);
    expect(assembler.update('to buy two', true).changed[0].text).toBe('I would like to buy two');
    expect(assembler.update('two', true).changed[0].text).toBe('I would like to buy two two');
  });

  it('短句和內部長句切塊共用段落，完整句較長才另開一段', () => {
    const assembler = new TranscriptAssembler('s', 'zh-ja', () => 1000);
    const first = assembler.update('第一句。', true).changed[0];
    const long = assembler.update('這是一個完整句子，'.repeat(16) + '說完。', true).changed;
    expect(long.length).toBeGreaterThan(1);
    expect(long.every(part => part.paragraphId === first.paragraphId)).toBe(true);
    const next = assembler.update('下一段。', true).changed[0];
    expect(next.paragraphId).not.toBe(first.paragraphId);
  });

  it('長停頓只在完整句後換段，句子中途停頓仍接在同一段', () => {
    let now = 1000;
    const assembler = new TranscriptAssembler('s', 'zh-ja', () => now);
    const first = assembler.update('如果我們', true).changed[0];
    now += 4000;
    const second = assembler.update('今天出發。', true).changed[0];
    expect(second.captionId).not.toBe(first.captionId);
    expect(second.paragraphId).toBe(first.paragraphId);
    now += 4000;
    expect(assembler.update('明天再見。', true).changed[0].paragraphId).not.toBe(first.paragraphId);
  });
});
