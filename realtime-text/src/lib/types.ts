import type { Direction, Mode } from '../../shared/protocol';

export interface TranslationResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
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
  final: boolean;
}

export interface SessionSettings {
  apiKey: string;
  direction: Direction;
  mode: Mode;
  budgetUsd?: number;
  customVocabulary?: string[];
}

export interface Caption {
  id: string;
  paragraphId: string;
  revision: number;
  original: string;
  translation: string;
  translationRevision: number;
  originalFinal: boolean;
  translationFinal: boolean;
}
