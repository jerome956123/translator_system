import type { ContextCorrection, TranslationResult } from './types';
import { LANGUAGE_PAIRS, type Language, type LanguagePair } from '../../shared/protocol';
import { directionFor, isPairLanguage } from './languages';

export const TRANSLATION_SCHEMA = {
  type: 'object', propertyOrdering: ['sourceLanguage', 'original', 'translation', 'corrections'],
  properties: {
    sourceLanguage: { type: 'string', enum: ['zh', 'ja', 'en'], description: 'Main language of CURRENT speech, not of context.' },
    original: { type: 'string', description: 'Corrected current speech in its source language; Taiwan Traditional Chinese for Chinese.' },
    translation: { type: 'string', description: 'Only the translation of the corrected current speech.' },
    corrections: { type: 'array', maxItems: 2, items: {
      type: 'object', properties: {
        captionId: { type: 'string' }, revision: { type: 'integer' }, original: { type: 'string' },
        translation: { type: 'string' }, confidence: { type: 'string', enum: ['high'] },
        evidence: { type: 'string', description: 'Specific clue in the supplied speech or vocabulary supporting this correction.' },
        sourceLanguage: { type: 'string', enum: ['zh', 'ja', 'en'] },
      }, required: ['captionId', 'revision', 'original', 'translation', 'confidence', 'evidence'],
    } },
  }, required: ['original', 'translation', 'corrections'],
};

export function translationSchema(pair?: LanguagePair, audioLanguage?: Language) {
  if (!pair) return TRANSLATION_SCHEMA;
  const language = { type: 'string', enum: [...LANGUAGE_PAIRS[pair].languages] };
  return { ...TRANSLATION_SCHEMA, required: ['sourceLanguage', ...TRANSLATION_SCHEMA.required], properties: {
    ...TRANSLATION_SCHEMA.properties, sourceLanguage: audioLanguage && isPairLanguage(audioLanguage,pair)
      ? {type:'string',enum:[audioLanguage]} : language,
    corrections: { ...TRANSLATION_SCHEMA.properties.corrections, items: {
      ...TRANSLATION_SCHEMA.properties.corrections.items,
      properties: { ...TRANSLATION_SCHEMA.properties.corrections.items.properties, sourceLanguage: language },
      required: ['sourceLanguage', ...TRANSLATION_SCHEMA.properties.corrections.items.required],
    } },
  } };
}

// 讀取串流中的頂層字串欄位；不把 JSON、跳脫符號或 corrections 內的字串顯示到字幕。
function readString(input: string, start: number) {
  let text = '';
  for (let i = start + 1; i < input.length; i++) {
    const char = input[i];
    if (char === '"') return { text, end: i + 1, complete: true };
    if (char !== '\\') { text += char; continue; }
    const escaped = input[++i];
    if (escaped === undefined) break;
    if (escaped === 'u') {
      const digits = input.slice(i + 1, i + 5);
      if (!/^[\da-f]{4}$/i.test(digits)) break;
      text += String.fromCharCode(parseInt(digits, 16)); i += 4;
    } else {
      const decoded: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (!(escaped in decoded)) break;
      text += decoded[escaped];
    }
  }
  return { text: text.replace(/[\uD800-\uDBFF]$/, ''), end: input.length, complete: false };
}

function streamedField(input: string, field: string, completeOnly = false): string | undefined {
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === '"') {
      const token = readString(input, i);
      if (!token.complete) return;
      let next = token.end;
      while (/\s/.test(input[next] ?? '') && next < input.length) next++;
      if (depth === 1 && token.text === field && input[next] === ':') {
        next++;
        while (/\s/.test(input[next] ?? '') && next < input.length) next++;
        if (input[next] !== '"') return;
        const value = readString(input, next);
        return !completeOnly || value.complete ? value.text : undefined;
      }
      i = token.end - 1;
    }
  }
}

export const streamedTranslation = (input: string) => streamedField(input, 'translation');
export const streamedSourceLanguage = (input: string) => streamedField(input, 'sourceLanguage', true);

export function parseTranslationResult(input: string, pair?: LanguagePair, audioLanguage?: Language): TranslationResult {
  let value: unknown;
  try { value = JSON.parse(input); }
  catch { throw new Error('AI 校對回覆格式不完整，已保留草稿。'); }
  if (!value || typeof value !== 'object') throw new Error('AI 校對回覆格式不完整，已保留草稿。');
  const result = value as Record<string, unknown>;
  if (pair && !isPairLanguage(result.sourceLanguage, pair)) throw new Error('AI 尚未確認所選配對內的語言，請重新開始。');
  if (pair && audioLanguage && result.sourceLanguage !== audioLanguage) throw new Error('聽寫語言與翻譯方向不一致，請重新開始。');
  if (typeof result.original !== 'string' || !result.original.trim()
    || typeof result.translation !== 'string' || !result.translation.trim() || !Array.isArray(result.corrections))
    throw new Error('AI 校對回覆格式不完整，已保留草稿。');
  const corrections = result.corrections.filter((item): item is ContextCorrection => Boolean(item && typeof item === 'object'
    && typeof item.captionId === 'string' && Number.isInteger(item.revision)
    && typeof item.original === 'string' && item.original.trim() && item.original.length <= 400
    && typeof item.translation === 'string' && item.translation.trim() && item.translation.length <= 800
    && item.confidence === 'high' && typeof item.evidence === 'string' && item.evidence.trim()
    && (!pair || isPairLanguage(item.sourceLanguage, pair)))).slice(0, 2);
  return { original: result.original.trim(), text: result.translation.trim(), corrections,
    ...(pair ? {direction:directionFor(pair, result.sourceLanguage as 'zh'|'ja'|'en')} : {}),
  };
}
