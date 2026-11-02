import type { ServerMessage } from '../../shared/protocol';
import { AudioCapture, pcmLevel } from '../audio/capture';
import { RecentAudio } from '../audio/recent-audio';
import type { SessionSettings } from './types';
import { PrecisionReviewer } from './precision-review';
import { reviewAudio, reviewCost } from './audio-review';
import { readableError } from './config';
import { UsageTracker } from './usage';

interface Capture {
  prepare(): Promise<void>;
  start(onChunk: (chunk: ArrayBuffer) => void, onError?: (message: string) => void): Promise<void>;
  stop(flush?: boolean): Promise<void>;
}

/** The original-audio pass is the sole translator. No Live WebSocket or text SSE pipeline. */
export class PrecisionTranslationSession {
  readonly id = crypto.randomUUID();
  private capture: Capture;
  private reviewer: PrecisionReviewer;
  private recent = new RecentAudio();
  private usage = new UsageTracker();
  private started = false;
  private stopping = false;
  private disposed = false;
  private lastLevel = -Infinity;
  private lastUsage = 0;
  private finishing?: Promise<void>;
  private paragraph = 1;
  private paragraphChars = 0;

  constructor(private settings: SessionSettings, private emit: (event: ServerMessage) => void,
    dependencies: { capture?: Capture; reviewAudio?: typeof reviewAudio } = {}) {
    this.capture = dependencies.capture ?? new AudioCapture(settings.audioSource);
    this.reviewer = new PrecisionReviewer(this.id, settings, {
      emit: event => this.reviewEvent(event), onError: message => this.fail(message),
      beforeRequest: estimate => !this.disposed && (!settings.budgetUsd
        || this.usage.snapshot().estimatedUsd + reviewCost(estimate) < settings.budgetUsd),
      onUsage: (id, seconds, usage) => {
        if (this.disposed) return;
        this.usage.recordReview(id, seconds, usage); this.sendUsage();
        if (settings.budgetUsd && this.usage.snapshot().estimatedUsd >= settings.budgetUsd)
          this.fail('估算費用已達本場上限，已停止收音與新請求。');
      },
    }, dependencies.reviewAudio);
  }

  private send(event: ServerMessage) { if (!this.disposed) this.emit(event); }
  private status(status: 'connecting' | 'listening' | 'finishing' | 'stopped', message: string) {
    this.send({ type: 'status', sessionId: this.id, status, message });
  }
  private reviewEvent(event: ServerMessage) {
    if (this.disposed) return;
    if (event.type === 'precision-result') {
      event.window.segments.forEach((segment, index) => {
        const captionId = `${event.window.id}-${index}`;
        if (this.paragraphChars >= 180) { this.paragraph++; this.paragraphChars = 0; }
        // Publish completed original and translation together in the main transcript history.
        this.send({ type: 'transcript', sessionId: this.id, captionId, paragraphId: `${this.id}-precision-${this.paragraph}`,
          origin: 'precision', direction: segment.direction, revision: 1, text: segment.original,
          rawText: segment.original, final: true, receivedAt: Date.now() });
        this.send({ type: 'translation', sessionId: this.id, captionId, requestId: event.window.id,
          direction: segment.direction, revision: 1, text: segment.translation, final: true });
        this.paragraphChars += Array.from(segment.original).length;
      });
      this.settings.context = [this.settings.context ?? '', ...event.window.segments.map(segment => segment.original)].join('\n').slice(-512);
    } else this.send(event);
  }

  async start() {
    if (this.started || this.stopping || this.disposed) return;
    this.started = true;
    this.status('connecting', '正在準備精準原音翻譯…');
    try {
      await this.capture.prepare();
      if (this.stopping || this.disposed) return;
      await this.capture.start(chunk => this.audio(chunk), message => { if (!this.stopping) this.fail(message); });
      if (!this.stopping && !this.disposed)
        this.status('listening', '精準原音翻譯中；每約 12 秒分批輸出，首次約 13 秒加上 AI 處理時間。');
    } catch (error) {
      if (!this.stopping && !this.disposed) this.fail(error instanceof DOMException && error.name === 'NotAllowedError'
        ? '無法使用音訊來源。請確認 HTTPS、麥克風或分享音訊權限。' : readableError(error));
    }
  }

  private audio(chunk: ArrayBuffer) {
    if (this.disposed) return;
    this.recent.append(chunk);
    this.usage.addAudioBytes(chunk.byteLength, false);
    const now = Date.now();
    if (now - this.lastLevel >= 200) {
      this.lastLevel = now; this.send({ type: 'audio-level', sessionId: this.id, level: pcmLevel(chunk) });
    }
    this.reviewer.append(chunk);
    if (now - this.lastUsage >= 1000) this.sendUsage();
  }

  get recentAudioSeconds() { return this.recent.durationSeconds; }
  snapshotAudio() { return this.recent.snapshot(); }
  private sendUsage() { this.lastUsage = Date.now(); this.send({ type: 'usage', sessionId: this.id, usage: this.usage.snapshot() }); }

  stop(message = '正在翻譯最後一段原音…') {
    if (this.finishing) return this.finishing;
    if (this.disposed) return Promise.resolve();
    this.stopping = true; this.status('finishing', message);
    return this.finishing = this.finish().catch(error => this.fail(readableError(error)));
  }
  private async finish() {
    await this.capture.stop(true);
    if (this.disposed) return;
    await this.reviewer.finish();
    if (this.disposed) return;
    this.sendUsage(); this.status('stopped', '已停止，精準翻譯已保留，可複製或下載。'); this.dispose();
  }
  private fail(message: string) {
    if (this.disposed) return;
    this.sendUsage(); this.send({ type: 'error', sessionId: this.id, code: 'PRECISION_ERROR', message, recoverable: false }); this.dispose();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.stopping = true; this.reviewer.close(); void this.capture.stop(false);
  }
}
