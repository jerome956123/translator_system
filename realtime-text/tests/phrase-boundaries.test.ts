import { describe, expect, it } from 'vitest';
import { PhraseBoundaries } from '../src/audio/phrase-boundaries';

const pcm = (seconds: number, value = 1000) => new Int16Array(Math.round(seconds * 16000)).fill(value).buffer;

describe('分段只決定送出時間，不裁掉收音', () => {
  it('連續說話不在 12 秒硬切，20 秒上限再等 3 秒後文', () => {
    const phrases = new PhraseBoundaries();
    expect(phrases.append(pcm(12))).toEqual([]); expect(phrases.append(pcm(10.99))).toEqual([]);
    expect(phrases.append(pcm(.01))).toEqual([20]); expect(phrases.append(pcm(20))).toEqual([40]);
  });
  it('12 秒以後優先取 700ms 停頓中點，短呼吸不切斷', () => {
    const phrases = new PhraseBoundaries(); phrases.append(pcm(12)); phrases.append(pcm(.3, 0));
    phrases.append(pcm(2)); expect(phrases.append(pcm(.7, 0))).toEqual([]);
    expect(phrases.append(pcm(2.7))[0]).toBeCloseTo(14.65);
  });
  it('連續安靜仍安排請求，分段音量判斷不成為漏字門檻', () => {
    const phrases = new PhraseBoundaries(); const ends = phrases.append(pcm(31, 4));
    expect(ends).toHaveLength(2); expect(ends[0]).toBeGreaterThanOrEqual(12);
    expect(ends[1] - ends[0]).toBeCloseTo(12);
  });
  it('音訊包長短不同、甚至逐樣本餵入也得到相同邊界', () => {
    const all = new Int16Array(28 * 16000).fill(1000); all.fill(0, 13 * 16000, 14 * 16000);
    const one = new PhraseBoundaries().append(all.buffer); const split = new PhraseBoundaries(); const ends: number[] = [];
    for (let offset = 0; offset < all.length; offset += 137)
      ends.push(...split.append(all.slice(offset, offset + 137).buffer));
    expect(ends).toEqual(one);
  });
});
