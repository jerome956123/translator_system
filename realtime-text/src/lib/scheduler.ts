import type { TranslationResult, TranslationTask } from './types';

interface Options {
  intervalMs: number;
  maxPending?: number;
  translate: (task: TranslationTask, requestId: string, onChunk: (text: string) => void, signal: AbortSignal) => Promise<TranslationResult>;
  onTranslation: (task: TranslationTask, requestId: string, text: string, complete: boolean) => void;
  onError: (message: string) => void;
}

export class TranslationScheduler {
  private pending = new Map<string, TranslationTask>();
  private latest = new Map<string, TranslationTask>();
  private cache = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private running = false;
  private closed = false;
  private lastStarted = -Infinity;
  private sequence = 0;
  private waiters = new Set<(finished: boolean) => void>();

  constructor(private options: Options) {}

  enqueue(task: TranslationTask) {
    if (this.closed || !task.text.trim()) return;
    const previous = this.latest.get(task.captionId);
    if (previous && previous.revision > task.revision) return;
    this.latest.set(task.captionId, task);
    this.pending.set(task.captionId, task);
    // 定稿不能因壅塞被悄悄捨棄；由場次控制器停止收音。
    if (this.pending.size > (this.options.maxPending ?? 16)) {
      this.options.onError('翻譯佇列已滿，已停止收音。請稍後重新開始。');
      return;
    }
    this.schedule();
  }

  remove(ids: string[]) {
    for (const id of ids) { this.latest.delete(id); this.pending.delete(id); }
  }

  private signature(task: TranslationTask) { return `${task.direction}\0${task.context}\0${task.text}`; }

  private current(task: TranslationTask) {
    const latest = this.latest.get(task.captionId);
    if (!latest || this.closed) return false;
    // 連續說話時允許顯示已翻完的前綴；否定、數字與等長修正不相容。
    return latest.text === task.text || (!latest.final && latest.text.startsWith(task.text));
  }

  private emit(task: TranslationTask, id: string, text: string, complete: boolean) {
    if (this.current(task)) this.options.onTranslation(task, id, text, complete);
  }

  private schedule() {
    if (this.closed || this.running || this.timer) return;
    if (!this.pending.size) { this.resolve(true); return; }
    this.timer = setTimeout(() => { this.timer = undefined; void this.next(); },
      Math.max(0, this.options.intervalMs - (Date.now() - this.lastStarted)));
  }

  private async next() {
    if (this.closed || this.running) return;
    const tasks = [...this.pending.values()];
    const task = tasks.find(value => value.final) ?? tasks[0];
    if (!task) { this.resolve(true); return; }
    this.pending.delete(task.captionId);
    this.running = true;
    const requestId = `${task.sessionId}-${++this.sequence}`;
    const signature = this.signature(task);
    try {
      const cached = this.cache.get(signature);
      if (cached !== undefined) this.emit(task, requestId, cached, true);
      else {
        this.lastStarted = Date.now();
        this.controller = new AbortController();
        // 每次請求最多等 12 秒，避免網路卡住後無限堆積。
        const timeout = setTimeout(() => this.controller?.abort(), 12000);
        try {
          const result = await this.options.translate(task, requestId, text => this.emit(task, requestId, text, false), this.controller.signal);
          if (!this.closed) {
            this.cache.set(signature, result.text);
            if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
            this.emit(task, requestId, result.text, true);
          }
        } finally { clearTimeout(timeout); }
      }
    } catch (error) {
      if (!this.closed) this.options.onError(error instanceof Error && error.name !== 'AbortError'
        ? error.message : '翻譯等待逾時，已停止收音並保留草稿。');
    } finally {
      this.running = false;
      this.controller = undefined;
      if (!this.closed) this.schedule();
    }
  }

  async flush(timeoutMs = 4500): Promise<boolean> {
    if (!this.running && !this.pending.size) return true;
    return new Promise(resolve => {
      const done = (finished: boolean) => { clearTimeout(timeout); this.waiters.delete(done); resolve(finished); };
      const timeout = setTimeout(() => done(false), timeoutMs);
      this.waiters.add(done);
      this.schedule();
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.controller?.abort();
    this.resolve(false);
  }

  private resolve(finished: boolean) { for (const done of [...this.waiters]) done(finished); }
}
