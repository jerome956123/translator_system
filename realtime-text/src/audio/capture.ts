export class StreamingLinearResampler {
  private pending = new Float32Array(0);
  private position = 0;
  private readonly ratio: number;

  constructor(inputRate: number, private readonly outputRate = 16000) {
    if (inputRate <= 0 || outputRate <= 0) throw new Error('取樣率必須大於零');
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array) {
    const joined = new Float32Array(this.pending.length + input.length);
    joined.set(this.pending);
    joined.set(input, this.pending.length);
    const output: number[] = [];
    while (this.position + 1 < joined.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      output.push(joined[left] * (1 - fraction) + joined[left + 1] * fraction);
      this.position += this.ratio;
    }
    // 至少保留最後一個輸入樣本，讓下一區塊能跨邊界內插；position 可能已超過本區塊尾端。
    const consumed = Math.max(0, Math.min(Math.floor(this.position), joined.length - 1));
    this.pending = joined.slice(consumed);
    this.position -= consumed;
    return Float32Array.from(output);
  }
}

export function floatToPcm16(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const value = Math.max(-1, Math.min(1, input[index]));
    output[index] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
  }
  return output;
}

export function pcmLevel(buffer: ArrayBuffer): number {
  const view = new DataView(buffer);
  const count = Math.floor(view.byteLength / 2);
  let sum = 0;
  for (let index = 0; index < count; index++) sum += (view.getInt16(index * 2, true) / 32768) ** 2;
  return count ? Math.sqrt(sum / count) : 0;
}

import workletSource from './pcm-worklet.js?raw';
import type { AudioSource } from '../../shared/protocol';

