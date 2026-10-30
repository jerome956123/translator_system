import type { PrecisionWindow, ServerMessage } from '../../shared/protocol';
import { RecentAudio } from '../audio/recent-audio';
import { reviewAudio, REVIEW_SECONDS, type ReviewInput, type ReviewUsage } from './audio-review';
import { readableError, redactKey } from './config';
import type { SessionSettings } from './types';

/** Independent of ASR/VAD. Every sample, including silence and quiet onsets, reaches this pass. */
export class PrecisionReviewer {
  private audio = new RecentAudio();
  private nextStart = 0;
  private queue: ReviewInput[] = [];
  private pending?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  private finishing = false;
  private failed = false;

  constructor(private sessionId: string, private settings: SessionSettings, private callbacks: {
    emit: (event: ServerMessage) => void;
    beforeRequest: (usage: ReviewUsage) => boolean;
    onUsage: (id: string, seconds: number, usage: ReviewUsage) => void;
  }, private request = reviewAudio) {}

  private status(state: 'waiting' | 'working' | 'stopped' | 'error', message: string) {
    if (!this.closed) this.callbacks.emit({ type: 'precision-status', sessionId: this.sessionId, state, message });
  }

  append(pcm: ArrayBuffer) {
    if (this.closed || this.failed || this.finishing) return;
    // Capture normally supplies 100 ms. Bound even unexpectedly large input without dropping windows.
    for (let offset = 0; offset < pcm.byteLength; offset += 32000) {
      this.audio.append(pcm.slice(offset, Math.min(pcm.byteLength, offset + 32000)));
      while (!this.failed && this.audio.elapsedSeconds >= this.nextStart + REVIEW_SECONDS + 1)
        this.enqueue(this.nextStart + REVIEW_SECONDS, this.nextStart + REVIEW_SECONDS + 1);
      if (this.failed || this.closed) break;
    }
    this.pump();
  }

  private enqueue(end: number, clipEnd: number) {
    // One in flight, at most two waiting clips. Never silently skip an unreviewed interval.
    if (this.queue.length >= 2) { this.error('回聽速度跟不上收音，已暫停回聽；即時字幕繼續。請停止後重新開始再試。'); return; }
    const audio = this.audio.snapshot(Math.max(0, this.nextStart - 2), clipEnd);
    if (!audio) return;
    this.queue.push({ audio, startSeconds: this.nextStart, endSeconds: end });
    this.nextStart = end;
  }

  private pump() {
    if (this.pending || this.closed || this.failed || !this.queue.length) return;
    this.pending = this.run().finally(() => { this.pending = undefined; this.pump(); });
  }

  private async run() {
    while (this.queue.length && !this.closed && !this.failed) {
      const input = this.queue.shift()!;
      const id = crypto.randomUUID();
      const controller = new AbortController(); this.controller = controller;
      const timeout = setTimeout(() => controller.abort(new Error('精準回聽超過 20 秒沒有回覆。')), 20000);
      this.status('working', `正在回聽 ${Math.floor(input.startSeconds)}–${Math.floor(input.endSeconds)} 秒原音…`);
      try {
        const segments = await this.request({ ...input, settings: this.settings, signal: controller.signal,
          beforeRequest: usage => !this.closed && !this.failed && this.callbacks.beforeRequest(usage),
          onUsage: usage => { if (!this.closed && !this.failed) this.callbacks.onUsage(id, input.audio.durationSeconds, usage); },
        });
        if (this.closed || this.failed) return;
        const window: PrecisionWindow = { id, sessionId: this.sessionId, startSeconds: input.startSeconds,
          endSeconds: input.endSeconds, segments };
        this.callbacks.emit({ type: 'precision-result', sessionId: this.sessionId, window });
      } catch (error) {
        if (!this.closed && !this.failed) this.error(controller.signal.aborted
          ? '精準回聽逾時；已暫停回聽，即時字幕繼續。' : redactKey(readableError(error), this.settings.apiKey));
      } finally { clearTimeout(timeout); if (this.controller === controller) this.controller = undefined; }
    }
    if (!this.failed && !this.closed) this.status(this.finishing ? 'stopped' : 'waiting', this.finishing
      ? '本場回聽完成。' : '持續保留原音；每約 12 秒回聽一次，不用等待辨識到句子。');
  }

  private error(message: string) {
    this.failed = true; this.queue = []; this.audio.clear(); this.controller?.abort();
    this.status('error', `${message} 未完成部分請參考即時字幕或保留原音。`);
  }

  async finish() {
    if (this.closed || this.failed) return;
    this.finishing = true;
    if (this.audio.elapsedSeconds > this.nextStart) this.enqueue(this.audio.elapsedSeconds, this.audio.elapsedSeconds);
    this.pump();
    // A bounded grace period for the in-flight and last queued clips.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.pending, new Promise<void>(resolve => {
      timer = setTimeout(() => { this.error('已停止收音，回聽收尾逾時。'); resolve(); }, 25000);
    })]);
    clearTimeout(timer);
    this.audio.clear();
    if (!this.closed && !this.failed) this.status('stopped', '本場回聽完成。');
  }

  close() {
    if (!this.closed && !this.finishing && !this.failed) this.status('stopped', '回聽已停止；未完成的片段不會再回寫。');
    this.closed = true; this.queue = []; this.audio.clear(); this.controller?.abort();
  }
}
