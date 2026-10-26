import { DIRECTIONS, type ServerMessage } from '../../shared/protocol';
import { AudioCapture } from '../audio/capture';
import { readableError } from './config';
import { GeminiBrowserSTT, type STTConnection } from './stt';
import { TranslationScheduler } from './scheduler';
import { TranscriptAssembler } from './transcripts';
import { streamTranslation } from './translator';
import { UsageTracker } from './usage';
import { sourceText, translatedText } from './chinese';
import type { SessionSettings, TranslationTask, TranslationResult, ReviewCaption } from './types';

interface Capture {
  prepare: () => Promise<void>;
  start: (onChunk: (chunk: ArrayBuffer) => void) => Promise<void>;
  stop: (flush?: boolean) => Promise<void>;
}
interface Dependencies {
  capture?: Capture;
  createSTT?: (callbacks: { onInterim: (text: string) => void; onFinal: (text: string) => void; onError: (message: string) => void }) => STTConnection;
  translate?: typeof streamTranslation;
}

export class BrowserTranslationSession {
  readonly id = crypto.randomUUID();
  private capture: Capture;
  private stt: STTConnection;
  private scheduler: TranslationScheduler;
  private assembler: TranscriptAssembler;
  private usage = new UsageTracker();
  private stopping = false;
  private disposed = false;
  private ready = false;
  private started = false;
  private finishing?: Promise<void>;
  private lastUsage = 0;
  private finalArrived?: () => void;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private tasks = new Map<string, TranslationTask>();
  private receivedAt = new Map<string, number>();
  private edited = new Map<string, { original: string; translation: string }>();

  constructor(private settings: SessionSettings, private emit: (event: ServerMessage) => void, dependencies: Dependencies = {}) {
    this.capture = dependencies.capture ?? new AudioCapture();
    this.assembler = new TranscriptAssembler(this.id, settings.direction);
    const callbacks = {
      onInterim: (text: string) => this.transcript(text, false),
      onFinal: (text: string) => { this.transcript(text, true); this.finalArrived?.(); },
      onError: (message: string) => { if (!this.stopping && !this.disposed) this.fail(message); },
    };
    this.stt = dependencies.createSTT?.(callbacks) ?? new GeminiBrowserSTT(callbacks);
    this.scheduler = new TranslationScheduler({
      intervalMs: settings.mode === 'fast' ? 1000 : 1500,
      prepareTask: task => this.prepareTranslation(task),
      translate: (task, requestId, onChunk, signal) => (dependencies.translate ?? streamTranslation)({
        ...task, apiKey: settings.apiKey, signal, onChunk,
        onUsage: (input, output, inputTokens, outputTokens) => {
          this.usage.record(requestId, input, output, inputTokens, outputTokens);
          this.sendUsage(); this.budget();
        },
      }),
      onTranslation: (task, requestId, text, complete) => {
        const localized = translatedText(text, settings.direction);
        this.edited.set(task.captionId, { original: this.edited.get(task.captionId)?.original ?? task.text, translation: localized });
        this.send({ type: 'translation', sessionId: this.id, captionId: task.captionId, revision: task.revision,
          requestId, text: localized, final: task.final && complete });
      },
      onResult: (task, _requestId, result) => this.applyResult(task, result),
      onError: message => { if (!this.disposed) this.fail(message); },
    });
  }

  private prepareTranslation(task: TranslationTask): TranslationTask {
    const tasks = [...this.tasks.values()];
    const index = tasks.findIndex(item => item.captionId === task.captionId);
    const preceding = tasks.slice(0, Math.max(0, index));
    const review: ReviewCaption[] = preceding.filter(item => item.final
      && Date.now() - (this.receivedAt.get(item.captionId) ?? 0) <= 45000).slice(-2).map(item => ({
      captionId: item.captionId, revision: item.revision, raw: item.text,
      original: this.edited.get(item.captionId)?.original ?? item.text,
      translation: this.edited.get(item.captionId)?.translation ?? '',
    }));
    return { ...task, review,
      context: [this.settings.context ?? '', ...preceding.slice(-4)
        .map(item => this.edited.get(item.captionId)?.original ?? item.text)].filter(Boolean).join('\n').slice(-512),
      following: tasks.slice(index + 1, index + 3).map(item => item.text).join('\n').slice(0, 220),
      vocabulary: this.settings.customVocabulary ?? [],
    };
  }

  private applyResult(task: TranslationTask, result: TranslationResult) {
    if (this.disposed) return;
    const current = this.tasks.get(task.captionId);
    // 相容前綴可以先顯示譯文，但不能用舊句的校對結果覆寫新原文。
    if (!current || current.revision !== task.revision || current.text !== task.text) return;
    if (result.original?.trim()) this.applyEdit(current, result.original, result.text);
    for (const correction of result.corrections ?? []) {
      const supplied = task.review?.find(item => item.captionId === correction.captionId && item.revision === correction.revision);
      const target = this.tasks.get(correction.captionId);
      if (!supplied || !target?.final || target.revision !== supplied.revision || target.text !== supplied.raw
        || correction.confidence !== 'high' || !correction.evidence.trim()
        || Date.now() - (this.receivedAt.get(target.captionId) ?? 0) > 45000) continue;
      // 校正最近的同音詞；不讓舊待譯工作再把修正後的譯文蓋回去。
      this.scheduler.remove([target.captionId]);
      this.applyEdit(target, correction.original, correction.translation);
    }
  }

