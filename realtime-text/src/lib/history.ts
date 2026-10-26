import type { Direction, ServerMessage } from '../../shared/protocol';
import type { Caption } from './types';

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
      id: event.captionId, sessionId: event.sessionId, direction, receivedAt: event.receivedAt,
      paragraphId: event.paragraphId ?? event.captionId, revision: event.revision,
      original: event.text, translation: '', translationRevision: 0,
      originalFinal: event.final, translationFinal: false, corrected: false,
    }];
    if (existing.revision > event.revision) return items;
    return items.map(item => item.id === event.captionId ? { ...item, revision: event.revision,
      original: event.text, originalFinal: event.final, translationFinal: false, corrected: false } : item);
  }
  if (event.type === 'translation') return items.map(item => item.id === event.captionId
    && item.sessionId === event.sessionId && event.revision >= item.translationRevision
    ? { ...item, translation: event.text, translationRevision: event.revision,
      translationFinal: event.final && item.revision === event.revision } : item);
  if (event.type === 'caption-correction') return items.map(item => item.id === event.captionId
    && item.sessionId === event.sessionId && item.revision === event.revision
    ? { ...item, original: event.original, translation: event.translation, corrected: event.corrected,
      translationRevision: event.revision, originalFinal: event.final, translationFinal: event.final } : item);
  return items;
}
