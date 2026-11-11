import type { PrecisionWindow, ServerMessage } from '../../shared/protocol';
import { RecentAudio, type AudioSnapshot } from '../audio/recent-audio';
import { reviewAudio, REVIEW_SECONDS, type ReviewInput, type ReviewUsage } from './audio-review';
import { PACES, readableError, redactKey } from './config';
import type { SessionSettings } from './types';
import { TranslationLanguageError } from './translation-language';
import { PhraseBoundaries } from '../audio/phrase-boundaries';
import { AudioRequestError, isTransientAudioError, shortAudioReason, waitForAudioRetry } from './api-error';

const EPSILON = 1 / 16000;
/** 每次嘗試各自的期限；逾時視為暫時性故障，可重試。 */
export const ATTEMPT_TIMEOUT_MS = 20000;
/** 暫時性故障（斷網、逾時、429、5xx）的重試間隔；用完仍失敗才放棄這一段。 */
export const RETRY_DELAYS_MS = [1000, 3000];
/** 連續這麼多段都失敗才停止整場，避免對壞掉的服務無限送請求。 */
export const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_QUEUE = 3;
/** 視為「沒有訊號」的最大振幅（16-bit）。只涵蓋數位靜音與硬體抖動，不是音量門檻。 */
const SILENCE_PEAK = 2;

interface Interval { startSeconds: number; endSeconds: number }
/** 沒有 audio 的項目代表「這段沒送出」，交給下一段補翻或留下缺口。 */
interface Queued extends Interval { audio?: AudioSnapshot; reason?: string }
interface Carry extends Interval { reason: string }

/** Independent of ASR/VAD. Every sample, including silence and quiet onsets, reaches this pass. */
export class PrecisionReviewer {
  private audio = new RecentAudio(60);
  private nextStart = 0;
  private previousStart = 0;
  private previousWindow?: PrecisionWindow;
  private boundaries: PhraseBoundaries;
  private lookahead: number;
  private queue: Queued[] = [];
  private pending?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  private finishing = false;
  private failed = false;
  /** 上一段經重試仍失敗；下一段的原音已涵蓋它，可以一起補翻。 */
  private carry?: Carry;
  private current?: Interval;
  private failures = 0;

  constructor(private sessionId: string, private settings: SessionSettings, private callbacks: {
    emit: (event: ServerMessage) => void;
    beforeRequest: (usage: ReviewUsage) => boolean;
    onUsage: (id: string, seconds: number, usage: ReviewUsage) => void;
    onError?: (message: string) => void;
  }, private request = reviewAudio, private sentenceAware = false) {
    const pace = PACES[settings.pace ?? 'standard'];
    this.boundaries = new PhraseBoundaries(pace); this.lookahead = pace.lookaheadSeconds;
  }

  /** 整段（含後文）都是數位靜音：麥克風被靜音，或分享的分頁沒有在播放。再小聲的人聲也不會符合。 */
  private silent(audio: AudioSnapshot, fromSeconds: number) {
    const samples = new Int16Array(audio.wav, 44);
    for (let index = Math.max(0, Math.round((fromSeconds - audio.startSeconds) * 16000)); index < samples.length; index++)
      if (samples[index] > SILENCE_PEAK || samples[index] < -SILENCE_PEAK) return false;
    return true;
  }

  /** 目前這一段已收進、尚未送出翻譯的秒數；給畫面顯示等待進度。 */
  get pendingSeconds() { return this.closed || this.failed ? 0 : Math.max(0, this.audio.elapsedSeconds - this.nextStart); }

  private status(state: 'waiting' | 'working' | 'stopped' | 'error', message: string) {
    if (!this.closed) this.callbacks.emit({ type: 'precision-status', sessionId: this.sessionId, state, message });
  }

