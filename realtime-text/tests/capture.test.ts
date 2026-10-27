import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioCapture, pcmLevel } from '../src/audio/capture';

class Track extends EventTarget {
  readyState = 'live';
  stop = vi.fn(() => { this.readyState = 'ended'; });
}
class Context {
  static current: Context;
  state = 'suspended';
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  source = { connect: vi.fn(), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  constructor() { Context.current = this; }
}
class Worklet {
  static current: Worklet;
  port = { onmessage: (_event: any) => {}, postMessage: vi.fn(() => this.port.onmessage({ data: { type: 'flushed' } })) };
  connect = vi.fn();
  disconnect = vi.fn();
  onprocessorerror?: () => void;
  constructor() { Worklet.current = this; }
  frame(value = 0) { this.port.onmessage({ data: new Int16Array(1600).fill(value).buffer }); }
}
function harness() {
  vi.useFakeTimers();
  const audio = new Track(); const video = new Track();
  const stream = { getAudioTracks: () => [audio], getTracks: () => [audio] };
  const media = {
    getUserMedia: vi.fn(async () => {
      // 模擬 iPhone 在取得麥克風權限時，再次中斷先前已解鎖的 AudioContext。
      Context.current.state = 'interrupted'; return stream;
    }),
    getDisplayMedia: vi.fn(async () => ({ ...stream, getTracks: () => [audio, video] })),
  };
  const audioSession = { type: 'auto' };
  vi.stubGlobal('navigator', { mediaDevices: media, audioSession });
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Worklet);
  return { audio, video, stream, media, audioSession };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('實際收音啟動與中斷', () => {
  it('權限取得後及連線等待後恢復 AudioContext，收到第一包 PCM 才完成啟動', async () => {
    const h = harness(); const capture = new AudioCapture(); const onChunk = vi.fn();
    await capture.prepare();
    expect(h.media.getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    expect(h.media.getDisplayMedia).not.toHaveBeenCalled();
    expect(h.audioSession.type).toBe('play-and-record');
    expect(Context.current.state).toBe('running');
    Context.current.state = 'suspended';
    let started = false;
    const start = capture.start(onChunk).then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toBe(false); expect(Context.current.state).toBe('running');
    Worklet.current.frame(1200); await start;
    expect(onChunk).toHaveBeenCalledOnce();
    expect(h.media.getUserMedia).toHaveBeenCalledOnce();
    await capture.stop(false);
    expect(h.audio.stop).toHaveBeenCalledOnce(); expect(h.audioSession.type).toBe('auto');
  });

  it('瀏覽器 state 是 running 但沒有 PCM 時報錯，不會假裝收音正常', async () => {
    harness(); const capture = new AudioCapture(); await capture.prepare();
    const assertion = expect(capture.start(vi.fn())).rejects.toThrow('沒有送出音訊');
    await vi.advanceTimersByTimeAsync(4100); await assertion;
    await capture.stop(false);
  });

  it('resume 一直未完成時有明確逾時，能釋放麥克風', async () => {
    const h = harness();
    h.media.getUserMedia.mockImplementation(async () => {
      Context.current.resume.mockImplementation(() => new Promise(() => {})); return h.stream;
    });
    const capture = new AudioCapture();
    const assertion = expect(capture.prepare()).rejects.toThrow('未啟動收音');
    await vi.advanceTimersByTimeAsync(3100); await assertion;
    await capture.stop(false); expect(h.audio.stop).toHaveBeenCalled();
  });

  it('沒有分享音訊時拒絕啟動並釋放所有分享軌道，不會改成偷用麥克風', async () => {
    const h = harness();
    h.media.getDisplayMedia.mockResolvedValue({ getAudioTracks: () => [], getTracks: () => [h.video] });
    const capture = new AudioCapture('display');
    await expect(capture.prepare()).rejects.toThrow('分享分頁音訊');
    await capture.stop(false);
    expect(h.video.stop).toHaveBeenCalled(); expect(h.media.getUserMedia).not.toHaveBeenCalled();
  });

  it('分享音訊時不取麥克風，停止時釋放音訊與畫面軌道', async () => {
    const h = harness(); const capture = new AudioCapture('display'); await capture.prepare();
    const start = capture.start(vi.fn()); await vi.advanceTimersByTimeAsync(10); Worklet.current.frame(2000); await start;
    expect(h.media.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: true }));
    expect(h.media.getUserMedia).not.toHaveBeenCalled();
    await capture.stop(true);
    expect(h.audio.stop).toHaveBeenCalled(); expect(h.video.stop).toHaveBeenCalled();
  });

  it('分享被結束、音訊處理出錯與 PCM 中斷都能回報給場次', async () => {
    const h = harness(); const onError = vi.fn(); const capture = new AudioCapture('display'); await capture.prepare();
    const start = capture.start(vi.fn(), onError); await vi.advanceTimersByTimeAsync(10); Worklet.current.frame(); await start;
    h.video.dispatchEvent(new Event('ended')); expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('分享已結束'));
    Worklet.current.onprocessorerror?.(); expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('音訊處理'));
    await vi.advanceTimersByTimeAsync(6100); expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('5 秒'));
    await capture.stop(false); onError.mockClear();
    h.audio.dispatchEvent(new Event('ended')); await vi.advanceTimersByTimeAsync(7000);
    expect(onError).not.toHaveBeenCalled();
  });

  it('等待第一包 PCM 時按停止，立即結束等待且不留計時器', async () => {
    harness(); const capture = new AudioCapture(); await capture.prepare();
    const assertion = expect(capture.start(vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10); await capture.stop(false); await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('權限視窗晚回覆時，已停止的場次仍釋放取得的麥克風', async () => {
    const h = harness(); let grant!: (stream: typeof h.stream) => void;
    h.media.getUserMedia.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const capture = new AudioCapture();
    const assertion = expect(capture.prepare()).rejects.toMatchObject({ name: 'AbortError' });
    await capture.stop(false); grant(h.stream); await assertion;
    expect(h.audio.stop).toHaveBeenCalled();
  });

  it('音量由實際 PCM 計算，能區分有封包但安靜，以及確實有聲音', () => {
    expect(pcmLevel(new ArrayBuffer(3200))).toBe(0);
    expect(pcmLevel(new Int16Array([16384, -16384]).buffer)).toBe(0.5);
    expect(pcmLevel(new ArrayBuffer(0))).toBe(0);
  });
});
