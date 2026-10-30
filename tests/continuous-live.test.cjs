const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function between(start, end) {
    const at = code.indexOf(start); assert.ok(at >= 0, start);
    const until = code.indexOf(end, at); assert.ok(until > at, end);
    return code.slice(at, until);
}
const sessionSource = between('class n0{', 'const u0=');
const sttSource = between('class xv{', 'class zv{');
const patch = between('/* continuous-listening-fix:start */', '/* continuous-listening-fix:end */');
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    promise.catch(() => {});
    return { promise, resolve, reject };
}
function clock() {
    let now = 0, serial = 0;
    const timers = new Map();
    const setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; };
    const clearTimeout = id => timers.delete(id);
    async function advance(ms) {
        const end = now + ms;
        for (;;) {
            const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            timers.delete(next[0]); now = next[1].at; next[1].fn(); await tick();
        }
        now = end; await tick();
    }
    class FakeDate extends Date { static now() { return now; } }
    return { setTimeout, clearTimeout, advance, Date: FakeDate };
}

function sessionEnvironment({ permission } = {}) {
    const time = clock(), messages = [], transcripts = [];
    const connected = deferred(), firstFrame = deferred();
    let callbacks;
    const capture = {
        prepareCalls: 0, startCalls: 0, stopCalls: 0, stopped: false,
        prepare() { this.prepareCalls++; return permission?.promise || Promise.resolve(); },
        start(onChunk, onError) {
            this.startCalls++; this.onChunk = onChunk; this.onError = onError;
            return firstFrame.promise;
        },
        emit(samples) { this.onChunk(new Int16Array(samples).buffer); firstFrame.resolve(); },
        async stop(flush) {
            if (this.stopped) return;
            this.stopped = true; this.stopCalls++;
            if (flush && this.tail) this.onChunk(new Int16Array(this.tail).buffer);
            firstFrame.reject(new DOMException('Stopped', 'AbortError'));
        }
    };
    const stt = {
        connectCalls: [], sent: [], ends: 0, closes: 0,
        connect(...args) { this.connectCalls.push(args); return connected.promise; },
        sendAudio(pcm) { this.sent.push(Buffer.from(pcm)); return true; },
        endAudio() { this.ends++; },
        close() { this.closes++; connected.reject(new DOMException('Stopped', 'AbortError')); }
    };
    const globals = { ...time, console, DOMException, crypto: { randomUUID },
        Ts: direction => direction.slice(0, 2), _v: class {},
        xl: { 'zh-ja': { source: 'cmn-Hans-CN' } },
        Rd: error => error.message,
        Tv: pcm => Math.abs(new Int16Array(pcm)[0] || 0) / 32768,
        a0: class {
            bytes = 0;
            addAudioBytes(n) { this.bytes += n; }
            snapshot() { return { audioSeconds: this.bytes / 32000, estimatedUsd: this.bytes / 32000 / 60 * 0.009 }; }
        },
        zv: class {
            constructor(options) { this.options = options; }
            close() {} async flush() { return true; }
        }
    };
    const Session = vm.runInNewContext(sessionSource + '\n' + patch + '\nn0', globals);
    const session = new Session({ apiKey: 'TEST_PLACEHOLDER', direction: 'zh-ja', pair: 'zh-ja', mode: 'saving', customVocabulary: ['青森'] },
        message => messages.push(message), { capture, createSTT: c => { callbacks = c; return stt; } });
    session.transcript = (...args) => transcripts.push(args);
    async function ready() {
        const starting = session.start(); await tick();
        capture.emit([1, 2]); connected.resolve(); await starting;
    }
    return { session, capture, stt, connected, firstFrame, ready, messages, transcripts, time, callbacks: () => callbacks };
}

test('the uploadable single page parses and keeps bilingual, Taiwan text and TWD controls', () => {
    new vm.Script(code);
    for (const text of ['翻譯語言（雙向）', '繁體中文 ↔ 日本語', '日本語 ↔ English', '本場預算上限（台幣）', '累計估算費用（台幣）', '版本 2.3.3', 'realtime-translator.api-key.v1'])
        assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/);
    assert.ok(!code.includes('SpeechRecognition'));
});

test('capture begins while model setup is pending and the first quiet samples are retained', async () => {
    const env = sessionEnvironment(); const starting = env.session.start(); await tick();
    assert.equal(env.capture.startCalls, 1); assert.equal(env.stt.connectCalls.length, 1);
    env.capture.emit([1, -1, 0]); env.capture.emit([2, -2, 0]);
    assert.equal(env.stt.sent.length, 0);
    assert.equal(env.messages.filter(m => m.status === 'listening').length, 0);
    env.connected.resolve(); await starting;
    assert.deepEqual(Buffer.concat(env.stt.sent), Buffer.from(new Int16Array([1, -1, 0, 2, -2, 0]).buffer));
    assert.match(env.messages.find(m => m.status === 'listening').message, /持續聆聽中/);
    env.session.dispose();
});