  private gap(interval: Interval, reason: string) {
    if (this.closed || interval.endSeconds - interval.startSeconds <= EPSILON) return;
    this.callbacks.emit({ type: 'precision-gap', sessionId: this.sessionId, gapId: crypto.randomUUID(),
      startSeconds: interval.startSeconds, endSeconds: interval.endSeconds,
      message: redactKey(reason, this.settings.apiKey), receivedAt: Date.now() });
  }

  append(pcm: ArrayBuffer) {
    if (this.closed || this.failed || this.finishing) return;
    // Capture normally supplies 100 ms. Bound even unexpectedly large input without dropping windows.
    for (let offset = 0; offset < pcm.byteLength; offset += 32000) {
      const chunk = pcm.slice(offset, Math.min(pcm.byteLength, offset + 32000));
      this.audio.append(chunk);
      if (this.sentenceAware) {
        for (const end of this.boundaries.append(chunk)) {
          if (this.failed || this.closed) break;
          this.enqueue(end, end + this.lookahead);
        }
      } else while (!this.failed && this.audio.elapsedSeconds >= this.nextStart + REVIEW_SECONDS + 1)
        this.enqueue(this.nextStart + REVIEW_SECONDS, this.nextStart + REVIEW_SECONDS + 1);
      if (this.failed || this.closed) break;
      this.pump();
    }
    this.pump();
  }

  private enqueue(end: number, clipEnd: number) {
    const interval = { startSeconds: this.nextStart, endSeconds: end };
    const clipStart = this.sentenceAware ? this.previousStart : Math.max(0, this.nextStart - 2);
    this.previousStart = this.nextStart;
    this.nextStart = end;
    // One in flight, a few waiting clips. Never silently skip an unreviewed interval:
    // 翻譯跟不上時不停止收音，把這段交給下一段補翻；補不回來會留下看得見的缺口。
    if (this.queue.length >= MAX_QUEUE) {
      const last = this.queue.at(-1)!;
      if (!last.audio) last.endSeconds = end;
      else this.queue.push({ ...interval, reason: '翻譯速度跟不上收音' });
      return;
    }
    const audio = this.audio.snapshot(clipStart, clipEnd);
    if (!audio || Math.abs(audio.startSeconds - clipStart) > EPSILON
      || Math.abs(audio.endSeconds - clipEnd) > EPSILON) {
      this.queue.push({ ...interval });
      this.error('原音暫存不完整，無法安全銜接前後句。'); return;
    }
    // 完全沒有訊號的一段不送出：省下請求，也避免模型對著空白編造句子。
    // 只在沒有其他工作時略過，進行中或待補翻的段落仍照原本流程銜接。
    if (!this.pending && !this.queue.length && !this.carry && this.silent(audio, interval.startSeconds)) {
      this.status('waiting', '這段完全沒有聲音訊號，未送出翻譯。若正在說話，請確認麥克風沒有靜音。');
      return;
    }
    this.queue.push({ audio, ...interval });
  }

  private pump() {
    if (this.pending || this.closed || this.failed || !this.queue.length) return;
    this.pending = this.run().finally(() => { this.pending = undefined; this.pump(); });
  }

