import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import source from '../src/audio/pcm-worklet.js?raw';

describe('實際 AudioWorklet', () => {
  it.each([44100, 48000])('在 %i Hz 輸入下連續輸出 100ms PCM，停止時不遺漏尾包', rate => {
    const messages: Array<ArrayBuffer | { type: string }> = [];
    let Worklet: any;
    class Base { port = { onmessage: (_event: unknown) => {}, postMessage: (value: any) => messages.push(value) }; }
    runInNewContext(source, {
      AudioWorkletProcessor: Base, sampleRate: rate,
      registerProcessor: (_name: string, ctor: unknown) => { Worklet = ctor; },
    });
    const processor = new Worklet({ processorOptions: { targetRate: 16000, chunkSamples: 1600 } });
    for (let offset = 0; offset < rate; offset += 128) {
      processor.process([[new Float32Array(Math.min(128, rate - offset)).fill(0.25)]]);
    }
    const packets = messages.filter(value => !('type' in value)) as ArrayBuffer[];
    expect(packets.length).toBeGreaterThanOrEqual(9);
    expect(packets.every(packet => packet.byteLength === 3200)).toBe(true);
    processor.port.onmessage({ data: { type: 'flush' } });
    expect(messages[messages.length - 1]).toEqual({ type: 'flushed' });
    const all = messages.filter(value => !('type' in value)) as ArrayBuffer[];
    const samples = all.reduce((total, packet) => total + packet.byteLength / 2, 0);
    expect(samples).toBeGreaterThanOrEqual(15998); expect(samples).toBeLessThanOrEqual(16001);
    expect(new DataView(all[0]).getInt16(0, true)).toBe(8192);
    expect(processor.process([])).toBe(false);
  });
});
