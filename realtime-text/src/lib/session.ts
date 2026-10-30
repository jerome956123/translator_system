import { DIRECTIONS, type Direction, type Language, type ServerMessage } from '../../shared/protocol';
import { AudioCapture, pcmLevel } from '../audio/capture';
import { RecentAudio } from '../audio/recent-audio';
import { readableError } from './config';
import { GeminiBrowserSTT, type STTConnection } from './stt';
import { TranslationScheduler } from './scheduler';
import { TranscriptAssembler } from './transcripts';
import { streamTranslation } from './translator';
import { UsageTracker } from './usage';
import { sourceText, translatedText } from './chinese';
import type { SessionSettings, TranslationTask, TranslationResult, ReviewCaption } from './types';
import { directionSource, directionFor, isPairLanguage, languageFromCode, previewDirection } from './languages';

interface Capture {
  prepare: () => Promise<void>;
  start: (onChunk: (chunk: ArrayBuffer) => void, onError?: (message: string) => void) => Promise<void>;
  stop: (flush?: boolean) => Promise<void>;
}
interface Dependencies {
  capture?: Capture;
  createSTT?: (callbacks: { onInterim: (text: string, languageCode?: string) => void; onFinal: (text: string, languageCode?: string) => void; onError: (message: string) => void }) => STTConnection;
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
  private startupAudio: ArrayBuffer[] = [];
  private startupBytes = 0;
  private recentAudio = new RecentAudio();
  private finishing?: Promise<void>;
  private lastUsage = 0;
  private lastLevelAt = -Infinity;
  private lastTranscriptAt = 0;
  private signalSeconds = 0;
  private warnedNoTranscript = false;
  private finalArrived?: () => void;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private tasks = new Map<string, TranslationTask>();
  private receivedAt = new Map<string, number>();
  private edited = new Map<string, { original: string; translation: string; direction: Direction }>();
  private previousLanguage: Language;
  private speechAudioLanguage?: Language;

  constructor(private settings: SessionSettings, private emit: (event: ServerMessage) => void, dependencies: Dependencies = {}) {
    this.capture = dependencies.capture ?? new AudioCapture(settings.audioSource);
    this.previousLanguage = directionSource(settings.direction);
    // 雙向對話的辨識輪次分開翻譯，避免不同語言／說話者黏成同一句；同方向仍合併顯示。
    this.assembler = new TranscriptAssembler(this.id, settings.direction, Date.now, !settings.pair);
    const callbacks = {
      onInterim: (text: string, languageCode?: string) => this.transcript(text, false, languageCode),
      onFinal: (text: string, languageCode?: string) => {
        this.transcript(text, true, languageCode); this.speechAudioLanguage = undefined; this.finalArrived?.();
      },
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
      onTranslation: (task, requestId, text, complete, detectedDirection) => {
        const direction = detectedDirection ?? task.direction;
        const localized = translatedText(text, direction);
        this.edited.set(task.captionId, { original: this.edited.get(task.captionId)?.original ?? sourceText(task.text, direction), translation: localized, direction });
        this.send({ type: 'translation', sessionId: this.id, captionId: task.captionId, revision: task.revision,
          requestId, direction, text: localized, final: task.final && complete });
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
      direction: this.edited.get(item.captionId)?.direction ?? item.direction,
      audioLanguage: item.audioLanguage,
    }));
    return { ...task, review, pair: this.settings.pair,
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
    if (result.original?.trim()) this.applyEdit(current, result.original, result.text, result.direction ?? current.direction);
    for (const correction of result.corrections ?? []) {
      const supplied = task.review?.find(item => item.captionId === correction.captionId && item.revision === correction.revision);
      const target = this.tasks.get(correction.captionId);
      if (!supplied || !target?.final || target.revision !== supplied.revision || target.text !== supplied.raw
        || correction.confidence !== 'high' || !correction.evidence.trim()
        || Date.now() - (this.receivedAt.get(target.captionId) ?? 0) > 45000) continue;
      if (this.settings.pair && !isPairLanguage(correction.sourceLanguage, this.settings.pair)) continue;
      if (target.audioLanguage && correction.sourceLanguage !== target.audioLanguage) continue;
      // 校正最近的同音詞；不讓舊待譯工作再把修正後的譯文蓋回去。
      this.scheduler.remove([target.captionId]);
      const direction = this.settings.pair ? directionFor(this.settings.pair, correction.sourceLanguage!) : target.direction;
      this.applyEdit(target, correction.original, correction.translation, direction);
    }
  }

  private applyEdit(task: TranslationTask, original: string, translation: string, direction: Direction) {
    if (!original.trim() || !translation.trim()) return;
    const localized = { original: sourceText(original.trim(), direction),
      translation: translatedText(translation.trim(), direction), direction };
    this.edited.set(task.captionId, localized);
    this.tasks.set(task.captionId, {...task, direction});
    if ([...this.tasks.keys()].at(-1) === task.captionId) this.previousLanguage = directionSource(direction);
    this.send({ type: 'caption-correction', sessionId: this.id, captionId: task.captionId,
      revision: task.revision, ...localized, final: task.final, corrected: localized.original !== sourceText(task.text, direction) });
  }

  private send(event: ServerMessage) { if (!this.disposed) this.emit(event); }
  private status(status: 'connecting' | 'listening' | 'finishing' | 'stopped', message: string) {
    this.send({ type: 'status', sessionId: this.id, status, message });
  }

