import WebSocket from 'ws';
import { config } from './config.js';
export class GeminiSTTSession {
    socket = null;
    ready = false;
    closing = false;
    callbacks;
    constructor(callbacks) {
        this.callbacks = callbacks;
    }
    connect(languageCode) {
        const endpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(config.apiKey)}`;
        this.socket = new WebSocket(endpoint, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 15000 });
        this.socket.on('open', () => {
            this.socket?.send(JSON.stringify({
                setup: {
                    model: `models/${config.sttModel}`,
                    generationConfig: { responseModalities: ['TEXT'] },
                    inputAudioTranscription: { languageCodes: [languageCode], mode: 'SMART' },
                },
            }));
        });
        this.socket.on('message', (data) => this.handleMessage(data.toString()));
        this.socket.on('error', (error) => this.callbacks.onError(this.friendlyError(error.message)));
        this.socket.on('close', () => {
            this.ready = false;
            this.callbacks.onClose();
        });
    }
    friendlyError(message) {
        if (/401|403|unauth|permission/i.test(message))
            return 'API Key 無效、服務未啟用，或帳號沒有 Live Transcribe 權限。';
        if (/404|not found/i.test(message))
            return `找不到語音模型 ${config.sttModel}，請核對 .env。`;
        if (/429|resource exhausted/i.test(message))
            return 'Gemini 使用額度或速率已達上限。';
        return `Gemini 語音連線失敗：${message}`;
    }
    handleMessage(raw) {
        try {
            const message = JSON.parse(raw);
            if (message.error)
                return this.callbacks.onError(message.error.message || 'Gemini 語音服務發生錯誤');
            if (message.setupComplete) {
                this.ready = true;
                this.callbacks.onReady();
            }
            const interim = message.serverContent?.interimInputTranscription?.text?.trim();
            const final = message.serverContent?.inputTranscription?.text?.trim();
            if (interim)
                this.callbacks.onInterim(interim);
            if (final)
                this.callbacks.onFinal(final);
        }
        catch {
            this.callbacks.onError('無法解析 Gemini 語音服務的回覆。');
        }
    }
    sendAudio(pcm) {
        if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN)
            return false;
        if (this.socket.bufferedAmount > 64 * 1024)
            throw new Error('上游音訊緩衝已滿，為避免漏字已停止。');
        this.socket.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
        return true;
    }
    endAudio() {
        if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        }
    }
    close() {
        this.closing = true;
        this.ready = false;
        this.socket?.close(1000, 'session complete');
        this.socket = null;
    }
    isExpectedClose() { return this.closing; }
}
//# sourceMappingURL=stt.js.map