  private async run() {
    while (this.queue.length && !this.closed && !this.failed) {
      const queued = this.queue.shift()!;
      if (!queued.audio) {
        if (this.carry) this.gap(this.carry, this.carry.reason);
        this.carry = { startSeconds: queued.startSeconds, endSeconds: queued.endSeconds, reason: queued.reason ?? '這段沒有送出翻譯' };
        continue;
      }
      // 上一段失敗且這段原音剛好從它的開頭錄起：併成一次請求補翻，不遺失內容。
      let startSeconds = queued.startSeconds;
      if (this.carry) {
        const carry = this.carry; this.carry = undefined;
        if (queued.audio.startSeconds <= carry.startSeconds + EPSILON
          && Math.abs(carry.endSeconds - queued.startSeconds) <= EPSILON) startSeconds = carry.startSeconds;
        else this.gap(carry, carry.reason);
      }
      const recovering = startSeconds < queued.startSeconds;
      const previous = this.sentenceAware && !recovering && this.previousWindow
        && Math.abs(this.previousWindow.endSeconds - startSeconds) <= EPSILON
        && queued.audio.startSeconds <= this.previousWindow.startSeconds + EPSILON ? this.previousWindow : undefined;
      const input: ReviewInput = { audio: queued.audio, startSeconds, endSeconds: queued.endSeconds,
        ...(previous ? { previous } : {}) };
      this.current = { startSeconds, endSeconds: queued.endSeconds };
      const id = crypto.randomUUID();
      const controller = new AbortController(); this.controller = controller;
      const range = `${Math.floor(input.startSeconds)}–${Math.floor(input.endSeconds)} 秒`;
      this.status('working', recovering ? `正在補翻上一段並回聽 ${range}原音…` : `正在回聽 ${range}原音…`);
      let denied = false;
      try {
        let result: Awaited<ReturnType<typeof reviewAudio>> = { segments: [] };
        let attempt = 0, languageRetried = false, transientRetries = 0;
        while (true) {
          const attemptId = attempt ? `${id}-retry-${attempt}` : id;
          // 每次嘗試有自己的期限；停止／關閉時由整段的 controller 一併取消。
          const attemptController = new AbortController();
          const forward = () => attemptController.abort(controller.signal.reason);
          controller.signal.addEventListener('abort', forward, { once: true });
          const timeout = setTimeout(() => attemptController.abort(new Error('Google 超過 20 秒沒有回覆')), ATTEMPT_TIMEOUT_MS);
          try {
            controller.signal.throwIfAborted();
            result = await this.request({ ...input, settings: this.settings, signal: attemptController.signal, languageRetry: languageRetried,
              beforeRequest: usage => {
                const allowed = !this.closed && !this.failed && this.callbacks.beforeRequest(usage);
                if (!allowed) denied = true;
                return allowed;
              },
              onUsage: usage => { if (!this.closed && !this.failed) this.callbacks.onUsage(attemptId, input.audio.durationSeconds, usage); },
            });
            break;
          } catch (error) {
            if (controller.signal.aborted || this.closed || this.failed || denied) throw error;
            const timedOut = attemptController.signal.aborted;
            if (error instanceof TranslationLanguageError && !languageRetried) {
              languageRetried = true; attempt++;
              this.status('working', '譯文語言不符，正在重新翻譯這段原音…');
            } else if ((timedOut || isTransientAudioError(error)) && transientRetries < RETRY_DELAYS_MS.length) {
              const delay = RETRY_DELAYS_MS[transientRetries++]; attempt++;
              const reason = timedOut ? 'Google 超過 20 秒沒有回覆' : shortAudioReason(error);
              this.status('working', `${reason}。已保留這段原音，${delay / 1000} 秒後重試（第 ${transientRetries}／${RETRY_DELAYS_MS.length} 次）；收音持續中。`);
              await waitForAudioRetry(controller.signal, delay);
            } else throw timedOut ? new Error('Google 超過 20 秒沒有回覆') : error;
          } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', forward); }
        }
        if (this.closed || this.failed) return;
        if (input.previous) {
          if (!result.previousSegments) throw new Error('AI 沒有回傳前段銜接校對');
          const revised: PrecisionWindow = { ...input.previous, segments: result.previousSegments,
            revision: (input.previous.revision ?? 1) + 1 };
          this.callbacks.emit({ type: 'precision-result', sessionId: this.sessionId, window: revised });
          if (this.closed || this.failed) return;
        }
        const window: PrecisionWindow = { id, sessionId: this.sessionId, startSeconds: input.startSeconds,
          endSeconds: input.endSeconds, segments: result.segments, revision: 1 };
        this.previousWindow = window; this.failures = 0;
        this.callbacks.emit({ type: 'precision-result', sessionId: this.sessionId, window });
      } catch (error) {
        if (this.closed || this.failed) { /* 已停止：晚到的結果或錯誤都不再回寫。 */ }
        // 預算用完、金鑰、權限、模型設定：重試或跳過都沒有意義，需要使用者處理。
        else if (denied || (error instanceof AudioRequestError && !error.retryable))
          this.error(redactKey(readableError(error), this.settings.apiKey));
        else this.segmentFailed(queued, input, redactKey(shortAudioReason(error), this.settings.apiKey));
      } finally { this.current = undefined; if (this.controller === controller) this.controller = undefined; }
    }
    if (this.failed || this.closed) return;
    if (this.finishing) this.status('stopped', '本場回聽完成。');
    else if (this.carry) this.status('waiting', `上一段暫時無法翻譯（${this.carry.reason}）。收音持續中，下一段會一併補翻。`);
    else this.status('waiting', this.sentenceAware
      ? '持續收音中；優先等自然停頓再翻譯，下一段會連同前段原音校對銜接。'
      : '持續保留原音；每約 12 秒回聽一次，不用等待辨識到句子。');
  }

