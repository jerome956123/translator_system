import type { AudioSource, Direction, Language, LanguagePair, ListeningMode, Mode } from '../../shared/protocol';
import type { TranslationGuidance } from './guidance';
import type { Pace, Quality } from './config';

export interface TranslationResult {
  text: string;
  direction?: Direction;
  original?: string;
  corrections?: ContextCorrection[];
  inputTokens?: number;
  outputTokens?: number;
}

export interface ReviewCaption {
  captionId: string;
  revision: number;
  raw: string;
  original: string;
  translation: string;
  direction?: Direction;
  audioLanguage?: Language;
}

export interface ContextCorrection {
  captionId: string;
  revision: number;
  original: string;
  translation: string;
  confidence: 'high';
  evidence: string;
  sourceLanguage?: Language;
}

export interface TranslationTask {
  sessionId: string;
  utteranceId: string;
  captionId: string;
  paragraphId?: string;
  revision: number;
  text: string;
  context: string;
  direction: Direction;
  pair?: LanguagePair;
  audioLanguage?: Language;
  final: boolean;
  review?: ReviewCaption[];
  following?: string;
  vocabulary?: string[];
  guidance?: TranslationGuidance;
  quality?: Quality;
  recent?: [string, string][];
}

export interface SessionSettings {
  apiKey: string;
  direction: Direction;
  pair?: LanguagePair;
  mode: Mode;
  audioSource?: AudioSource;
  budgetUsd?: number;
  customVocabulary?: string[];
  guidance?: TranslationGuidance;
  quality?: Quality;
  pace?: Pace;
  /** 先前的 [原文, 譯文]，讓人名、術語與語氣前後一致。 */
  recent?: [string, string][];
  context?: string;
  precisionReview?: boolean;
  listeningMode?: ListeningMode;
}

export interface CaptionGap { startSeconds: number; endSeconds: number; message: string }

export interface Caption {
  origin?: 'precision' | 'live';
  /** 這不是一句話，而是「這段原音未能翻譯」的標記。 */
  gap?: CaptionGap;
  /** 已顯示過的譯文被後續校對改寫時，保留改寫前的版本供畫面標示差異。 */
  previousTranslation?: string;
  revisedAt?: number;
  id: string;
  sessionId: string;
  direction: Direction;
  receivedAt: number;
  paragraphId: string;
  revision: number;
  original: string;
  rawOriginal?: string;
  translation: string;
  translationRevision: number;
  originalFinal: boolean;
  translationFinal: boolean;
  corrected?: boolean;
}
