/* Listening fix for the existing v2.3.2 standalone bundle.
 * Keep the established translation, history, currency and audio-source code intact.
 * n0 is its session class; xl/Rd are its existing language/error helpers.
 */
(() => {
    const sendAudio = n0.prototype.audio;
    const dispose = n0.prototype.dispose;

    n0.prototype.audio = function (pcm) {
        if (this.disposed) return;
        if (!this.ready) {
            if (this.stopping) return;
            this.startupAudio ??= [];
            this.startupBytes ??= 0;
            // 20 seconds of mono PCM16. Fail visibly instead of dropping the first word.
            if (this.startupBytes + pcm.byteLength > 16000 * 2 * 20) {
                this.fail('語音連線準備太久，已停止收音。請檢查網路後重新開始。');
                return;
            }
            this.startupAudio.push(pcm);
            this.startupBytes += pcm.byteLength;
            return;
        }
        // Includes quiet/silent packets; the existing volume meter is not a sending gate.
        sendAudio.call(this, pcm);
    };

    n0.prototype.start = async function () {
        if (this.disposed || this.stopping || this.started) return;
        this.started = true;
        this.startupAudio = [];
        this.startupBytes = 0;
        this.status('connecting', this.settings.audioSource === 'display'
            ? '請選擇音源並勾選分享音訊；正在準備持續聆聽…'
            : '正在準備麥克風與 AI 連線，請稍候顯示「持續聆聽中」再說話。');
        try {
            // prepare() requests microphone permission / audio-session activation in this tap.
            await this.capture.prepare();
            if (this.stopping || this.disposed) return;
            // Start capturing while the WebSocket is connecting, rather than afterwards.
            const connection = this.stt.connect(
                this.settings.apiKey,
                this.settings.pair ? [] : xl[this.settings.direction].source,
                this.settings.customVocabulary
            );
            const capture = this.capture.start(
                pcm => this.audio(pcm),
                message => { if (!this.stopping) this.fail(message); }
            );
            await Promise.all([connection, capture]);
            if (this.stopping || this.disposed) return;
            this.ready = true;
            this.lastTranscriptAt = Date.now();
            const buffered = this.startupAudio;
            this.startupAudio = [];
            this.startupBytes = 0;
            for (const pcm of buffered) {
                if (this.disposed || this.stopping) break;
                this.audio(pcm);
            }
            if (!this.stopping && !this.disposed) this.status('listening', this.settings.audioSource === 'display'
                ? '持續聆聽分享音訊中。停頓時也保持連線，按停止才結束。'
                : '持續聆聽中，可以說話。停頓時麥克風與 AI 連線仍保持開啟。');
        } catch (error) {
            if (this.stopping || this.disposed) return;
            const message = error instanceof DOMException && error.name === 'NotAllowedError'
                ? this.settings.audioSource === 'display'
                    ? '未允許分享音訊；請重新開始，並勾選分享分頁音訊。'
                    : '無法使用麥克風。請確認網址為 HTTPS，並允許此網站使用麥克風。'
                : error instanceof DOMException && error.name === 'NotFoundError'
                    ? '找不到麥克風，請確認裝置已連接。'
                    : Rd(error);
            this.fail(message);
        }
    };

    n0.prototype.dispose = function () {
        this.startupAudio = [];
        this.startupBytes = 0;
        dispose.call(this);
    };
})();
