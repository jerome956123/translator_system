import { describe, expect, it } from 'vitest';
import { sourceText, translatedText, traditionalChinese } from '../src/lib/chinese';

describe('台灣繁體中文', () => {
  it('原文草稿立即轉繁體字與台灣用語，不必等待 AI', () => {
    expect(sourceText('下周二要去青森，电脑软件和鼠标都准备好了。', 'zh-ja'))
      .toBe('下週二要去青森，電腦軟體和滑鼠都準備好了。');
  });
  it('中文譯文再次確保繁體，複製下載共用同一份文字', () => {
    expect(translatedText('这个软件支持打印机。', 'en-zh')).toBe('這個軟體支援印表機。');
    const text = '下週二到青森，搭新幹線。';
    expect(traditionalChinese(traditionalChinese(text))).toBe(text);
  });
  it('不把日文漢字轉成中文字形，也不修改英文原文', () => {
    expect(sourceText('来週火曜日に青森へ行きます。', 'ja-zh')).toBe('来週火曜日に青森へ行きます。');
    expect(translatedText('来週火曜日に青森へ行きます。', 'zh-ja')).toBe('来週火曜日に青森へ行きます。');
    expect(sourceText('We will go to Aomori.', 'en-zh')).toBe('We will go to Aomori.');
  });
});
