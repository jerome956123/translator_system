import { describe, expect, it } from 'vitest';
import { StreamingLinearResampler, floatToPcm16 } from '../src/audio/capture';

describe('音訊轉換', () => {
  it.each([44100, 48000])('將 %i Hz 跨區塊重取樣為約一秒 16 kHz', (rate) => {
    const resampler = new StreamingLinearResampler(rate);
    let count = 0;
    for (let offset = 0; offset < rate; offset += 127) {
      count += resampler.push(new Float32Array(Math.min(127, rate - offset)).fill(0.25)).length;
    }
    expect(count).toBeGreaterThanOrEqual(15998);
    expect(count).toBeLessThanOrEqual(16001);
  });

  it('正確限制 PCM16 邊界', () => {
    expect(Array.from(floatToPcm16(Float32Array.from([-2, -1, 0, 1, 2])))).toEqual([-32768, -32768, 0, 32767, 32767]);
  });
});
