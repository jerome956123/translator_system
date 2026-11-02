export const PHRASE_MIN_SECONDS = 12;
export const PHRASE_MAX_SECONDS = 20;
export const PHRASE_LOOKAHEAD_SECONDS = 3;

/** Scheduling only: quiet frames never filter, trim or suppress captured PCM. */
export class PhraseBoundaries {
  private samples = 0;
  private frameSamples = 0;
  private frameEnergy = 0;
  private quietSamples = 0;
  private start = 0;
  private cuts: number[] = [];

  append(pcm: ArrayBuffer): number[] {
    if (pcm.byteLength % 2) throw new Error('PCM 音訊長度必須是完整的 16-bit 樣本。');
    for (const sample of new Int16Array(pcm)) {
      this.samples++; this.frameSamples++; this.frameEnergy += sample * sample;
      if (this.frameSamples !== 320) continue; // 20 ms at 16 kHz, independent of capture packet size.
      const quiet = Math.sqrt(this.frameEnergy / this.frameSamples) <= 32;
      this.quietSamples = quiet ? this.quietSamples + this.frameSamples : 0;
      this.frameSamples = 0; this.frameEnergy = 0;
      // Cut near the middle of a 700 ms pause, with a bounded wait for continuous speech.
      const pauseEnd = this.samples - 5600;
      if (this.quietSamples >= 11200 && pauseEnd >= this.start + PHRASE_MIN_SECONDS * 16000)
        this.cut(Math.min(pauseEnd, this.start + PHRASE_MAX_SECONDS * 16000));
      else if (this.samples >= this.start + PHRASE_MAX_SECONDS * 16000) this.cut(this.start + PHRASE_MAX_SECONDS * 16000);
    }
    const ready: number[] = [];
    while (this.cuts.length && this.cuts[0] + PHRASE_LOOKAHEAD_SECONDS * 16000 <= this.samples)
      ready.push(this.cuts.shift()! / 16000);
    return ready;
  }

  private cut(end: number) { this.cuts.push(end); this.start = end; }
}
