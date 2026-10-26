import { LANGUAGE_PAIRS, type Direction, type Language, type LanguagePair } from '../../shared/protocol';

export const LANGUAGE_LABELS: Record<Language, string> = { zh: '繁體中文', ja: '日本語', en: 'English' };
export const directionSource = (direction: Direction) => direction.slice(0, 2) as Language;
export const defaultDirection = (pair: LanguagePair) => pair as Direction;
export function languageFromCode(code?: string): Language | undefined {
  const language = code?.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  if (language === 'zh' || language === 'cmn') return 'zh';
  if (language === 'ja' || language === 'en') return language;
}
export function isPairLanguage(value: unknown, pair: LanguagePair): value is Language {
  return typeof value === 'string' && (LANGUAGE_PAIRS[pair].languages as readonly string[]).includes(value);
}
export function directionFor(pair: LanguagePair, source: Language): Direction {
  if (!isPairLanguage(source, pair)) throw new Error('AI 回傳的語言不在所選語言配對內。');
  const target = LANGUAGE_PAIRS[pair].languages.find(language => language !== source)!;
  return `${source}-${target}` as Direction;
}

// 僅供即時草稿與分段預覽。正式方向由同一次 Gemini 翻譯回覆判定。
export function previewDirection(text: string, pair: LanguagePair, previous: Language): Direction {
  const has = (language: Language) => isPairLanguage(language, pair);
  if (has('ja') && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return directionFor(pair, 'ja');
  if (/\p{Script=Han}/u.test(text)) {
    if (has('zh') && (previous !== 'ja' || /[这個們们嗎吗謝谢請请會会與与為为說说]/u.test(text))) return directionFor(pair, 'zh');
    if (has('ja')) return directionFor(pair, 'ja');
  }
  if (has('en') && /\p{Script=Latin}/u.test(text)) return directionFor(pair, 'en');
  return directionFor(pair, has(previous) ? previous : LANGUAGE_PAIRS[pair].languages[0]);
}
