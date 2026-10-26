import { describe, expect, it } from 'vitest';
import { directionFor, languageFromCode, previewDirection } from '../src/lib/languages';
import { parseTranslationResult, streamedSourceLanguage, translationSchema } from '../src/lib/structured';
import { translationPrompt } from '../src/lib/translator';
import type { LanguagePair } from '../shared/protocol';

describe('雙向語言配對', () => {
  it('正確讀取 Gemini 的中文／普通話、日文與英文語音標記', () => {
    expect(languageFromCode('cmn-Hans-CN')).toBe('zh'); expect(languageFromCode('zh-TW')).toBe('zh');
    expect(languageFromCode('ja-JP')).toBe('ja'); expect(languageFromCode('EN_us')).toBe('en');
    expect(languageFromCode('xx-YY')).toBeUndefined(); expect(languageFromCode()).toBeUndefined();
  });
  it('有語音語言標記時，限制 AI 回覆為該來源，不讓文字猜測覆蓋', () => {
    expect(translationSchema('zh-ja','ja').properties.sourceLanguage.enum).toEqual(['ja']);
    const json = JSON.stringify({sourceLanguage:'zh',original:'青森大学',translation:'青森大學',corrections:[]});
    expect(()=>parseTranslationResult(json,'zh-ja','ja')).toThrow('不一致');
    expect(translationPrompt('青森大学','','ja-zh',[], '',[],'zh-ja','ja')).toContain('evidence comes from the sound');
  });
  it.each([
    ['zh-ja','zh','zh-ja'],['zh-ja','ja','ja-zh'],['zh-en','zh','zh-en'],
    ['zh-en','en','en-zh'],['ja-en','ja','ja-en'],['ja-en','en','en-ja'],
  ] as const)('%s 聽到 %s 時翻成另一種語言', (pair, source, expected) => {
    const json = JSON.stringify({sourceLanguage:source,original:'原文',translation:'譯文',corrections:[]});
    expect(directionFor(pair, source)).toBe(expected);
    expect(parseTranslationResult(json, pair).direction).toBe(expected);
  });
  it('草稿用文字特徵預覽，正式方向允許 AI 重新判定，不受上句語言綁定', () => {
    expect(previewDirection('来週青森へ行きます。','zh-ja','zh')).toBe('ja-zh');
    expect(previewDirection('我們要去青森。','zh-ja','ja')).toBe('zh-ja');
    expect(previewDirection('How are you?','zh-en','zh')).toBe('en-zh');
    expect(previewDirection('Hello!','ja-en','ja')).toBe('en-ja');
    const ambiguous = JSON.stringify({sourceLanguage:'ja',original:'青森大学',translation:'青森大學',corrections:[]});
    expect(parseTranslationResult(ambiguous,'zh-ja').direction).toBe('ja-zh');
  });
  it('方向必須來自完整語言欄位，拒絕配對外語言與沒有辨識語言的回覆', () => {
    expect(streamedSourceLanguage('{"sourceLanguage":"j')).toBeUndefined();
    expect(streamedSourceLanguage('{"sourceLanguage":"ja",')).toBe('ja');
    const value = {original:'Hello',translation:'你好',corrections:[]};
    expect(() => parseTranslationResult(JSON.stringify(value),'zh-ja')).toThrow('語言');
    expect(() => parseTranslationResult(JSON.stringify({...value,sourceLanguage:'en'}),'zh-ja')).toThrow('語言');
    expect(() => directionFor('zh-ja','en')).toThrow('語言');
  });
  it.each(['zh-ja','zh-en','ja-en'] as LanguagePair[])('%s 提示與回覆格式同時限制兩種語言，強調逐句判斷', pair => {
    const schema = translationSchema(pair);
    expect(schema.required).toContain('sourceLanguage');
    expect(schema.properties.sourceLanguage.enum).toHaveLength(2);
    const prompt = translationPrompt('原文','前文','zh-ja',[], '',[],pair);
    expect(prompt).toContain('BIDIRECTIONAL');
    expect(prompt).toContain('detect CURRENT independently');
    expect(prompt).toContain('Loanwords');
  });
});
