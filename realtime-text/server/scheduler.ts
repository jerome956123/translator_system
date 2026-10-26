import { randomUUID } from 'node:crypto';
import type { Direction } from '../shared/protocol.js';
import type { TranslationResult } from './translator.js';

export interface TranslationTask {
  sessionId: string;
  captionId: string;
  revision: number;
  text: string;
  context: string;
  direction: Direction;
  final: boolean;
}

interface SchedulerOptions {
  intervalMs: number;
  maxFinalQueue?: number;
  translate: (task: TranslationTask, requestId: string, onChunk: (text: string) => void) => Promise<TranslationResult>;
  onTranslation: (event: TranslationTask & { requestId: string; translatedText: string; complete: boolean; firstTokenAt?: number }) => void;
  onUsage: (requestId: string, result: TranslationResult, task: TranslationTask) => void;
  onWarning: (message: string) => void;
}

export function isMeaningfulChange(previous: string, next: string) {
  const a = previous.trim();
  const b = next.trim();
  if (!b || a === b) return false;
  if (!a) return true;
  const normalize = (value: string) => value.replace(/[\s，。！？、,.!?]/g, '');
  return normalize(a) !== normalize(b);
}

export class TranslationScheduler {
  private readonly options: SchedulerOptions;
  private finals: TranslationTask[] = [];
  private draft: TranslationTask | null = null;
  private running = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastStartedAt = 0;
  private latestRevision = new Map<string, number>();
  private lastQueuedText = new Map<string, string>();
  private cache = new Map<string, string>();
  private idleResolvers: Array<() => void> = [];

  constructor(options: SchedulerOptions) {
    this.options = options;
  }

  enqueue(task: TranslationTask) {
    if (this.closed || !task.text.trim()) return;
    this.latestRevision.set(task.captionId, task.revision);
    const previous = this.lastQueuedText.get(task.captionId) ?? '';
    if (!task.final && !isMeaningfulChange(previous, task.text)) return;
    this.lastQueuedText.set(task.captionId, task.text);
    if (task.final) {
      this.finals.push(task);
      if (this.finals.length > (this.options.maxFinalQueue ?? 8)) {
        this.options.onWarning('翻譯處理速度跟不上語音，已停止建立更多請求。請先停止收音。');
        this.finals = this.finals.slice(-(this.options.maxFinalQueue ?? 8));
      }
      if (this.draft?.captionId === task.captionId) this.draft = null;
    } else {
      this.draft = task;
    }
    this.schedule(task.final ? 0 : this.options.intervalMs);
  }

  private schedule(delay: number) {
    if (this.running || this.timer || this.closed) return;
    const remaining = Math.max(0, this.options.intervalMs - (Date.now() - this.lastStartedAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.processNext();
    }, Math.max(delay === 0 ? 0 : remaining, 0));
  }

  private signature(task: TranslationTask) {
    return `${task.direction}\u0000${task.context}\u0000${task.text.trim()}`;
  }

  private stillCurrent(task: TranslationTask) {
    return this.latestRevision.get(task.captionId) === task.revision;
  }

  private async processNext() {
    if (this.running || this.closed) return;
    const task = this.finals.shift() ?? this.draft;
    if (!task) return this.resolveIdle();
    if (this.draft === task) this.draft = null;
    this.running = true;
    this.lastStartedAt = Date.now();
    const requestId = randomUUID();
    const cached = this.cache.get(this.signature(task));
    try {
      if (cached) {
        if (this.stillCurrent(task)) this.options.onTranslation({ ...task, requestId, translatedText: cached, complete: true });
      } else {
        let firstTokenAt: number | undefined;
        const result = await this.options.translate(task, requestId, (translatedText) => {
          firstTokenAt ??= Date.now();
          if (this.stillCurrent(task)) this.options.onTranslation({ ...task, requestId, translatedText, complete: false, firstTokenAt });
        });
        this.options.onUsage(requestId, result, task);
        this.cache.set(this.signature(task), result.text);
        if (this.stillCurrent(task)) this.options.onTranslation({ ...task, requestId, translatedText: result.text, complete: true, firstTokenAt });
      }
    } catch (error) {
      this.options.onWarning(error instanceof Error ? error.message : '翻譯失敗');
    } finally {
      this.running = false;
      if (this.finals.length || this.draft) this.schedule(0);
      else this.resolveIdle();
    }
  }

  async flush(timeoutMs = 3500) {
    if (!this.running && !this.finals.length && !this.draft) return;
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs);
      this.idleResolvers.push(() => { clearTimeout(timeout); resolve(); });
      this.schedule(0);
    });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.finals = [];
    this.draft = null;
    this.resolveIdle();
  }

  private resolveIdle() {
    if (this.running || this.finals.length || this.draft) return;
    this.idleResolvers.splice(0).forEach((resolve) => resolve());
  }
}
