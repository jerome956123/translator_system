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

import workletSource from './pcm-worklet.js?raw';

export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private stopped = false;
  private prepared: Promise<void> | null = null;
  private onChunk: ((chunk: ArrayBuffer) => void) | null = null;
  private flushed: (() => void) | null = null;

  // 在使用者點擊的同一個事件內呼叫，讓 iPhone 能解鎖音訊處理。
  prepare(): Promise<void> {
    if (this.prepared) return this.prepared;
    this.context = new AudioContext({ latencyHint: 'interactive' });
    const context = this.context;
    const resumed = context.resume();
    const microphone = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.prepared = (async () => {
      const stream = await microphone;
      if (this.stopped) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('已停止', 'AbortError'); }
      this.stream = stream;
      await resumed;
      const moduleUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
      try { await context.audioWorklet.addModule(moduleUrl); }
      finally { URL.revokeObjectURL(moduleUrl); }
      if (this.stopped) throw new DOMException('已停止', 'AbortError');
    })();
    // 權限視窗未回覆時也能停止；不等這個 Promise 才釋放已取得的資源。
    void this.prepared.catch(() => {});
    void resumed.catch(() => {});
    return this.prepared;
  }

  async start(onChunk: (chunk: ArrayBuffer) => void) {
    await this.prepare();
    if (this.stopped || !this.context || !this.stream) throw new DOMException('已停止', 'AbortError');
    this.onChunk = onChunk;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm16-resampler', { processorOptions: { targetRate: 16000, chunkSamples: 1600 } });
    this.node.port.onmessage = (event: MessageEvent<ArrayBuffer | { type: string }>) => {
      if (event.data instanceof ArrayBuffer) this.onChunk?.(event.data);
      else if (event.data.type === 'flushed') this.flushed?.();
    };
    this.source.connect(this.node);
    // Worklet 的輸出保持全零；連接 destination 是為了讓瀏覽器持續排程，不會播放收音。
    this.node.connect(this.context.destination);
  }

  async stop(flush = true) {
    if (this.stopped) return;
    this.stopped = true;
    if (flush && this.node && this.context?.state === 'running') {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 120);
        this.flushed = () => { clearTimeout(timer); resolve(); };
        this.node!.port.postMessage({ type: 'flush' });
      });
    }
    this.onChunk = null;
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') await this.context.close().catch(() => {});
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }
}
