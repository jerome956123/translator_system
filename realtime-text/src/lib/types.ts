import type { Direction, Mode } from '../../shared/protocol';

export interface TranslationResult {
  text: string;
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
}

export interface ContextCorrection {
  captionId: string;
  revision: number;
  original: string;
  translation: string;
  confidence: 'high';
  evidence: string;
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
  review?: ReviewCaption[];
  following?: string;
  vocabulary?: string[];
}

export interface SessionSettings {
  apiKey: string;
  direction: Direction;
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
  translation: string;
  translationRevision: number;
  originalFinal: boolean;
  translationFinal: boolean;
  corrected?: boolean;
}