function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private stopped = false;
  private prepared: Promise<void> | null = null;
  private onChunk: ((chunk: ArrayBuffer) => void) | null = null;
  private flushed: (() => void) | null = null;
  private firstFrame?: { resolve: () => void; reject: (error: Error) => void };
  private watchdog?: ReturnType<typeof setInterval>;
  private lastFrame = 0;
  private onError?: (message: string) => void;
  private audioSession?: { type: string };
  private previousSessionType?: string;

  constructor(private input: AudioSource = 'microphone') {}

  private readonly sourceEnded = () => this.reportError(this.input === 'display'
    ? '音訊分享已結束，已停止翻譯；請按開始重新選擇音源。'
    : '麥克風已中斷，請確認裝置及權限後重新開始。');

  private reportError(message: string) {
    if (this.stopped) return;
    this.firstFrame?.reject(new Error(message));
    this.onError?.(message);
  }

  private async resume() {
    const context = this.context;
    if (this.stopped || !context) throw new DOMException('已停止', 'AbortError');
    await bounded(context.resume(), 3000, '瀏覽器未啟動收音。請保持此頁在前景，再按開始；手機請使用 Safari 或 Chrome 的一般分頁。');
    if (this.stopped) throw new DOMException('已停止', 'AbortError');
    if (context.state !== 'running') throw new Error('收音被瀏覽器暫停，請保持頁面開啟並重新按開始。');
  }

  // 在使用者點擊的同一個事件內呼叫，讓 iPhone 能解鎖音訊處理。
  prepare(): Promise<void> {
    if (this.prepared) return this.prepared;
    // 支援 Audio Session API 的 Safari 明確使用錄音模式，結束時還原此頁原有設定。
    if (this.input === 'microphone') {
      try {
        const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
        if (audioSession) {
          this.previousSessionType = audioSession.type;
          audioSession.type = 'play-and-record'; this.audioSession = audioSession;
        }
      } catch { /* 舊瀏覽器可能沒有可寫入的 Audio Session API。 */ }
    }
    this.context = new AudioContext({ latencyHint: 'interactive' });
    const context = this.context;
    // 先在使用者手勢內解鎖；取得麥克風可能再次中斷手機 AudioContext，之後還需恢復。
    void context.resume().catch(() => {});
    const media = this.input === 'display'
      ? navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' }, audio: true,
        systemAudio: 'include', selfBrowserSurface: 'exclude',
      } as DisplayMediaStreamOptions)
      : navigator.mediaDevices.getUserMedia({
        // 同一支麥克風也要聽見喇叭外放；回音消除會嘗試移除電腦播放聲。
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      });
    this.prepared = (async () => {
      const stream = await media;
      if (this.stopped) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('已停止', 'AbortError'); }
      this.stream = stream;
      if (!stream.getAudioTracks().some(track => track.readyState === 'live')) {
        throw new Error(this.input === 'display'
          ? '沒有取得分享音訊。請選播放中的分頁並勾選「分享分頁音訊」；只有畫面無法翻譯。若沒有音訊選項，請改用電腦版 Chrome／Edge。'
          : '沒有可用的麥克風音軌，請確認權限與輸入裝置。');
      }
      for (const track of stream.getTracks()) track.addEventListener('ended', this.sourceEnded);
      await this.resume();
      const moduleUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
      try { await context.audioWorklet.addModule(moduleUrl); }
      finally { URL.revokeObjectURL(moduleUrl); }
      if (this.stopped) throw new DOMException('已停止', 'AbortError');
    })();
    // 權限視窗未回覆時也能停止；不等這個 Promise 才釋放已取得的資源。
    void this.prepared.catch(() => {});
    return this.prepared;
  }

  async start(onChunk: (chunk: ArrayBuffer) => void, onError?: (message: string) => void) {
    await this.prepare();
    if (this.stopped || !this.context || !this.stream) throw new DOMException('已停止', 'AbortError');
    if (!this.stream.getAudioTracks().some(track => track.readyState === 'live')) throw new Error('音訊來源已結束，請重新開始並選擇音源。');
    this.onChunk = onChunk;
    this.onError = onError;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm16-resampler', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { targetRate: 16000, chunkSamples: 1600 },
    });
    const first = new Promise<void>((resolve, reject) => { this.firstFrame = { resolve, reject }; });
    void first.catch(() => {});
    this.node.port.onmessage = (event: MessageEvent<ArrayBuffer | { type: string }>) => {
      if (event.data instanceof ArrayBuffer && event.data.byteLength) {
        this.lastFrame = Date.now();
        this.onChunk?.(event.data);
        this.firstFrame?.resolve(); this.firstFrame = undefined;
      }
      else if (!(event.data instanceof ArrayBuffer) && event.data.type === 'flushed') this.flushed?.();
    };
    this.node.onprocessorerror = () => this.reportError('音訊處理已中斷，請停止後重新開始。');
    this.source.connect(this.node);
    // Worklet 的輸出保持全零；連接 destination 是為了讓瀏覽器持續排程，不會播放收音。
    this.node.connect(this.context.destination);
    // 網路連線／權限視窗等待之後再恢復一次，不能只憑連線成功就顯示「聆聽中」。
    await this.resume();
    await bounded(first, 4000, '已取得權限，但瀏覽器沒有送出音訊。請確認麥克風未被其他 App 佔用，保持此頁在前景後重新開始。');
    if (this.stopped) throw new DOMException('已停止', 'AbortError');
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastFrame > 5000) this.reportError('收音已中斷超過 5 秒，已停止翻譯。請回到此頁確認麥克風，然後重新開始。');
    }, 1000);
  }

  async stop(flush = true) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.watchdog);
    this.firstFrame?.reject(new DOMException('已停止', 'AbortError')); this.firstFrame = undefined;
    if (flush && this.node && this.context?.state === 'running') {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 120);
        this.flushed = () => { clearTimeout(timer); resolve(); };
        this.node!.port.postMessage({ type: 'flush' });
      });
    }
    this.onChunk = null;
    this.onError = undefined;
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach(track => { track.removeEventListener('ended', this.sourceEnded); track.stop(); });
    if (this.audioSession?.type === 'play-and-record' && this.previousSessionType !== undefined) {
      try { this.audioSession.type = this.previousSessionType; } catch { /* 瀏覽器已關閉音訊工作階段。 */ }
    }
    if (this.context && this.context.state !== 'closed') await this.context.close().catch(() => {});
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }
}
