import type { Direction } from '../../shared/protocol';
import { CONTEXT_MAX_CHARS } from './config';
import type { TranslationTask } from './types';

// 只切分文字顯示單位；音訊串流保持同一連線。位置改動時以同一單位的新版本修正。
export function splitCaption(text: string, maxLength = 110): string[] {
  const result: string[] = [];
  let rest = text.trim();
  while (rest.length > maxLength) {
    const prefix = rest.slice(0, maxLength);
    let boundary = -1;
    for (let i = 28; i < prefix.length; i++) if (/[。！？.!?，,、；;\s]/.test(prefix[i])) boundary = i + 1;
    if (boundary < 0) boundary = maxLength;
    // 不切開 UTF-16 surrogate pair。
    if (/[\uD800-\uDBFF]/.test(rest[boundary - 1])) boundary -= 1;
    result.push(rest.slice(0, boundary));
    rest = rest.slice(boundary);
  }
  if (rest) result.push(rest);
  return result;
}

export class TranscriptAssembler {
  private utterance = 1;
  private active: TranslationTask[] = [];
  private recent: string[] = [];
  constructor(private sessionId: string, private direction: Direction) {}

  update(text: string, final: boolean) {
    const parts = splitCaption(text);
    const removed = this.active.slice(parts.length).map(task => task.captionId);
    const changed: TranslationTask[] = [];
    const utteranceId = `${this.sessionId}-u${this.utterance}`;
    this.active = parts.map((part, index) => {
      const previous = this.active[index];
      const context = [...this.recent, ...parts.slice(0, index)].join('\n').slice(-CONTEXT_MAX_CHARS);
      if (previous && previous.text === part && previous.context === context && previous.final === final) return previous;
      const task: TranslationTask = {
        sessionId: this.sessionId, utteranceId, captionId: `${utteranceId}-c${index + 1}`,
        revision: (previous?.revision ?? 0) + 1, text: part, context, direction: this.direction, final,
      };
      changed.push(task);
      return task;
    });
    if (final) {
      this.recent = [...this.recent, text].slice(-2);
      this.active = [];
      this.utterance += 1;
    }
    return { changed, removed };
  }
}