test('connected does not mean listening until audio capture confirms its first frame', async () => {
    const env = sessionEnvironment(); const starting = env.session.start(); await tick();
    env.connected.resolve(); await tick();
    assert.equal(env.messages.filter(m => m.status === 'listening').length, 0);
    env.capture.emit([0]); await starting;
    assert.equal(env.messages.filter(m => m.status === 'listening').length, 1); env.session.dispose();
});

test('long silence is sent without restarting and the next opening sound stays in order', async () => {
    const env = sessionEnvironment(); await env.ready();
    for (let i = 0; i < 160; i++) { env.capture.emit(Array(1600).fill(0)); await env.time.advance(100); }
    env.capture.emit([7, 8, 9]);
    assert.equal(env.capture.startCalls, 1); assert.equal(env.stt.connectCalls.length, 1);
    assert.equal(env.capture.stopCalls, 0); assert.equal(env.stt.ends, 0); assert.equal(env.stt.sent.length, 162);
    assert.deepEqual(env.stt.sent.at(-1), Buffer.from(new Int16Array([7, 8, 9]).buffer));
    assert.equal(env.session.usage.bytes, 2 * (2 + 160 * 1600 + 3)); env.session.dispose();
});

test('repeated start does not create a second microphone or model connection', async () => {
    const env = sessionEnvironment(); await env.ready(); await env.session.start();
    assert.equal(env.capture.startCalls, 1); assert.equal(env.stt.connectCalls.length, 1); env.session.dispose();
});

test('startup queue has a limit and releases all sound after a connection error', async () => {
    const env = sessionEnvironment(); const starting = env.session.start(); await tick();
    env.capture.emit([1]); env.connected.reject(new Error('Network unavailable')); await starting;
    assert.equal(env.session.startupAudio.length, 0); assert.equal(env.session.startupBytes, 0);
    assert.equal(env.stt.sent.length, 0); assert.equal(env.capture.stopCalls, 1);
    assert.equal(env.messages.at(-1).type, 'error');
    const slow = sessionEnvironment(); const opening = slow.session.start(); await tick();
    slow.capture.emit(Array(320001).fill(0)); await opening;
    assert.equal(slow.session.disposed, true); assert.equal(slow.session.startupAudio.length, 0);
    assert.match(slow.messages.at(-1).message, /準備太久/);
});

test('cancel during permission or startup never starts a late listening session', async () => {
    const permission = deferred(); const env = sessionEnvironment({ permission });
    const starting = env.session.start(); await tick(); await env.session.stop(); permission.resolve(); await starting;
    assert.equal(env.capture.startCalls, 0); assert.equal(env.stt.connectCalls.length, 0);
    assert.equal(env.messages.filter(m => m.status === 'listening').length, 0);
    const second = sessionEnvironment(); const opening = second.session.start(); await tick();
    second.capture.emit([3]); await second.session.stop(); await opening;
    assert.equal(second.session.startupAudio.length, 0); assert.equal(second.stt.sent.length, 0);
});

test('permission rejection reports the problem without leaving the microphone open', async () => {
    const permission = deferred(); const env = sessionEnvironment({ permission });
    const starting = env.session.start(); permission.reject(new DOMException('Denied', 'NotAllowedError')); await starting;
    assert.equal(env.capture.stopCalls, 1); assert.match(env.messages.at(-1).message, /允許此網站/);
});

test('stop flushes the tail, ends the stream, and accepts a last one-character final', async () => {
    const env = sessionEnvironment(); await env.ready(); env.capture.tail = [11, 12];
    const stopping = env.session.stop(); await tick();
    assert.deepEqual(env.stt.sent.at(-1), Buffer.from(new Int16Array([11, 12]).buffer));
    assert.equal(env.stt.ends, 1); assert.equal(env.capture.stopCalls, 1);
    env.callbacks().onFinal('去', 'cmn-Hans-CN'); await stopping;
    assert.deepEqual(env.transcripts, [['去', true, 'cmn-Hans-CN']]);
    assert.equal(env.session.disposed, true);
});

test('startup audio is charged once and still obeys the existing budget guard', async () => {
    const env = sessionEnvironment(); env.session.settings.budgetUsd = 0.000001;
    const opening = env.session.start(); await tick();
    env.capture.emit(Array(1600).fill(0)); env.capture.emit(Array(1600).fill(0));
    env.connected.resolve(); await opening;
    assert.equal(env.session.usage.bytes, 3200);
    assert.equal(env.session.disposed, true); assert.match(env.messages.at(-1).message, /已達本場上限/);
    assert.equal(env.session.startupAudio.length, 0);
});

