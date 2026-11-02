import type { TalkState } from '../../shared/protocol';
import { RecentAudio } from './recent-audio';

export const PRE_ROLL_SECONDS = 0.8;
export const TAIL_SECONDS = 0.3;
const RATE = 16000;

/** One warm microphone, explicit model activity, bounded pre-roll, no replayed samples. */
export class PushToTalkGate {
  private recent = new RecentAudio(PRE_ROLL_SECONDS);
  private samples = 0;
  private sentUntil = 0;
  private tailRemaining = 0;
  private tailTimer?: ReturnType<typeof setTimeout>;
  private finalTimer?: ReturnType<typeof setTimeout>;
  private state: TalkState = 'idle';

  constructor(private callbacks: {
    start: () => boolean;
    audio: (pcm: ArrayBuffer) => void;
    end: () => boolean;
    state: (state: TalkState) => void;
    error: (message: string) => void;
  }) {}

  get pending() { return this.state === 'speaking' || this.state === 'tail' || this.state === 'finishing'; }
  private get closed() { return this.state === 'closed'; }
  private change(state: TalkState) { this.state = state; this.callbacks.state(state); }

  append(pcm: ArrayBuffer) {
    if (this.state === 'closed' || !pcm.byteLength) return;
    const start = this.samples;
    this.samples += pcm.byteLength / 2;
    this.recent.append(pcm);
    if (this.state === 'speaking') {
      this.sentUntil = this.samples;
      this.callbacks.audio(pcm);
    } else if (this.state === 'tail') {
      const count = Math.min(pcm.byteLength / 2, this.tailRemaining);
      this.tailRemaining -= count; this.sentUntil = start + count;
      this.callbacks.audio(pcm.slice(0, count * 2));
      if (!this.tailRemaining) this.endNow();
    }
  }

  press() {
    if (this.state === 'closed' || this.state === 'finishing') return false;
    if (this.state === 'speaking') return true;
    if (this.state === 'tail') {
      clearTimeout(this.tailTimer); this.change('speaking'); return true;
    }
    this.change('speaking');
    try {
      if (!this.callbacks.start()) throw new Error('無法送出開始說話訊號，請重新開始連線。');
      // Clamp to the last uploaded sample so rapid consecutive turns cannot repeat prior speech.
      const clip = this.recent.snapshot(Math.max(this.sentUntil / RATE, this.samples / RATE - PRE_ROLL_SECONDS), this.samples / RATE);
      if (clip) {
        const pcm = clip.wav.slice(44);
        for (let offset = 0; offset < pcm.byteLength && !this.closed; offset += 3200)
          this.callbacks.audio(pcm.slice(offset, offset + 3200));
      }
      this.sentUntil = this.samples;
      return !this.closed;
    } catch (error) {
      this.close(); this.callbacks.error(error instanceof Error ? error.message : '開始說話失敗。'); return false;
    }
  }

  release() {
    if (this.state !== 'speaking') return;
    this.tailRemaining = Math.round(TAIL_SECONDS * RATE);
    this.change('tail');
    // Normally 3 x 100 ms frames. If capture stalls, do not leave the model activity open.
    this.tailTimer = setTimeout(() => this.endNow(), 1000);
  }

  endNow() {
    if (this.state !== 'speaking' && this.state !== 'tail') return;
    clearTimeout(this.tailTimer);
    this.change('finishing');
    this.finalTimer = setTimeout(() => {
      this.close(); this.callbacks.error('這句超過 8 秒沒有辨識完成回覆，已停止收音。請重新開始，避免下一句覆蓋前一句。');
    }, 8000);
    try {
      if (!this.callbacks.end()) throw new Error('無法送出結束說話訊號，請重新開始連線。');
    } catch (error) { this.close(); this.callbacks.error(error instanceof Error ? error.message : '結束說話失敗。'); }
  }

  acknowledge() {
    if (this.state !== 'finishing') return;
    clearTimeout(this.finalTimer); this.change('idle');
  }

  close() {
    if (this.state === 'closed') return;
    clearTimeout(this.tailTimer); clearTimeout(this.finalTimer);
    this.recent.clear(); this.change('closed');
  }
}
