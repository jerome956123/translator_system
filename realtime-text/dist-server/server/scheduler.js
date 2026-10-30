import { randomUUID } from 'node:crypto';
export function isMeaningfulChange(previous, next) {
    const a = previous.trim();
    const b = next.trim();
    if (!b || a === b)
        return false;
    if (!a)
        return true;
    const normalize = (value) => value.replace(/[\s，。！？、,.!?]/g, '');
    return normalize(a) !== normalize(b);
}
export class TranslationScheduler {
    options;
    finals = [];
    draft = null;
    running = false;
    closed = false;
    timer = null;
    lastStartedAt = 0;
    latestRevision = new Map();
    lastQueuedText = new Map();
    cache = new Map();
    idleResolvers = [];
    constructor(options) {
        this.options = options;
    }
    enqueue(task) {
        if (this.closed || !task.text.trim())
            return;
        this.latestRevision.set(task.captionId, task.revision);
        const previous = this.lastQueuedText.get(task.captionId) ?? '';
        if (!task.final && !isMeaningfulChange(previous, task.text))
            return;
        this.lastQueuedText.set(task.captionId, task.text);
        if (task.final) {
            this.finals.push(task);
            if (this.finals.length > (this.options.maxFinalQueue ?? 8)) {
                this.options.onWarning('翻譯處理速度跟不上語音，已停止建立更多請求。請先停止收音。');
                this.finals = this.finals.slice(-(this.options.maxFinalQueue ?? 8));
            }
            if (this.draft?.captionId === task.captionId)
                this.draft = null;
        }
        else {
            this.draft = task;
        }
        this.schedule(task.final ? 0 : this.options.intervalMs);
    }
    schedule(delay) {
        if (this.running || this.timer || this.closed)
            return;
        const remaining = Math.max(0, this.options.intervalMs - (Date.now() - this.lastStartedAt));
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.processNext();
        }, Math.max(delay === 0 ? 0 : remaining, 0));
    }
    signature(task) {
        return `${task.direction}\u0000${task.context}\u0000${task.text.trim()}`;
    }
    stillCurrent(task) {
        return this.latestRevision.get(task.captionId) === task.revision;
    }
    async processNext() {
        if (this.running || this.closed)
            return;
        const task = this.finals.shift() ?? this.draft;
        if (!task)
            return this.resolveIdle();
        if (this.draft === task)
            this.draft = null;
        this.running = true;
        this.lastStartedAt = Date.now();
        const requestId = randomUUID();
        const cached = this.cache.get(this.signature(task));
        try {
            if (cached) {
                if (this.stillCurrent(task))
                    this.options.onTranslation({ ...task, requestId, translatedText: cached, complete: true });
            }
            else {
                let firstTokenAt;
                const result = await this.options.translate(task, requestId, (translatedText) => {
                    firstTokenAt ??= Date.now();
                    if (this.stillCurrent(task))
                        this.options.onTranslation({ ...task, requestId, translatedText, complete: false, firstTokenAt });
                });
                this.options.onUsage(requestId, result, task);
                this.cache.set(this.signature(task), result.text);
                if (this.stillCurrent(task))
                    this.options.onTranslation({ ...task, requestId, translatedText: result.text, complete: true, firstTokenAt });
            }
        }
        catch (error) {
            this.options.onWarning(error instanceof Error ? error.message : '翻譯失敗');
        }
        finally {
            this.running = false;
            if (this.finals.length || this.draft)
                this.schedule(0);
            else
                this.resolveIdle();
        }
    }
    async flush(timeoutMs = 3500) {
        if (!this.running && !this.finals.length && !this.draft)
            return;
        return new Promise((resolve) => {
            const timeout = setTimeout(resolve, timeoutMs);
            this.idleResolvers.push(() => { clearTimeout(timeout); resolve(); });
            this.schedule(0);
        });
    }
    close() {
        this.closed = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        this.finals = [];
        this.draft = null;
        this.resolveIdle();
    }
    resolveIdle() {
        if (this.running || this.finals.length || this.draft)
            return;
        this.idleResolvers.splice(0).forEach((resolve) => resolve());
    }
}
//# sourceMappingURL=scheduler.js.map