import { ConverterFactory } from 'opencc-js/core';
import { from, to } from 'opencc-js/preset/cn2t';
import type { Direction } from '../../shared/protocol';

// 字典隨網頁打包，不呼叫外部轉字服務；包含台灣常用詞彙。
const convert = ConverterFactory(from.cn, to.twp);
export const traditionalChinese = (text: string) => convert(text);
export const sourceText = (text: string, direction: Direction) => direction.startsWith('zh-') ? convert(text) : text;
export const translatedText = (text: string, direction: Direction) => direction.endsWith('-zh') ? convert(text) : text;
export const sourceLang = (direction: Direction) => direction.startsWith('zh-') ? 'zh-Hant-TW' : direction.startsWith('ja-') ? 'ja' : 'en';
export const targetLang = (direction: Direction) => direction.endsWith('-zh') ? 'zh-Hant-TW' : direction.endsWith('-ja') ? 'ja' : 'en';
