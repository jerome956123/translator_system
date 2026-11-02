import { describe, expect, it } from 'vitest';
import { assertTranslation, plausibleTranslation, strongTextLanguage } from '../src/lib/translation-language';

describe('譯文目標語言檢查', () => {
  it('日文句子不能當成完成的中文或英文譯文', () => {
    expect(plausibleTranslation('来週は青森に行きます。', 'ja-zh')).toBe(false);
    expect(plausibleTranslation('青森に行きます。', 'ja-en')).toBe(false);
    expect(() => assertTranslation('下週去青森。', 'ja-zh', 'ja')).toThrow('目標');
  });
  it('允許共用漢字的地名、引用的日文書名與中文句中的英文名稱', () => {
    for (const text of ['青森', '東京', '我想買 Suica 卡。', '我想用ゆうちょ銀行。', '這本書叫《すずめの戸締まり》。'])
      expect(plausibleTranslation(text, 'ja-zh')).toBe(true);
    expect(plausibleTranslation('下週去青森。', 'ja-zh')).toBe(true);
  });
  it('文字與聽寫標記矛盾時，只對明確文字證據解除固定方向', () => {
    expect(strongTextLanguage('来週は青森に行きます。', 'zh-ja')).toBe('ja');
    expect(strongTextLanguage('青森大学', 'zh-ja')).toBeUndefined();
    expect(strongTextLanguage('他說「来週は青森」，你覺得呢？', 'zh-ja')).toBeUndefined();
    expect(strongTextLanguage('我想知道かわいい的意思。', 'zh-ja')).toBeUndefined();
    expect(strongTextLanguage('I think かわいい means cute.', 'ja-en')).toBeUndefined();
    expect(strongTextLanguage('I will go tomorrow.', 'zh-en')).toBe('en');
  });
});
