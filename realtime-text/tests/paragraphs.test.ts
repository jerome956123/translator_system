import { describe, expect, it } from 'vitest';
import { exportParagraphs, groupCaptions, joinSpeech } from '../src/lib/paragraphs';
import type { Caption } from '../src/lib/types';

const caption = (id: string, paragraphId: string, original: string, translation: string, final = true): Caption => ({
  id, paragraphId, original, translation, originalFinal: final, translationFinal: final, revision: 1, translationRevision: 1,
});

describe('連續段落顯示與匯出', () => {
  it('同段只顯示一次原文／譯文標籤，草稿持續補上，TXT 也不會每小句換段', () => {
    const paragraphs = groupCaptions([
      caption('a', 'p1', '今天有一場會議。', 'There is a meeting today.'),
      caption('b', 'p1', '我們會討論', 'We will discuss', false),
      caption('c', 'p2', '接著休息。', 'Then take a break.'),
    ]);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].original).toBe('今天有一場會議。我們會討論');
    expect(paragraphs[0].translation).toBe('There is a meeting today. We will discuss');
    expect(paragraphs[0].translationFinal).toBe(false);
    expect(exportParagraphs(paragraphs, true)).toBe('[原文草稿] 今天有一場會議。我們會討論\n[譯文（草稿）] There is a meeting today. We will discuss\n\n[原文] 接著休息。\n[譯文] Then take a break.');
    expect(exportParagraphs(paragraphs, false)).not.toContain('原文');
  });
  it('合併中文／日文不亂加空格，英文保留單字和標點，模型多餘換行不造成空段', () => {
    expect(joinSpeech('我們', '今天出發。')).toBe('我們今天出發。');
    expect(joinSpeech('今日は', '出発します。')).toBe('今日は出発します。');
    expect(joinSpeech('Hello', ', world.')).toBe('Hello, world.');
    expect(joinSpeech('Hello.', '\n\nHow are you?')).toBe('Hello. How are you?');
    expect(joinSpeech('', '3.14')).toBe('3.14');
  });
  it('定稿縮短與晚到翻譯後重新計算段落，不殘留舊文字', () => {
    const a = caption('a', 'p1', '更正為五十個。', 'Fifty.', true);
    const paragraphs = groupCaptions([a, caption('b', 'p1', '謝謝。', '', false)]);
    expect(paragraphs[0].translation).toBe('Fifty.');
    expect(paragraphs[0].translationFinal).toBe(false);
    expect(groupCaptions([{ ...a, translation: 'Fifty, please.' }])[0].translation).toBe('Fifty, please.');
  });
});
