class Pcm16Resampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate || 16000;
    this.chunkSamples = options.processorOptions?.chunkSamples || 1600;
    this.ratio = sampleRate / this.targetRate;
    this.pending = new Float32Array(0);
    this.position = 0;
    this.output = [];
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'flush') {
        if (this.output.length) this.emit(this.output.splice(0));
        this.running = false;
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  emit(floats) {
    const buffer = new ArrayBuffer(floats.length * 2);
    const view = new DataView(buffer);
    for (let index = 0; index < floats.length; index++) {
      const value = Math.max(-1, Math.min(1, floats[index]));
      view.setInt16(index * 2, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
    }
    this.port.postMessage(buffer, [buffer]);
  }

  process(inputs) {
    if (!this.running) return false;
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (let channel = 0; channel < channels.length; channel += 1) {
      for (let index = 0; index < mono.length; index += 1) mono[index] += channels[channel][index] / channels.length;
    }
    const joined = new Float32Array(this.pending.length + mono.length);
    joined.set(this.pending);
    joined.set(mono, this.pending.length);
    while (this.position + 1 < joined.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      this.output.push(joined[left] * (1 - fraction) + joined[left + 1] * fraction);
      this.position += this.ratio;
    }
    // 保留尾端樣本與超出的相位，否則每個 128-frame 工作區塊都會重新起算而逐漸變快。
    const consumed = Math.max(0, Math.min(Math.floor(this.position), joined.length - 1));
    this.pending = joined.slice(consumed);
    this.position -= consumed;
    while (this.output.length >= this.chunkSamples) {
      this.emit(this.output.splice(0, this.chunkSamples));
    }
    return true;
  }
}

registerProcessor('pcm16-resampler', Pcm16Resampler);