function sttEnvironment() {
    const time = clock(), sockets = [], interims = [], finals = [], errors = [];
    class Socket {
        static OPEN = 1; static CLOSING = 2;
        constructor() { sockets.push(this); this.readyState = 0; this.bufferedAmount = 0; this.sent = []; }
        open() { this.readyState = 1; this.onopen(); }
        emit(data) { this.onmessage({ data: JSON.stringify(data) }); }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { this.readyState = 3; }
    }
    const STT = vm.runInNewContext(sttSource + '\nxv', { ...time, WebSocket: Socket, Blob, TextDecoder, DOMException,
        Ld: { stt: 'gemini-3.5-transcribe-live' }, Iu: (text, key) => text.split(key).join('[hidden]'),
        btoa: binary => Buffer.from(binary, 'binary').toString('base64') });
    const stt = new STT({ onInterim: (...a) => interims.push(a), onFinal: (...a) => finals.push(a), onError: e => errors.push(e) });
    return { stt, sockets, interims, finals, errors };
}

test('Live setup preserves multilingual detection and vocabulary with verbatim, sensitive starts', async () => {
    const env = sttEnvironment(); const opening = env.stt.connect('TEST_PLACEHOLDER', [], ['青森']);
    const socket = env.sockets[0]; socket.open();
    const { setup } = socket.sent[0];
    assert.equal(setup.model, 'models/gemini-3.5-transcribe-live');
    assert.deepEqual(setup.inputAudioTranscription.languageCodes, []);
    assert.deepEqual(setup.inputAudioTranscription.customVocabulary, ['青森']);
    assert.equal(setup.inputAudioTranscription.mode, 'VERBATIM');
    assert.equal(setup.realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity, 'START_SENSITIVITY_HIGH');
    assert.equal(setup.realtimeInputConfig.automaticActivityDetection.prefixPaddingMs, 20);
    socket.emit({ setupComplete: {} }); await opening; env.stt.close();
});

test('Live transcriptions preserve short words and original language metadata for bilingual routing', async () => {
    const env = sttEnvironment(); const opening = env.stt.connect('TEST_PLACEHOLDER', []);
    const socket = env.sockets[0]; socket.open(); socket.emit({ setupComplete: {} }); await opening;
    socket.emit({ serverContent: { interimInputTranscription: { text: '我', languageCode: 'cmn-Hans-CN' } } });
    socket.emit({ serverContent: { inputTranscription: { text: 'はい', languageCode: 'ja-JP' } } }); await tick();
    assert.deepEqual(env.interims, [['我', 'cmn-Hans-CN']]); assert.deepEqual(env.finals, [['はい', 'ja-JP']]); env.stt.close();
});

test('network backpressure raises an error instead of silently discarding sound', async () => {
    const env = sttEnvironment(); const opening = env.stt.connect('TEST_PLACEHOLDER', []);
    const socket = env.sockets[0]; socket.open(); socket.emit({ setupComplete: {} }); await opening;
    socket.bufferedAmount = 64001;
    assert.throws(() => env.stt.sendAudio(new Int16Array([1]).buffer), /網路傳送壅塞/); env.stt.close();
});

for (const rate of [16000, 44100, 48000]) test(`actual worklet at ${rate} Hz preserves the first quiet sample and tail`, () => {
    const expression = between('bv=`', ';function Tv').slice(3);
    const worklet = vm.runInNewContext(expression);
    let Processor; const packets = [], signals = [];
    vm.runInNewContext(worklet, { sampleRate: rate,
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => {
            if (data instanceof ArrayBuffer || data.byteLength) packets.push(Buffer.from(data)); else signals.push(data);
        }}; } }, registerProcessor: (_, type) => { Processor = type; } });
    const processor = new Processor({ processorOptions: {} });
    const input = new Float32Array(rate + Math.ceil(rate / 16000) * 17); input[0] = 0.005;
    for (let offset = 0; offset < input.length; offset += 128) processor.process([[input.subarray(offset, offset + 128)]]);
    processor.port.onmessage({ data: { type: 'flush' } });
    const audio = Buffer.concat(packets);
    assert.ok(Math.abs(audio.readInt16LE(0) - 0.005 * 32767) <= 1);
    assert.ok(audio.length / 2 >= 16016 && audio.length / 2 <= 16025);
    assert.equal(audio.readInt16LE(audio.length - 2), 0); assert.equal(signals.at(-1).type, 'flushed');
});
