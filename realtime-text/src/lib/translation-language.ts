import type { Direction, Language, LanguagePair } from '../../shared/protocol';
import { isPairLanguage } from './languages';

export class TranslationLanguageError extends Error {
  constructor() { super('譯文語言與目標不符，未將這段內容當成完成的翻譯。'); this.name = 'TranslationLanguageError'; }
}

// Quoted titles/names may intentionally keep Japanese. Shared Han characters alone are ambiguous.
function prose(text: string) { return text.replace(/「[^」]*」|『[^』]*』|《[^》]*》|“[^”]*”|"[^"]*"/gu, ''); }
function hasChineseProse(text: string) {
  return /我們|你們|他們|這[是個]|那[個是]|什麼|怎麼|謝謝|請問|我想|我說|我覺得|你說|可以|但是|所以|的意思|我明天|請到|請去|我们|你们|他们|这个|这是|什么|怎么|谢谢|请问|我觉得/u.test(text);
}
export function strongTextLanguage(text: string, pair: LanguagePair): Language | undefined {
  const value = prose(text);
  if (isPairLanguage('ja', pair) && !hasChineseProse(value) && (value.match(/[A-Za-z]+/g)?.length ?? 0) < 3
    && (value.match(/\p{Script=Hiragana}/gu)?.length ?? 0) >= 2) return 'ja';
  if (isPairLanguage('en', pair) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)
    && (value.match(/[A-Za-z]+/g)?.length ?? 0) >= 3) return 'en';
}

export function plausibleTranslation(text: string, direction: Direction): boolean {
  const target = direction.slice(3);
  const value = prose(text);
  const kana = value.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const han = value.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = value.match(/[A-Za-z]+/g)?.length ?? 0;
  if (target === 'zh' && kana > 0 && !hasChineseProse(value) && kana / Math.max(1, kana + han) > .12) return false;
  if (target === 'en' && han + kana >= 4 && words < 2) return false;
  if (target === 'ja' && words >= 3 && !kana && !han) return false;
  return true;
}

export function assertTranslation(text: string, direction: Direction, declaredTarget?: unknown) {
  if ((declaredTarget !== undefined && declaredTarget !== direction.slice(3)) || !plausibleTranslation(text, direction))
    throw new TranslationLanguageError();
}