  /** 這一段放棄，但整場繼續：下一段會帶著它的原音再試一次。 */
  private segmentFailed(queued: Interval, input: Interval, reason: string) {
    // 這次已經是補翻（上一段＋這一段）仍失敗：更早的那段沒有機會了，留下缺口。
    if (input.startSeconds < queued.startSeconds - EPSILON)
      this.gap({ startSeconds: input.startSeconds, endSeconds: queued.startSeconds }, reason);
    this.current = undefined;
    this.carry = { startSeconds: queued.startSeconds, endSeconds: queued.endSeconds, reason };
    if (++this.failures >= MAX_CONSECUTIVE_FAILURES) this.error(`連續 ${MAX_CONSECUTIVE_FAILURES} 段原音翻譯失敗（${reason}），已停止收音。`);
  }

  /** 尚未完成翻譯的整段範圍：補翻中的、進行中的、排隊中的，以及還沒切段的尾巴。 */
  private unfinished(): Interval | undefined {
    const intervals: Interval[] = [this.carry, this.current, ...this.queue].filter((item): item is Interval => Boolean(item));
    const startSeconds = intervals.length ? Math.min(...intervals.map(item => item.startSeconds)) : this.nextStart;
    const endSeconds = Math.max(this.audio.elapsedSeconds, ...intervals.map(item => item.endSeconds));
    return endSeconds > startSeconds ? { startSeconds, endSeconds } : undefined;
  }

  private error(message: string) {
    const lost = this.unfinished();
    if (lost) this.gap(lost, message);
    this.failed = true; this.queue = []; this.carry = undefined; this.audio.clear(); this.controller?.abort();
    const description = `${message} 這段尚未完成，請保留原音並重新開始。`;
    this.status('error', description); this.callbacks.onError?.(description);
  }

  async finish() {
    if (this.closed || this.failed) return;
    this.finishing = true;
    if (this.audio.elapsedSeconds > this.nextStart) this.enqueue(this.audio.elapsedSeconds, this.audio.elapsedSeconds);
    this.pump();
    // A bounded grace period for the in-flight and last queued clips, including their retries.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.pending, new Promise<void>(resolve => {
      timer = setTimeout(() => { this.error('已停止收音，回聽收尾逾時。'); resolve(); }, 45000);
    })]);
    clearTimeout(timer);
    if (this.closed || this.failed) { this.audio.clear(); return; }
    // 最後一段失敗後沒有下一段可以補翻。
    const lost = this.carry; this.carry = undefined;
    if (lost) this.gap(lost, lost.reason);
    this.audio.clear();
    this.status('stopped', lost ? '本場回聽完成；最後有一段未能翻譯，已在紀錄中標示。' : '本場回聽完成。');
  }

  close() {
    if (!this.closed && !this.finishing && !this.failed) this.status('stopped', '回聽已停止；未完成的片段不會再回寫。');
    this.closed = true; this.queue = []; this.carry = undefined; this.audio.clear(); this.controller?.abort();
  }
}
