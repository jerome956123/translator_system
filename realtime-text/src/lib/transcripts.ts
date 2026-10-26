import type { Direction } from '../../shared/protocol';
import { CONTEXT_MAX_CHARS } from './config';
import { joinSpeech } from './paragraphs';
import type { TranslationTask } from './types';

// 有限長度的翻譯工作單位，不是畫面的換行單位；同段會連續呈現。
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
  private paragraph = 1;
  private paragraphLength = 0;
  private previousSentenceEnded = false;
  private lastFinalAt = 0;
  private awaitingNext = false;
  private prefix = '';
  private lastFinalText = '';
  constructor(private sessionId: string, private direction: Direction, private now = Date.now) {}

  update(input: string, final: boolean) {
    if (this.awaitingNext) {
      this.awaitingNext = false;
      // 同一句中途換氣：延長目前文字，讓 AI 重譯尚未完整的句子。
      // 保留有限長度，避免每次把整個段落送去重翻。
      if (!this.previousSentenceEnded && this.now() - this.lastFinalAt < 3000 && this.lastFinalText.length < 220) {
        this.prefix = this.lastFinalText;
      } else {
        this.recent = [...this.recent, this.lastFinalText].slice(-2);
        this.prefix = '';
        this.active = [];
        this.utterance += 1;
      }
    }
    // 先前一句完整，且段落夠長或確實停頓較久，才在下一句開始新段。
    // 語音服務的 final 只代表辨識定稿，不能直接當成段落結束。
    if (!this.active.length && this.paragraphLength && this.previousSentenceEnded
      && (this.paragraphLength >= 120 || this.now() - this.lastFinalAt >= 3000)) {
      this.paragraph += 1;
      this.paragraphLength = 0;
    }
    const text = joinSpeech(this.prefix, input);
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
        paragraphId: `${this.sessionId}-p${this.paragraph}`,
        revision: (previous?.revision ?? 0) + 1, text: part, context, direction: this.direction, final,
      };
      changed.push(task);
      return task;
    });
    if (final) {
      this.paragraphLength += Array.from(input.trim()).length;
      this.previousSentenceEnded = /[。！？.!?][」』”’"')\]]*$/u.test(text.trim());
      this.lastFinalAt = this.now();
      this.lastFinalText = text;
      this.awaitingNext = true;
    }
    return { changed, removed };
  }
}
