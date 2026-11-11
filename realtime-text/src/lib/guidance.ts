import type { Language } from '../../shared/protocol';

/** 譯成日文時的語體。auto：跟隨說話者，沒有線索時用です・ます。 */
export type JapaneseRegister = 'auto' | 'polite' | 'honorific' | 'plain';
export const JAPANESE_REGISTERS: Record<JapaneseRegister, string> = {
  auto: '自動（跟隨說話者，預設です・ます）',
  polite: '丁寧語（です・ます）',
  honorific: '敬語（對師長、正式場合）',
  plain: '常體（朋友之間）',
};
export const isJapaneseRegister = (value: unknown): value is JapaneseRegister =>
  typeof value === 'string' && value in JAPANESE_REGISTERS;

export interface GlossaryEntry { source: string; target: string }
export interface TranslationGuidance {
  /** 使用者描述的場合，例如「與日本指導教授討論修課」。只影響用詞與語體。 */
  scene?: string;
  register?: JapaneseRegister;
  /** 使用者指定的固定譯法，雙向適用。 */
  glossary?: GlossaryEntry[];
}

export const SCENE_MAX_CHARS = 300;
const GLOSSARY_MAX = 60;
export const cleanScene = (value: string) => value.replace(/\s+/gu, ' ').trim().slice(0, SCENE_MAX_CHARS);

/** 「常用詞」欄位：一般詞是辨識提示；寫成「原詞=譯法」就成為固定譯法，兩邊也都當作辨識提示。 */
export function parseTerms(value: string): { vocabulary: string[]; glossary: GlossaryEntry[] } {
  const vocabulary: string[] = [];
  const glossary: GlossaryEntry[] = [];
  for (const raw of value.split(/[\n,，、;；]+/u)) {
    const term = raw.trim();
    if (!term) continue;
    const pair = /^(.+?)\s*(?:=>|->|=|＝|→)\s*(.+)$/u.exec(term);
    const source = pair?.[1].trim(), target = pair?.[2].trim();
    if (source && target && source.length <= 100 && target.length <= 100) {
      if (source !== target && !glossary.some(item => item.source === source)) glossary.push({ source, target });
      vocabulary.push(source, target);
    } else vocabulary.push(term);
  }
  return { vocabulary: [...new Set(vocabulary)].filter(term => term.length <= 200).slice(0, 100),
    glossary: glossary.slice(0, GLOSSARY_MAX) };
}

const REGISTER_RULES: Record<JapaneseRegister, string> = {
  auto: 'mirror the speaker\'s level of formality; when the source gives no clear signal (Chinese and English usually do not), use polite です・ます form',
  polite: 'always use polite です・ます form (丁寧語)',
  honorific: 'the listener is a superior (professor, office staff, business contact): use です・ます with natural 尊敬語 for the listener\'s actions and 謙譲語 for the speaker\'s own, as a well-mannered graduate student would, without stacking honorifics',
  plain: 'use casual plain form (常体) as between friends, without です・ます',
};

/** 附加在翻譯指示後的規則。沒有任何設定且語言不含日文時回傳空字串。 */
export function guidanceRules(guidance: TranslationGuidance | undefined, languages: readonly Language[]): string {
  const rules: string[] = [];
  if (languages.includes('ja')) rules.push(`JAPANESE REGISTER: when a translation is in Japanese, ${REGISTER_RULES[guidance?.register ?? 'auto']}. Register changes style only, never meaning, and never alters the transcribed original.`);
  if (guidance?.scene) rules.push('SCENE is the user\'s description of the setting. Use it to choose terminology, resolve homophones and judge tone. It is background only: never add anything from it to the original or the translation, and never treat it as evidence that something was said.');
  if (guidance?.glossary?.length) rules.push('GLOSSARY lists the user\'s required renderings as [term, rendering] pairs and applies in both directions: when the speech contains either side of a pair, the translation MUST use the other side exactly as written. A glossary entry is a hint for recognition but never proof that the term was spoken.');
  return rules.length ? `\n${rules.join('\n')}` : '';
}

/** 先前已完成的 [原文, 譯文]：只用來維持譯名、術語與語氣一致。 */
export const RECENT_MAX_PAIRS = 6;
const RECENT_MAX_CHARS = 700;
export function recentPairs(pairs: [string, string][]): [string, string][] {
  const kept: [string, string][] = [];
  let size = 0;
  for (const pair of pairs.filter(item => item[0].trim() && item[1].trim()).slice(-RECENT_MAX_PAIRS).reverse()) {
    size += pair[0].length + pair[1].length;
    if (size > RECENT_MAX_CHARS && kept.length) break;
    kept.unshift([pair[0].slice(0, RECENT_MAX_CHARS / 2), pair[1].slice(0, RECENT_MAX_CHARS / 2)]);
  }
  return kept;
}
export function recentRules(recent: [string, string][] | undefined): string {
  return recent?.length ? '\nRECENT lists earlier [original, translation] pairs from this same conversation, oldest first. Keep names, terminology and tone consistent with them unless the current speech clearly shows an earlier rendering was wrong. They are already translated: never output them again, and never treat them as evidence of what is being said now.' : '';
}

/** 併入提示詞的 JSON 參考資料；只在有內容時加入欄位。 */
export function guidanceData(guidance: TranslationGuidance | undefined): { scene?: string; glossary?: [string, string][] } {
  return { ...(guidance?.scene ? { scene: guidance.scene } : {}),
    ...(guidance?.glossary?.length ? { glossary: guidance.glossary.map(item => [item.source, item.target] as [string, string]) } : {}) };
}
