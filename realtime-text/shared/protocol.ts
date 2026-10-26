export const DIRECTIONS = {
  'zh-ja': { source: 'cmn-Hans-CN', sourceLabel: '繁體中文', target: 'ja', targetLabel: '日本語' },
  'ja-zh': { source: 'ja-JP', sourceLabel: '日本語', target: 'zh-Hant', targetLabel: '繁體中文' },
  'zh-en': { source: 'cmn-Hans-CN', sourceLabel: '繁體中文', target: 'en', targetLabel: 'English' },
  'en-zh': { source: 'en-US', sourceLabel: 'English', target: 'zh-Hant', targetLabel: '繁體中文' },
  'ja-en': { source: 'ja-JP', sourceLabel: '日本語', target: 'en', targetLabel: 'English' },
  'en-ja': { source: 'en-US', sourceLabel: 'English', target: 'ja', targetLabel: '日本語' },
} as const;

export type Direction = keyof typeof DIRECTIONS;
export type Language = 'zh' | 'ja' | 'en';
export const LANGUAGE_PAIRS = {
  'zh-ja': { languages: ['zh', 'ja'], label: '繁體中文 ↔ 日本語' },
  'zh-en': { languages: ['zh', 'en'], label: '繁體中文 ↔ English' },
  'ja-en': { languages: ['ja', 'en'], label: '日本語 ↔ English' },
} as const;
export type LanguagePair = keyof typeof LANGUAGE_PAIRS;
export type Mode = 'saving' | 'fast';
export type AudioSource = 'microphone' | 'display';

export type ClientMessage =
  | { type: 'start'; sessionId: string; direction: Direction; mode: Mode; budgetUsd?: number }
  | { type: 'stop'; sessionId: string };

export interface UsageSnapshot {
  audioSeconds: number;
  translationRequests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedUsd: number;
  isEstimate: boolean;
  tokenEstimate?: boolean;
}

export type ServerMessage =
  | { type: 'status'; sessionId: string; status: 'connecting' | 'ready' | 'listening' | 'finishing' | 'stopped'; message?: string }
  | { type: 'audio-level'; sessionId: string; level: number }
  | { type: 'transcript'; sessionId: string; captionId: string; paragraphId?: string; direction?: Direction; rawText?: string; revision: number; text: string; final: boolean; receivedAt: number }
  | { type: 'translation'; sessionId: string; captionId: string; revision: number; requestId: string; direction?: Direction; text: string; final: boolean; firstTokenAt?: number }
  | { type: 'caption-correction'; sessionId: string; captionId: string; revision: number; direction?: Direction; original: string; translation: string; final: boolean; corrected: boolean }
  | { type: 'usage'; sessionId: string; usage: UsageSnapshot }
  | { type: 'remove-captions'; sessionId: string; captionIds: string[] }
  | { type: 'warning'; sessionId: string; message: string }
  | { type: 'error'; sessionId: string; code: string; message: string; recoverable: boolean };

export function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && value in DIRECTIONS;
}
