import { DEFAULT_USD_TWD, validExchangeRate } from './currency';
import { LANGUAGE_PAIRS, type AudioSource, type Language, type LanguagePair, type ListeningMode, type TranslationMode } from '../../shared/protocol';
import { isPace, isQuality, type Pace, type Quality } from './config';
import { cleanScene, isJapaneseRegister, type JapaneseRegister } from './guidance';

// 個人使用：只存於目前瀏覽器的此網站，不寫入 HTML 或 GitHub。
export const API_KEY_STORAGE_KEY = 'realtime-translator.api-key.v1';
const VOCABULARY_STORAGE_KEY = 'realtime-translator.vocabulary.v1';
const EXCHANGE_RATE_STORAGE_KEY = 'realtime-translator.usd-twd.v1';
const PRECISION_STORAGE_KEY = 'realtime-translator.precision.v1';
const LISTENING_STORAGE_KEY = 'realtime-translator.listening-mode.v1';
const TRANSLATION_MODE_KEY = 'realtime-translator.translation-mode.v2';
const SCENE_STORAGE_KEY = 'realtime-translator.scene.v1';
const REGISTER_STORAGE_KEY = 'realtime-translator.ja-register.v1';
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
export const loadPrecisionReview = (storage?: KeyStorage) => loadPreference(PRECISION_STORAGE_KEY, storage) === 'on';
export const savePrecisionReview = (value: boolean, storage?: KeyStorage) => savePreference(PRECISION_STORAGE_KEY, value ? 'on' : '', storage);
export const loadListeningMode = (storage?: KeyStorage): ListeningMode => loadPreference(LISTENING_STORAGE_KEY, storage) === 'automatic' ? 'automatic' : 'push-to-talk';
export const saveListeningMode = (value: ListeningMode, storage?: KeyStorage) => savePreference(LISTENING_STORAGE_KEY, value, storage);
export function loadTranslationMode(storage?: KeyStorage): TranslationMode {
  const saved = loadPreference(TRANSLATION_MODE_KEY, storage);
  return saved === 'push-to-talk' || saved === 'face-to-face' ? saved : 'precision';
}
export const saveTranslationMode = (value: TranslationMode, storage?: KeyStorage) => savePreference(TRANSLATION_MODE_KEY, value, storage);
export const loadScene = (storage?: KeyStorage) => cleanScene(loadPreference(SCENE_STORAGE_KEY, storage));
export const saveScene = (value: string, storage?: KeyStorage) => savePreference(SCENE_STORAGE_KEY, cleanScene(value), storage);
export function loadJapaneseRegister(storage?: KeyStorage): JapaneseRegister {
  const saved = loadPreference(REGISTER_STORAGE_KEY, storage);
  return isJapaneseRegister(saved) ? saved : 'auto';
}
export const saveJapaneseRegister = (value: JapaneseRegister, storage?: KeyStorage) =>
  savePreference(REGISTER_STORAGE_KEY, value === 'auto' ? '' : value, storage);

// 其餘介面選擇：值不在允許範圍內時一律回到預設。
function choice<T extends string>(key: string, allowed: (value: unknown) => value is T, fallback: T) {
  return {
    load: (storage?: KeyStorage): T => { const saved = loadPreference(key, storage); return allowed(saved) ? saved : fallback; },
    save: (value: T, storage?: KeyStorage) => savePreference(key, value === fallback ? '' : value, storage),
  };
}
function flag(key: string, fallback: boolean) {
  return {
    load: (storage?: KeyStorage): boolean => { const saved = loadPreference(key, storage); return saved === 'on' ? true : saved === 'off' ? false : fallback; },
    save: (value: boolean, storage?: KeyStorage) => savePreference(key, value === fallback ? '' : value ? 'on' : 'off', storage),
  };
}
export type Theme = 'auto' | 'dark' | 'light';
const isTheme = (value: unknown): value is Theme => value === 'auto' || value === 'dark' || value === 'light';
const isAudioSource = (value: unknown): value is AudioSource => value === 'microphone' || value === 'display';
const isLanguagePair = (value: unknown): value is LanguagePair => typeof value === 'string' && value in LANGUAGE_PAIRS;
export const pairPreference = choice<LanguagePair>('realtime-translator.pair.v1', isLanguagePair, 'zh-ja');
export const qualityPreference = choice<Quality>('realtime-translator.quality.v1', isQuality, 'economy');
export const pacePreference = choice<Pace>('realtime-translator.pace.v1', isPace, 'standard');
export const themePreference = choice<Theme>('realtime-translator.theme.v1', isTheme, 'auto');
export const audioSourcePreference = choice<AudioSource>('realtime-translator.audio-source.v1', isAudioSource, 'microphone');
export const showOriginalPreference = flag('realtime-translator.show-original.v1', true);
export const autoResumePreference = flag('realtime-translator.auto-resume.v1', true);
export const autoSpeakPreference = flag('realtime-translator.auto-speak.v1', false);
// 面對面對講：自己這一側的語言，以及對面那一半是否上下顛倒（auto 表示觸控裝置才顛倒）。
export type FaceFlip = 'auto' | 'on' | 'off';
const isLanguage = (value: unknown): value is Language => value === 'zh' || value === 'ja' || value === 'en';
const isFaceFlip = (value: unknown): value is FaceFlip => value === 'auto' || value === 'on' || value === 'off';
export const faceNearPreference = choice<Language>('realtime-translator.face-near.v1', isLanguage, 'zh');
export const faceFlipPreference = choice<FaceFlip>('realtime-translator.face-flip.v1', isFaceFlip, 'auto');
export const faceSpeakPreference = flag('realtime-translator.face-speak.v1', false);
const BUDGET_STORAGE_KEY = 'realtime-translator.budget-twd.v1';
export const loadBudget = (storage?: KeyStorage) => loadPreference(BUDGET_STORAGE_KEY, storage).slice(0, 12);
export const saveBudget = (value: string, storage?: KeyStorage) => savePreference(BUDGET_STORAGE_KEY, value.slice(0, 12), storage);
// 字幕字級倍率：0.85–1.8，每次調整 0.15。
export const FONT_SCALE = { min: 0.85, max: 1.8, step: 0.15 };
const FONT_SCALE_KEY = 'realtime-translator.font-scale.v1';
export const clampFontScale = (value: number) => Number.isFinite(value)
  ? Math.round(Math.min(FONT_SCALE.max, Math.max(FONT_SCALE.min, value)) * 100) / 100 : 1;
export const loadFontScale = (storage?: KeyStorage) => { const saved = loadPreference(FONT_SCALE_KEY, storage); return saved ? clampFontScale(Number(saved)) : 1; };
export const saveFontScale = (value: number, storage?: KeyStorage) => savePreference(FONT_SCALE_KEY, clampFontScale(value) === 1 ? '' : String(clampFontScale(value)), storage);

export function loadExchangeRate(storage?: KeyStorage): number {
  const saved = Number(loadPreference(EXCHANGE_RATE_STORAGE_KEY, storage));
  return validExchangeRate(saved) ? saved : DEFAULT_USD_TWD;
}
export function saveExchangeRate(value: number, storage?: KeyStorage): boolean {
  return validExchangeRate(value) && savePreference(EXCHANGE_RATE_STORAGE_KEY, String(value), storage);
}

export function parseVocabulary(value: string): string[] {
  return [...new Set(value.split(/[\n,，、;；]+/u).map(term => term.trim()).filter(Boolean))]
    .filter(term => term.length <= 200).slice(0, 100);
}