  async start() {
    if (this.disposed || this.stopping || this.started) return;
    this.started = true;
    this.status('connecting', this.settings.audioSource === 'display'
      ? '請選擇播放中的分頁，並勾選分享音訊；正在準備持續聆聽…'
      : '正在準備麥克風與 AI 連線，請稍候顯示「持續聆聽中」再說話。');
    try {
      // 先解鎖音訊處理，再等待網路；符合手機瀏覽器的使用者手勢要求。
      await this.capture.prepare();
      if (this.stopping || this.disposed) return;
      // Preserve audio captured while model setup is pending (the v2.3.3 fix).
      const connection = this.stt.connect(this.settings.apiKey, this.settings.pair ? [] : DIRECTIONS[this.settings.direction].source, this.settings.customVocabulary);
      const capture = this.capture.start(chunk => this.audio(chunk), message => { if (!this.stopping) this.fail(message); });
      await Promise.all([connection, capture]);
      if (this.stopping || this.disposed) return;
      this.ready = true;
      this.lastTranscriptAt = Date.now();
      const buffered = this.startupAudio;
      this.startupAudio = []; this.startupBytes = 0;
      for (const chunk of buffered) {
        if (this.stopping || this.disposed) break;
        this.sendAudio(chunk);
      }
      if (!this.stopping && !this.disposed) this.status('listening', this.settings.audioSource === 'display'
        ? '持續聆聽分享音訊中。停頓時也保持連線，按停止才結束。'
        : '持續聆聽中，可以說話。停頓時麥克風與 AI 連線仍保持開啟。');
    } catch (error) {
      if (!this.stopping && !this.disposed) {
        const hint = error instanceof DOMException && error.name === 'NotAllowedError'
          ? this.settings.audioSource === 'display' ? '未允許分享音訊；請按開始，選擇播放中的分頁並勾選分享音訊。'
            : '無法使用麥克風。請確認網址為 HTTPS，並允許此網站使用麥克風。'
          : error instanceof DOMException && error.name === 'NotFoundError' ? '找不到麥克風，請確認裝置已連接。' : readableError(error);
        this.fail(hint);
      }
    }
  }

  private audio(chunk: ArrayBuffer) {
    if (this.disposed) return;
    this.recentAudio.append(chunk);
    if (!this.ready) {
      if (this.stopping) return;
      if (this.startupBytes + chunk.byteLength > 16000 * 2 * 20) {
        this.fail('語音連線準備太久，已停止收音。請檢查網路後重新開始。');
        return;
      }
      this.startupAudio.push(chunk); this.startupBytes += chunk.byteLength;
      return;
    }
    this.sendAudio(chunk);
  }

  get recentAudioSeconds() { return this.recentAudio.durationSeconds; }
  snapshotAudio() { return this.recentAudio.snapshot(); }

  private sendAudio(chunk: ArrayBuffer) {
    if (this.disposed) return;
    try {
      if (this.stt.sendAudio(chunk)) {
        this.usage.addAudioBytes(chunk.byteLength);
        const now = Date.now();
        const level = pcmLevel(chunk);
        if (now - this.lastLevelAt >= 200) {
          this.lastLevelAt = now;
          this.send({ type: 'audio-level', sessionId: this.id, level });
        }
        if (level >= 0.008) this.signalSeconds += chunk.byteLength / 32000;
        if (!this.stopping && !this.warnedNoTranscript && this.signalSeconds >= 2 && now - this.lastTranscriptAt > 15000) {
          this.warnedNoTranscript = true;
          this.send({ type: 'warning', sessionId: this.id,
            message: '已收到聲音，但辨識服務超過 15 秒沒有回傳文字。請確認音源是清楚的人聲；若持續無字幕，請停止後重試。' });
        }
        if (Date.now() - this.lastUsage > 1000) this.sendUsage();
        this.budget();
      } else this.fail('音訊未能傳送到辨識服務，已停止收音。請檢查連線後重新開始。');
    } catch (error) { this.fail(readableError(error)); }
  }

  private transcript(text: string, final: boolean, languageCode?: string) {
    if (this.disposed || !text.trim()) return;
    this.lastTranscriptAt = Date.now(); this.signalSeconds = 0;
    if (this.warnedNoTranscript && !this.stopping) this.status('listening', '已收到辨識文字，正在持續翻譯。');
    this.warnedNoTranscript = false;
    const detected = languageFromCode(languageCode);
    if (this.settings.pair && isPairLanguage(detected, this.settings.pair)) this.speechAudioLanguage = detected;
    const audioLanguage = this.settings.pair ? this.speechAudioLanguage : undefined;
    const direction = this.settings.pair
      ? audioLanguage ? directionFor(this.settings.pair, audioLanguage) : previewDirection(text, this.settings.pair, this.previousLanguage)
      : this.settings.direction;
    const { changed, removed } = this.assembler.update(text, final, direction, audioLanguage);
    if (final) this.previousLanguage = directionSource(direction);
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
        paragraphId: task.paragraphId, direction: task.direction, rawText: task.text,
        text: sourceText(task.text, task.direction), final: task.final, receivedAt: Date.now() });
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
    this.startupAudio = []; this.startupBytes = 0;
    clearTimeout(this.finishTimer);
    this.finalArrived?.();
    this.finalArrived = undefined;
    this.scheduler.close();
    this.stt.close();
    void this.capture.stop(false);
  }
}