  private applyEdit(task: TranslationTask, original: string, translation: string) {
    if (!original.trim() || !translation.trim()) return;
    const localized = { original: sourceText(original.trim(), this.settings.direction),
      translation: translatedText(translation.trim(), this.settings.direction) };
    this.edited.set(task.captionId, localized);
    this.send({ type: 'caption-correction', sessionId: this.id, captionId: task.captionId,
      revision: task.revision, ...localized, final: task.final, corrected: localized.original !== task.text });
  }

  private send(event: ServerMessage) { if (!this.disposed) this.emit(event); }
  private status(status: 'connecting' | 'listening' | 'finishing' | 'stopped', message: string) {
    this.send({ type: 'status', sessionId: this.id, status, message });
  }

  async start() {
    if (this.disposed || this.stopping || this.started) return;
    this.started = true;
    this.status('connecting', '請允許麥克風，連線完成後再開始說話。');
    try {
      // 先解鎖音訊處理，再等待網路；符合手機瀏覽器的使用者手勢要求。
      await this.capture.prepare();
      if (this.stopping || this.disposed) return;
      await this.stt.connect(this.settings.apiKey, DIRECTIONS[this.settings.direction].source, this.settings.customVocabulary);
      if (this.stopping || this.disposed) return;
      this.ready = true;
      await this.capture.start(chunk => this.audio(chunk));
      if (!this.stopping && !this.disposed) this.status('listening', 'Gemini AI 正在聆聽。草稿會隨後續語音修正，短暫停頓會接在同一段。');
    } catch (error) {
      if (!this.stopping && !this.disposed) {
        const hint = error instanceof DOMException && error.name === 'NotAllowedError'
          ? '無法使用麥克風。請確認網址為 HTTPS，並允許此網站使用麥克風。'
          : error instanceof DOMException && error.name === 'NotFoundError' ? '找不到麥克風，請確認裝置已連接。' : readableError(error);
        this.fail(hint);
      }
    }
  }

  private audio(chunk: ArrayBuffer) {
    if (!this.ready || this.disposed) return;
    try {
      if (this.stt.sendAudio(chunk)) {
        this.usage.addAudioBytes(chunk.byteLength);
        if (Date.now() - this.lastUsage > 1000) this.sendUsage();
        this.budget();
      }
    } catch (error) { this.fail(readableError(error)); }
  }

  private transcript(text: string, final: boolean) {
    if (this.disposed || !text.trim()) return;
    const { changed, removed } = this.assembler.update(sourceText(text, this.settings.direction), final);
    if (removed.length) {
      this.scheduler.remove(removed);
      for (const id of removed) { this.tasks.delete(id); this.edited.delete(id); this.receivedAt.delete(id); }
      this.send({ type: 'remove-captions', sessionId: this.id, captionIds: removed });
    }
    for (const task of changed) {
      this.tasks.set(task.captionId, task);
      this.receivedAt.set(task.captionId, Date.now());
      this.edited.delete(task.captionId);
      this.send({ type: 'transcript', sessionId: this.id, captionId: task.captionId, revision: task.revision,
        paragraphId: task.paragraphId, text: task.text, final: task.final, receivedAt: Date.now() });
      this.scheduler.enqueue(task);
    }
    while (this.tasks.size > 64) {
      const oldest = this.tasks.keys().next().value!;
      this.tasks.delete(oldest); this.edited.delete(oldest); this.receivedAt.delete(oldest);
    }
  }

  private sendUsage() {
    this.lastUsage = Date.now();
    this.send({ type: 'usage', sessionId: this.id, usage: this.usage.snapshot() });
  }

  private budget() {
    if (this.settings.budgetUsd && this.usage.snapshot().estimatedUsd >= this.settings.budgetUsd && !this.disposed) {
      this.fail('估算費用已達本場上限，已停止收音與新請求。已送出的用量仍可能產生費用。');
    }
  }

  stop(message = '正在收尾，請稍候…'): Promise<void> {
    if (this.finishing) return this.finishing;
    if (this.disposed) return Promise.resolve();
    this.stopping = true;
    this.status('finishing', message);
    this.finishing = this.finish();
    return this.finishing;
  }

  private async finish() {
    await this.capture.stop(true);
    if (this.disposed) return;
    if (this.ready) {
      await new Promise<void>(resolve => {
        this.finalArrived = () => { clearTimeout(this.finishTimer); resolve(); };
        this.finishTimer = setTimeout(resolve, 1800);
        this.stt.endAudio();
      });
    } else this.stt.close();
    if (this.disposed) return;
    this.finalArrived = undefined;
    this.ready = false;
    this.stt.close();
    const finished = await this.scheduler.flush(8000);
    if (this.disposed) return;
    this.sendUsage();
    this.status('stopped', finished ? '已停止，字幕可以複製或下載。' : '已停止；尚未完成的內容保留為草稿。');
    this.dispose();
  }

  private fail(message: string) {
    if (this.disposed) return;
    this.sendUsage();
    this.send({ type: 'error', sessionId: this.id, code: 'SESSION_ERROR', message, recoverable: false });
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopping = true;
    this.ready = false;
    clearTimeout(this.finishTimer);
    this.finalArrived?.();
    this.finalArrived = undefined;
    this.scheduler.close();
    this.stt.close();
    void this.capture.stop(false);
  }
}
