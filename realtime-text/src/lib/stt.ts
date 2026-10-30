import { MODELS, redactKey } from './config';

interface Callbacks {
  onInterim: (text: string, languageCode?: string) => void;
  onFinal: (text: string, languageCode?: string) => void;
  onError: (message: string) => void;
}

export interface STTConnection {
  connect: (apiKey: string, language: string | string[], customVocabulary?: string[]) => Promise<void>;
  sendAudio: (pcm: ArrayBuffer) => boolean;
  endAudio: () => void;
  close: () => void;
}

export class GeminiBrowserSTT implements STTConnection {
  private socket?: WebSocket;
  private expectedClose = false;
  private ready = false;
  private rejectConnect?: (error: Error) => void;

  constructor(private callbacks: Callbacks) {}

  connect(apiKey: string, language: string | string[], customVocabulary: string[] = []) {
    return new Promise<void>((resolve, reject) => {
      this.rejectConnect = reject;
      const socket = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`);
      this.socket = socket;
      const timeout = setTimeout(() => {
        reject(new Error('連接 Gemini 逾時，請檢查網路與模型權限。'));
        this.close();
      }, 15000);
      let messages = Promise.resolve();
      socket.onopen = () => {
        if (this.expectedClose) return;
        socket.send(JSON.stringify({ setup: {
          model: `models/${MODELS.stt}`, generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: {
            languageCodes: Array.isArray(language) ? language : [language], mode: 'VERBATIM',
            ...(customVocabulary.length ? { customVocabulary } : {}),
          },
          // 保留短停頓中的同一句；草稿仍持續輸出，不必等到停頓結束。
          realtimeInputConfig: { automaticActivityDetection: {
            disabled: false, startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', prefixPaddingMs: 20, silenceDurationMs: 800,
          } },
        } }));
      };
      socket.onmessage = event => {
        messages = messages.then(async () => {
          if (this.expectedClose) return;
          const raw = typeof event.data === 'string' ? event.data : event.data instanceof Blob
            ? await event.data.text() : new TextDecoder().decode(event.data);
          const message = JSON.parse(raw);
          if (message.error) throw new Error(redactKey(message.error.message || 'Gemini 語音服務回傳錯誤。', apiKey));
          if (message.setupComplete) {
            this.ready = true; clearTimeout(timeout); resolve();
          }
          const content = message.serverContent;
          const interim = content?.interimInputTranscription;
          const final = content?.inputTranscription;
          if (interim?.text) {
            if (typeof interim.languageCode === 'string') this.callbacks.onInterim(interim.text, interim.languageCode);
            else this.callbacks.onInterim(interim.text);
          }
          if (final?.text) {
            if (typeof final.languageCode === 'string') this.callbacks.onFinal(final.text, final.languageCode);
            else this.callbacks.onFinal(final.text);
          }
          if (message.goAway) this.callbacks.onError('Gemini 要求結束本次連線，請重新開始一場；已保留收到的字幕。');
        }).catch(error => {
          clearTimeout(timeout);
          const safe = error instanceof Error ? redactKey(error.message, apiKey) : '無法解析語音回覆。';
          reject(new Error(safe)); this.callbacks.onError(safe); this.close();
        });
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        const error = new Error('無法連接 Gemini 語音服務。請檢查網路、API Key、模型權限與網站限制。');
        reject(error);
        if (this.ready && !this.expectedClose) this.callbacks.onError(error.message);
      };
      socket.onclose = event => {
        clearTimeout(timeout);
        const wasReady = this.ready; this.ready = false;
        if (this.expectedClose) return;
        const reason = event.reason ? ` ${redactKey(event.reason, apiKey)}` : '';
        const error = new Error(`語音連線已結束（${event.code}）。${reason || '請確認 API Key 與辨識模型是否可用。'}`);
        reject(error);
        if (wasReady) this.callbacks.onError(error.message);
      };
    });
  }

  sendAudio(pcm: ArrayBuffer) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > 64000) throw new Error('網路傳送壅塞，已停止收音。');
    const bytes = new Uint8Array(pcm);
    let binary = '';
    for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
    this.socket.send(JSON.stringify({ realtimeInput: { audio: { data: btoa(binary), mimeType: 'audio/pcm;rate=16000' } } }));
    return true;
  }

  endAudio() {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  close() {
    this.expectedClose = true; this.ready = false;
    this.rejectConnect?.(new DOMException('已停止連線', 'AbortError'));
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}
