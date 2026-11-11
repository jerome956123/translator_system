import { describe, expect, it } from 'vitest';
import { cleanScene, guidanceData, guidanceRules, parseTerms } from '../src/lib/guidance';
import { parseVocabulary, loadScene, saveScene, loadJapaneseRegister, saveJapaneseRegister } from '../src/lib/preferences';
import { reviewPrompt } from '../src/lib/audio-review';
import { translationPrompt } from '../src/lib/translator';
import type { SessionSettings } from '../src/lib/types';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); } };
};
const clip = { audio: { wav: new ArrayBuffer(44), durationSeconds: 23, startSeconds: 0, endSeconds: 23 }, startSeconds: 0, endSeconds: 20 };
const settings = (guidance?: SessionSettings['guidance']): SessionSettings =>
  ({ apiKey: 'test-key', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving', customVocabulary: ['青森'], guidance });
const data = (prompt: string, marker: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));

describe('情境、語體與固定譯法', () => {
  it('「原詞=譯法」成為固定譯法，兩邊也都當作辨識提示；一般詞維持原本行為', () => {
    const terms = parseTerms('青森、雙聯學位=ダブルディグリー\n國立中央大學 ＝ 国立中央大学, 指導教授→指導教員; 弘前');
    expect(terms.glossary).toEqual([
      { source: '雙聯學位', target: 'ダブルディグリー' }, { source: '國立中央大學', target: '国立中央大学' },
      { source: '指導教授', target: '指導教員' }]);
    expect(terms.vocabulary).toEqual(['青森', '雙聯學位', 'ダブルディグリー', '國立中央大學', '国立中央大学', '指導教授', '指導教員', '弘前']);
    const plain = ' 國立中央大學、Gemini\n國立中央大學，雙聯學位;\n';
    expect(parseTerms(plain)).toEqual({ vocabulary: parseVocabulary(plain), glossary: [] });
  });
  it('不完整或重複的寫法不會變成錯誤的固定譯法，數量有上限', () => {
    expect(parseTerms('=只有右邊, 只有左邊=, 相同=相同, 重複=甲, 重複=乙').glossary).toEqual([{ source: '重複', target: '甲' }]);
    expect(parseTerms(Array.from({ length: 80 }, (_, i) => `詞${i}=訳${i}`).join('\n')).glossary).toHaveLength(60);
    expect(parseTerms(Array.from({ length: 80 }, (_, i) => `詞${i}=訳${i}`).join('\n')).vocabulary).toHaveLength(100);
    expect(parseTerms(`${'長'.repeat(101)}=短`).glossary).toEqual([]);
  });
  it('場合說明整理空白並限制長度；沒有設定時不加入多餘欄位', () => {
    expect(cleanScene('  與教授\n\n討論  修課 ')).toBe('與教授 討論 修課');
    expect(cleanScene('字'.repeat(400))).toHaveLength(300);
    expect(guidanceData(undefined)).toEqual({});
    expect(guidanceData({ register: 'polite', glossary: [] })).toEqual({});
    expect(guidanceRules(undefined, ['zh', 'en'])).toBe('');
  });
  it('語體只在配對含日文時加入，並依選擇改變規則', () => {
    expect(guidanceRules(undefined, ['zh', 'ja'])).toContain('mirror the speaker');
    expect(guidanceRules({ register: 'polite' }, ['zh', 'ja'])).toContain('丁寧語');
    expect(guidanceRules({ register: 'honorific' }, ['ja', 'en'])).toContain('謙譲語');
    expect(guidanceRules({ register: 'plain' }, ['zh', 'ja'])).toContain('常体');
    expect(guidanceRules({ register: 'honorific' }, ['zh', 'en'])).not.toContain('JAPANESE REGISTER');
  });
  it('原音翻譯提示帶入場合與固定譯法，且標明它們不是說過的話', () => {
    const prompt = reviewPrompt(clip, settings({ scene: '與指導教授討論修課', register: 'honorific',
      glossary: [{ source: '雙聯學位', target: 'ダブルディグリー' }] }));
    expect(prompt).toContain('never treat it as evidence that something was said');
    expect(prompt).toContain('MUST use the other side exactly as written');
    expect(prompt).toContain('尊敬語');
    expect(data(prompt, 'REFERENCE DATA ONLY: ')).toMatchObject({ vocabulary: ['青森'], scene: '與指導教授討論修課',
      glossary: [['雙聯學位', 'ダブルディグリー']] });
    const bare = reviewPrompt(clip, settings());
    expect(bare).not.toContain('SCENE'); expect(bare).not.toContain('GLOSSARY');
    expect(data(bare, 'REFERENCE DATA ONLY: ')).not.toHaveProperty('scene');
  });
  it('空白鍵模式的文字翻譯提示也帶入同樣的設定', () => {
    const prompt = translationPrompt('我想申請雙聯學位', '', 'zh-ja', [], '', ['青森'], 'zh-ja', undefined,
      { scene: '研究室面談', register: 'polite', glossary: [{ source: '雙聯學位', target: 'ダブルディグリー' }] });
    expect(prompt).toContain('丁寧語'); expect(prompt).toContain('SCENE is the user');
    expect(data(prompt, '\nDATA: ')).toMatchObject({ current: '我想申請雙聯學位', scene: '研究室面談', glossary: [['雙聯學位', 'ダブルディグリー']] });
    expect(data(translationPrompt('hello', '', 'en-zh', [], '', [], 'zh-en'), '\nDATA: ')).not.toHaveProperty('glossary');
  });
  it('場合與語體會在瀏覽器記住；無效值回到自動', () => {
    const storage = memory();
    expect(loadScene(storage)).toBe(''); expect(loadJapaneseRegister(storage)).toBe('auto');
    saveScene('  與教授   討論修課 ', storage); saveJapaneseRegister('honorific', storage);
    expect(loadScene(storage)).toBe('與教授 討論修課'); expect(loadJapaneseRegister(storage)).toBe('honorific');
    saveJapaneseRegister('auto', storage); saveScene('', storage);
    expect(loadJapaneseRegister(storage)).toBe('auto'); expect(loadScene(storage)).toBe('');
    storage.setItem('realtime-translator.ja-register.v1', 'shouting');
    expect(loadJapaneseRegister(storage)).toBe('auto');
  });
});
