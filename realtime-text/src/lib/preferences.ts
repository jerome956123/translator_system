// 個人使用：只存於目前瀏覽器的此網站，不寫入 HTML 或 GitHub。
export const API_KEY_STORAGE_KEY = 'realtime-translator.api-key.v1';
const VOCABULARY_STORAGE_KEY = 'realtime-translator.vocabulary.v1';
type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function loadPreference(key: string, storage?: KeyStorage): string {
  try { return (storage ?? window.localStorage).getItem(key)?.trim() ?? ''; }
  catch { return ''; }
}

function savePreference(key: string, value: string, storage?: KeyStorage): boolean {
  try {
    const target = storage ?? window.localStorage;
    if (value.trim()) target.setItem(key, value.trim());
    else target.removeItem(key);
    return true;
  } catch { return false; }
}

export const loadApiKey = (storage?: KeyStorage) => loadPreference(API_KEY_STORAGE_KEY, storage);
export const saveApiKey = (value: string, storage?: KeyStorage) => savePreference(API_KEY_STORAGE_KEY, value, storage);
export const loadVocabulary = () => loadPreference(VOCABULARY_STORAGE_KEY);
export const saveVocabulary = (value: string) => savePreference(VOCABULARY_STORAGE_KEY, value);

export function parseVocabulary(value: string): string[] {
  return [...new Set(value.split(/[\n,，、;；]+/u).map(term => term.trim()).filter(Boolean))]
    .filter(term => term.length <= 200).slice(0, 100);
}
