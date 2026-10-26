import type { Direction, Language, LanguagePair, Mode } from '../../shared/protocol';

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
}

export interface SessionSettings {
  apiKey: string;
  direction: Direction;
  pair?: LanguagePair;
  mode: Mode;
  budgetUsd?: number;
  customVocabulary?: string[];
  context?: string;
}

export interface Caption {
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
