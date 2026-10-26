import { describe, expect, it } from 'vitest';
import { API_KEY_STORAGE_KEY, loadApiKey, saveApiKey, parseVocabulary, loadExchangeRate, saveExchangeRate } from '../src/lib/preferences';

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

describe('個人瀏覽器記憶設定', () => {
  it('重新讀取時自動帶入已保存的 Key，清除後不再帶入', () => {
    const storage = memoryStorage();
    expect(loadApiKey(storage)).toBe('');
    expect(saveApiKey('  fake-personal-key  ', storage)).toBe(true);
    expect(loadApiKey(storage)).toBe('fake-personal-key');
    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBe('fake-personal-key');
    expect(saveApiKey('', storage)).toBe(true);
    expect(loadApiKey(storage)).toBe('');
    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBeNull();
  });
  it('瀏覽器阻擋儲存時不會讓頁面或開始聆聽崩潰', () => {
    const blocked = () => { throw new DOMException('blocked', 'SecurityError'); };
    const storage = { getItem: blocked, setItem: blocked, removeItem: blocked };
    expect(loadApiKey(storage)).toBe('');
    expect(saveApiKey('fake-key', storage)).toBe(false);
    expect(saveApiKey('', storage)).toBe(false);
  });
  it('常用詞接受中文標點及換行，去除空白、重複和過長詞，限制 100 個', () => {
    expect(parseVocabulary(' 國立中央大學、Gemini\n國立中央大學，雙聯學位;\n')).toEqual(['國立中央大學', 'Gemini', '雙聯學位']);
    expect(parseVocabulary('字'.repeat(201))).toEqual([]);
    expect(parseVocabulary(Array.from({ length: 130 }, (_, i) => `term ${i}`).join(','))).toHaveLength(100);
  });
  it('記住自訂匯率，非法數字不覆蓋既有值，無設定時有參考值', () => {
    const storage = memoryStorage();
    expect(loadExchangeRate(storage)).toBe(32.58);
    expect(saveExchangeRate(33.25, storage)).toBe(true);
    expect(loadExchangeRate(storage)).toBe(33.25);
    expect(saveExchangeRate(0, storage)).toBe(false);
    expect(loadExchangeRate(storage)).toBe(33.25);
  });
});
