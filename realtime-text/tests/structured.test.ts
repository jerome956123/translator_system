import { describe, expect, it } from 'vitest';
import { streamedTranslation, parseTranslationResult } from '../src/lib/structured';
import { translationPrompt } from '../src/lib/translator';

describe('串流校對與翻譯資料', () => {
  it('逐字顯示譯文，處理跨封包跳脫、引號及 Unicode，不洩漏 JSON 或原文欄位', () => {
    const text = JSON.stringify({original: '說 "translation": "假的"', translation: 'Hello "青森"\n😀', corrections: []});
    for (let i = 0; i < text.length; i++) {
      const partial = streamedTranslation(text.slice(0, i));
      if (partial !== undefined) expect('Hello "青森"\n😀'.startsWith(partial)).toBe(true);
    }
    expect(streamedTranslation(text)).toBe('Hello "青森"\n😀');
    expect(streamedTranslation('{"translation":"\\u9752\\u68')).toBe('青');
    expect(streamedTranslation('{"translation":"\\uD83D')).toBe('');
  });
  it('只接受完整回覆和有證據的校正，不讓巢狀 translation 當成目前譯文', () => {
    const correction = {captionId:'c1',revision:1,original:'青森',translation:'Aomori',confidence:'high',evidence:'後句提到日本東北的弘前'};
    const json = JSON.stringify({corrections:[correction], original:'下一句',translation:'Next sentence'});
    expect(streamedTranslation(json)).toBe('Next sentence');
    expect(parseTranslationResult(json).corrections).toEqual([correction]);
    expect(parseTranslationResult(JSON.stringify({original:'好',translation:'OK',corrections:[{...correction,confidence:'low'},{}]})).corrections).toEqual([]);
    expect(() => parseTranslationResult('{"translation":"半句')).toThrow('格式不完整');
  });
  it('提示提供前後文、常用詞及可校正紀錄，要求不確定時保留原文與數字否定', () => {
    const prompt = translationPrompt('我們要去弘前城。', '下週二要去慶生。', 'zh-ja', [
      {captionId:'c1',revision:1,raw:'下週二要去慶生。',original:'下週二要去慶生。',translation:'お祝い'},
    ], '日本東北', ['青森']);
    expect(prompt).toContain('Taiwan Traditional Chinese');
    expect(prompt).toContain('Keep the original when uncertain');
    expect(prompt).toContain('dates, numbers and negations');
    expect(prompt).toContain('青森'); expect(prompt).toContain('日本東北'); expect(prompt).toContain('"captionId":"c1"');
  });
});
