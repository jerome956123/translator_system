import type { Direction, ServerMessage } from '../../shared/protocol';
import type { Caption } from './types';
import { sourceText } from './chinese';

type Action = { type: 'start-session' } | { type: 'clear-history' }
  | { type: 'message'; event: ServerMessage; direction: Direction };

export function captionHistory(items: Caption[], action: Action): Caption[] {
  // 開新場次／換語言只切換收音來源，保留先前的紀錄。
  if (action.type === 'start-session') return items;
  if (action.type === 'clear-history') return [];
  const { event, direction } = action;
  if (event.type === 'remove-captions') return items.filter(item => !event.captionIds.includes(item.id));
  if (event.type === 'transcript') {
    const existing = items.find(item => item.id === event.captionId);
    if (!existing) return [...items, {
      id: event.captionId, sessionId: event.sessionId, direction: event.direction ?? direction, receivedAt: event.receivedAt,
      paragraphId: event.paragraphId ?? event.captionId, revision: event.revision,
      original: event.text, rawOriginal: event.rawText ?? event.text, translation: '', translationRevision: 0,
      originalFinal: event.final, translationFinal: false, corrected: false,
    }];
    if (existing.revision > event.revision) return items;
    return items.map(item => item.id === event.captionId ? { ...item, revision: event.revision,
      direction: event.direction ?? item.direction, rawOriginal: event.rawText ?? event.text,
      translation: event.direction && event.direction !== item.direction ? '' : item.translation,
      original: event.text, originalFinal: event.final, translationFinal: false, corrected: false } : item);
  }
  if (event.type === 'translation') return items.map(item => item.id === event.captionId
    && item.sessionId === event.sessionId && event.revision >= item.translationRevision
    && (event.revision >= item.revision || !event.direction || event.direction === item.direction)
    ? { ...item, translation: event.text, translationRevision: event.revision,
      direction: event.direction ?? item.direction,
      original: event.direction && event.direction !== item.direction ? sourceText(item.rawOriginal ?? item.original, event.direction) : item.original,
      translationFinal: event.final && item.revision === event.revision } : item);
  if (event.type === 'caption-correction') return items.map(item => item.id === event.captionId
    && item.sessionId === event.sessionId && item.revision === event.revision
    ? { ...item, original: event.original, translation: event.translation, corrected: event.corrected, direction: event.direction ?? item.direction,
      translationRevision: event.revision, originalFinal: event.final, translationFinal: event.final } : item);
  return items;
}
