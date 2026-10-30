import { describe, expect, it } from 'vitest';
import { RecentAudio } from '../src/audio/recent-audio';
const pcm = (samples: number[]) => new Int16Array(samples).buffer;
const samples = (wav: ArrayBuffer) => Array.from(new Int16Array(wav.slice(44)));

describe('有界的本機原音暫存', () => {
  it('依收音時間擷取跨區塊範圍，WAV 長度與實際樣本一致', () => {
    const audio = new RecentAudio(2, 4); audio.append(pcm([1,2,3,4])); audio.append(pcm([5,6,7,8]));
    audio.append(pcm([9,10]));
    const clip = audio.snapshot(1, 2)!;
    expect(clip).toMatchObject({ startSeconds: 1, endSeconds: 2, durationSeconds: 1 });
    expect(samples(clip.wav)).toEqual([5,6,7,8]); expect(new DataView(clip.wav).getUint32(40, true)).toBe(8);
    expect(audio.elapsedSeconds).toBe(2.5); expect(audio.snapshot(3, 4)).toBeUndefined();
    expect(audio.snapshot(NaN, 2)).toBeUndefined();
  });
  it('產生可解碼的單聲道 16-bit WAV，保留頭尾及零音量樣本', () => {
    const audio = new RecentAudio(); audio.append(pcm([12,0,-34])); audio.append(pcm([0,56]));
    const clip = audio.snapshot()!; const view = new DataView(clip.wav); const bytes = new Uint8Array(clip.wav);
    const text = (at:number,n:number) => String.fromCharCode(...bytes.slice(at,at+n));
    expect(text(0,4)).toBe('RIFF'); expect(text(8,4)).toBe('WAVE'); expect(text(36,4)).toBe('data');
    expect(view.getUint32(4,true)).toBe(46); expect(view.getUint32(40,true)).toBe(10);
    expect(view.getUint16(20,true)).toBe(1); expect(view.getUint16(22,true)).toBe(1);
    expect(view.getUint32(24,true)).toBe(16000); expect(view.getUint32(28,true)).toBe(32000);
    expect(view.getUint16(32,true)).toBe(2); expect(view.getUint16(34,true)).toBe(16);
    expect(samples(clip.wav)).toEqual([12,0,-34,0,56]); expect(clip.durationSeconds).toBe(5/16000);
  });
  it('超過上限時精確移除舊樣本，包含跨區塊與部分區塊', () => {
    const audio = new RecentAudio(2,4);
    audio.append(pcm([1,2,3])); audio.append(pcm([4,5,6])); audio.append(pcm([7,8,9,10]));
    expect(samples(audio.snapshot()!.wav)).toEqual([3,4,5,6,7,8,9,10]);
    expect(audio.snapshot()).toMatchObject({durationSeconds:2,startSeconds:0.5,endSeconds:2.5});
  });
  it('超大區塊只保留末端，長時間收音仍受 30 秒上限限制', () => {
    const audio = new RecentAudio(2,4);
    audio.append(pcm([1,2])); audio.append(pcm([3,4,5,6,7,8,9,10,11,12]));
    expect(samples(audio.snapshot()!.wav)).toEqual([5,6,7,8,9,10,11,12]);
    const real = new RecentAudio(); for(let i=0;i<700;i++) real.append(new Int16Array(1600).fill(i).buffer);
    const clip = real.snapshot()!; expect(clip.wav.byteLength).toBe(960044);
    expect(clip).toMatchObject({durationSeconds:30,startSeconds:40,endSeconds:70});
  });
  it('擷取不受後續錄音或原區塊修改影響，清除可釋放所有內容', () => {
    const audio = new RecentAudio(2,4); const input = pcm([1,2,3]);
    audio.append(input); new Int16Array(input).fill(9); const saved = audio.snapshot()!;
    audio.append(pcm([4,5,6,7,8,9,10,11])); audio.clear();
    expect(samples(saved.wav)).toEqual([1,2,3]); expect(audio.durationSeconds).toBe(0);
    expect(audio.snapshot()).toBeUndefined(); audio.append(pcm([7])); expect(audio.snapshot()!.startSeconds).toBe(0);
  });
  it('空區塊不產生空音檔，不完整樣本與無效設定明確拒絕', () => {
    const audio = new RecentAudio(); audio.append(new ArrayBuffer(0)); expect(audio.snapshot()).toBeUndefined();
    expect(()=>audio.append(new ArrayBuffer(3))).toThrow(); expect(()=>new RecentAudio(0)).toThrow();
    expect(()=>new RecentAudio(NaN)).toThrow();
  });
});
