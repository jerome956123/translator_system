import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiBrowserSTT } from '../src/lib/stt';

class Socket {
  static OPEN = 1;
  static CLOSING = 2;
  static current: Socket;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string | Blob }) => void;
  onerror?: () => void;
  onclose?: (event: { code: number; reason: string }) => void;
  constructor(public url: string) { Socket.current = this; }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => vi.unstubAllGlobals());

describe('瀏覽器直連語音協定', () => {
  it('保留 Gemini 根據聲音判定的語言代碼，不丟掉純漢字短句的語言資訊', async () => {
    vi.stubGlobal('WebSocket',Socket);
    const onInterim=vi.fn(); const onFinal=vi.fn();
    const stt = new GeminiBrowserSTT({onInterim,onFinal,onError:vi.fn()});
    const connected=stt.connect('fake-key',[]);
    Socket.current.onmessage?.({data:'{"setupComplete":{}}'}); await connected;
    Socket.current.onmessage?.({data:JSON.stringify({serverContent:{
      interimInputTranscription:{text:'青森大学',languageCode:'ja-JP'},
      inputTranscription:{text:'青森大学',languageCode:'ja-JP'},
    }})}); await settle();
    expect(onInterim).toHaveBeenCalledWith('青森大学','ja-JP');
    expect(onFinal).toHaveBeenCalledWith('青森大学','ja-JP');
    stt.close();
  });
  it('雙向模式啟用 Gemini 自動辨識語言，不把連線固定為其中一種語言', async () => {
    vi.stubGlobal('WebSocket', Socket);
    const stt = new GeminiBrowserSTT({onInterim:vi.fn(),onFinal:vi.fn(),onError:vi.fn()});
    const connected = stt.connect('fake-key',[],['青森']);
    Socket.current.onopen?.();
    expect(JSON.parse(Socket.current.sent[0]).setup.inputAudioTranscription.languageCodes).toEqual([]);
    Socket.current.onmessage?.({data:'{"setupComplete":{}}'}); await connected; stt.close();
  });
  it('使用純文字設定、處理 Blob 與字串事件，送出 PCM 和尾端結束訊號', async () => {
    vi.stubGlobal('WebSocket', Socket);
    const onInterim = vi.fn(); const onFinal = vi.fn(); const onError = vi.fn();
    const stt = new GeminiBrowserSTT({ onInterim, onFinal, onError });
    const connected = stt.connect('test-key', 'ja-JP', ['中央大学', '双聯学位']);
    const socket = Socket.current;
    socket.onopen?.();
    const setup = JSON.parse(socket.sent[0]);
    expect(setup.setup.generationConfig.responseModalities).toEqual(['TEXT']);
    expect(setup.setup.inputAudioTranscription.languageCodes).toEqual(['ja-JP']);
    expect(setup.setup.model).toBe('models/gemini-3.5-transcribe-live');
    expect(setup.setup.inputAudioTranscription.mode).toBe('SMART');
    expect(setup.setup.inputAudioTranscription.customVocabulary).toEqual(['中央大学', '双聯学位']);
    expect(setup.setup.realtimeInputConfig.automaticActivityDetection).toEqual({
      disabled: false, prefixPaddingMs: 100, silenceDurationMs: 800,
    });
    expect(stt.sendAudio(new ArrayBuffer(2))).toBe(false);
    socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }); await connected;
    socket.onmessage?.({ data: new Blob([JSON.stringify({ serverContent: { interimInputTranscription: { text: 'こんにちは' } } })]) });
    await new Promise(resolve => setTimeout(resolve, 5));
    socket.onmessage?.({ data: JSON.stringify({ serverContent: { inputTranscription: { text: 'こんにちは。' } } }) });
    await settle();
    expect(onInterim).toHaveBeenCalledWith('こんにちは'); expect(onFinal).toHaveBeenCalledWith('こんにちは。');
    expect(stt.sendAudio(new ArrayBuffer(3200))).toBe(true); stt.endAudio();
    expect(JSON.parse(socket.sent[1]).realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(JSON.parse(socket.sent[2]).realtimeInput.audioStreamEnd).toBe(true);
    stt.close(); expect(onError).not.toHaveBeenCalled();
  });

  it('使用者在 setup 完成前取消，不會留下等待中的連線', async () => {
    vi.stubGlobal('WebSocket', Socket);
    const stt = new GeminiBrowserSTT({ onInterim: vi.fn(), onFinal: vi.fn(), onError: vi.fn() });
    const connecting = stt.connect('test', 'ja-JP'); stt.close();
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('網路堆積超過上限會停止，不默默堆積音訊', async () => {
    vi.stubGlobal('WebSocket', Socket);
    const stt = new GeminiBrowserSTT({ onInterim: vi.fn(), onFinal: vi.fn(), onError: vi.fn() });
    const connecting = stt.connect('test', 'ja-JP');
    Socket.current.onmessage?.({ data: '{"setupComplete":{}}' }); await connecting;
    Socket.current.bufferedAmount = 65000;
    expect(() => stt.sendAudio(new ArrayBuffer(3200))).toThrow('壅塞'); stt.close();
  });
});
