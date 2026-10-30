export interface AudioSnapshot {
  wav: ArrayBuffer;
  durationSeconds: number;
  startSeconds: number;
  endSeconds: number;
}

/** The last 30 seconds of the same PCM16 mono audio sent to the recognizer.
 * Stored only in this page's memory; no second recording device or AI request.
 */
export class RecentAudio {
  private chunks: Uint8Array[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(private seconds = 30, private sampleRate = 16000) {
    if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(sampleRate) || sampleRate <= 0)
      throw new Error('無效的音訊暫存長度。');
    this.maxBytes = Math.floor(seconds * sampleRate) * 2;
    if (!this.maxBytes) throw new Error('音訊暫存長度太短。');
  }

  get durationSeconds() { return this.retainedBytes / (this.sampleRate * 2); }

  append(pcm: ArrayBuffer) {
    if (!pcm.byteLength) return;
    if (pcm.byteLength % 2) throw new Error('PCM 音訊長度必須是完整的 16-bit 樣本。');
    this.totalBytes += pcm.byteLength;
    if (pcm.byteLength >= this.maxBytes) {
      this.chunks = [new Uint8Array(pcm.slice(pcm.byteLength - this.maxBytes))];
      this.retainedBytes = this.maxBytes;
      return;
    }
    this.chunks.push(new Uint8Array(pcm.slice(0)));
    this.retainedBytes += pcm.byteLength;
    while (this.retainedBytes > this.maxBytes) {
      const excess = this.retainedBytes - this.maxBytes;
      const first = this.chunks[0];
      if (first.byteLength <= excess) {
        this.retainedBytes -= first.byteLength;
        this.chunks.shift();
      } else {
        this.chunks[0] = first.slice(excess);
        this.retainedBytes -= excess;
      }
    }
  }

  snapshot(): AudioSnapshot | undefined {
    if (!this.retainedBytes) return;
    const wav = new ArrayBuffer(44 + this.retainedBytes);
    const view = new DataView(wav);
    const bytes = new Uint8Array(wav);
    const word = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    word(0, 'RIFF'); view.setUint32(4, 36 + this.retainedBytes, true); word(8, 'WAVE');
    word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, this.retainedBytes, true);
    let offset = 44;
    for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { wav, durationSeconds: this.durationSeconds,
      startSeconds: (this.totalBytes - this.retainedBytes) / (this.sampleRate * 2),
      endSeconds: this.totalBytes / (this.sampleRate * 2) };
  }

  clear() { this.chunks = []; this.retainedBytes = 0; this.totalBytes = 0; }
}
