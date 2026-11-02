import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushToTalkGate } from '../src/audio/push-to-talk';

const pcm = (seconds: number, value: number) => new Int16Array(Math.round(seconds * 16000)).fill(value).buffer;
function harness() {
  const packets: ArrayBuffer[] = [];
  const order: string[] = [];
  const callbacks = { start: vi.fn(() => { order.push('start'); return true; }),
    audio: vi.fn((audio: ArrayBuffer) => { packets.push(audio); order.push('audio'); }),
    end: vi.fn(() => { order.push('end'); return true; }), state: vi.fn(), error: vi.fn() };
  const gate = new PushToTalkGate(callbacks);
  const samples = () => packets.flatMap(packet => Array.from(new Int16Array(packet)));
  return { gate, callbacks, packets, samples, order };
}
afterEach(() => vi.useRealTimers());

describe('對講機原音範圍與保護頭尾', () => {
  it('待命只本機保留最近 0.8 秒；先送 start，再補送弱音開頭，按住時保留靜音', () => {
    const h = harness(); h.gate.append(pcm(10, 8)); expect(h.packets).toHaveLength(0);
    expect(h.gate.press()).toBe(true); expect(h.order[0]).toBe('start');
    expect(h.samples()).toEqual(new Array(12800).fill(8));
    h.gate.append(pcm(.1, 0)); h.gate.append(pcm(.1, 2));
    expect(h.samples().slice(-3200)).toEqual([...new Array(1600).fill(0), ...new Array(1600).fill(2)]);
    expect(h.callbacks.start).toHaveBeenCalledOnce(); h.gate.close();
  });

  it('放開後精確保留 0.3 秒，即使封包超過尾音長度也不多送；下一次不重播上一句', () => {
    const h = harness(); h.gate.append(pcm(.8, 1)); h.gate.press(); h.gate.append(pcm(.1, 2));
    h.gate.release(); h.gate.append(pcm(.5, 3));
    expect(h.samples()).toHaveLength(16000 * 1.2);
    expect(h.samples().slice(-4800)).toEqual(new Array(4800).fill(3));
    expect(h.order.at(-1)).toBe('end'); expect(h.callbacks.end).toHaveBeenCalledOnce();
    expect(h.gate.press()).toBe(false); h.gate.acknowledge(); const previous = h.samples().length;
    expect(h.gate.press()).toBe(true); expect(h.samples().slice(previous)).toEqual(new Array(3200).fill(3));
    h.gate.close();
  });

  it('快速放開再按住會接續同一輪，重複按鍵不重送 start 或前置音訊', () => {
    const h = harness(); h.gate.append(pcm(.8, 1)); h.gate.press(); h.gate.press();
    h.gate.release(); h.gate.append(pcm(.1, 2)); h.gate.press(); h.gate.append(pcm(.1, 3));
    expect(h.callbacks.start).toHaveBeenCalledOnce(); expect(h.callbacks.end).not.toHaveBeenCalled();
    expect(h.samples()).toHaveLength(16000); h.gate.release(); h.gate.append(pcm(.3, 4));
    expect(h.callbacks.end).toHaveBeenCalledOnce(); h.gate.close();
  });

  it('停止整場保留已收到的尾包，結束訊號不重複；沒有語音的 turnComplete 也能回待命', () => {
    const h = harness(); h.gate.press(); h.gate.append(pcm(.05, 9));
    h.gate.endNow(); h.gate.endNow(); expect(h.callbacks.end).toHaveBeenCalledOnce();
    expect(h.samples()).toHaveLength(800); h.gate.acknowledge(); expect(h.gate.pending).toBe(false);
    expect(h.callbacks.state).toHaveBeenLastCalledWith('idle'); h.gate.close();
  });

  it('視窗失焦後無新音訊時有尾音安全期限，沒有 final 時停止而非覆蓋下一句', async () => {
    vi.useFakeTimers(); const h = harness(); h.gate.press(); h.gate.release();
    await vi.advanceTimersByTimeAsync(1000); expect(h.callbacks.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8000); expect(h.callbacks.error).toHaveBeenCalledWith(expect.stringContaining('8 秒'));
    expect(h.gate.press()).toBe(false); expect(h.callbacks.state).toHaveBeenLastCalledWith('closed');
  });

  it('關閉或傳送 start 失敗會釋放暫存與計時器，晚到聲音／確認不能重開', async () => {
    vi.useFakeTimers(); const h = harness(); h.gate.append(pcm(.8, 1));
    h.callbacks.start.mockReturnValue(false); expect(h.gate.press()).toBe(false);
    expect(h.callbacks.audio).not.toHaveBeenCalled(); expect(h.callbacks.error).toHaveBeenCalledOnce();
    h.gate.append(pcm(1, 2)); h.gate.acknowledge(); await vi.advanceTimersByTimeAsync(10000);
    expect(h.gate.press()).toBe(false); expect(h.callbacks.end).not.toHaveBeenCalled();
  });
});
