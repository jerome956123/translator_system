import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { config, publicConfig } from './config.js';
import { GeminiSTTSession } from './stt.js';
import { streamTranslation } from './translator.js';
import { TranslationScheduler, type TranslationTask } from './scheduler.js';
import { UsageTracker } from './usage.js';
import { DIRECTIONS, isDirection, type ClientMessage, type Direction, type ServerMessage } from '../shared/protocol.js';

const app = express();
app.disable('x-powered-by');
app.get('/api/config', (_request, response) => response.json(publicConfig()));
app.get('/api/health', (_request, response) => response.json({ ok: true, configured: Boolean(config.apiKey) }));

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, '../../dist');
app.use(express.static(publicDir));
app.use((_request, response) => response.sendFile(path.join(publicDir, 'index.html')));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
let activeConnections = 0;

function allowedOrigin(origin: string | undefined) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && ['3000', '5173'].includes(url.port);
  } catch { return false; }
}

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws' || !allowedOrigin(request.headers.origin) || activeConnections >= 4) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
});

class ClientSession {
  private client: WebSocket;
  private sessionId = '';
  private direction: Direction = 'zh-ja';
  private stt: GeminiSTTSession | null = null;
  private scheduler: TranslationScheduler | null = null;
  private usage = new UsageTracker();
  private captionNumber = 1;
  private captionRevision = 0;
  private completedOriginals: string[] = [];
  private stopping = false;
  private started = false;
  private listeningAnnounced = false;
  private budgetUsd?: number;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUsageSentAt = 0;

  constructor(client: WebSocket) {
    this.client = client;
    client.on('message', (data, binary) => binary ? this.onAudio(Buffer.from(data as Buffer)) : this.onControl(data.toString()));
    client.on('close', () => this.dispose());
    client.on('error', () => this.dispose());
  }

  private send(message: ServerMessage) {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(message));
  }

  private onControl(raw: string) {
    let message: ClientMessage;
    try { message = JSON.parse(raw) as ClientMessage; }
    catch { return this.fail('BAD_MESSAGE', '收到無法解析的控制訊息。', false); }
    if (message.type === 'start') void this.start(message);
    else if (message.type === 'stop' && message.sessionId === this.sessionId) void this.stop();
  }

  private async start(message: Extract<ClientMessage, { type: 'start' }>) {
    if (this.started || !isDirection(message.direction)) return this.fail('INVALID_START', '這個連線已啟動，或語言方向不正確。', false);
    this.started = true;
    this.sessionId = message.sessionId;
    this.direction = message.direction;
    this.budgetUsd = message.budgetUsd && message.budgetUsd > 0 ? message.budgetUsd : config.defaultBudgetUsd;
    if (!config.apiKey) return this.fail('NOT_CONFIGURED', '尚未設定 GEMINI_API_KEY。請依 README 建立 .env 後重新啟動。', false);
    this.send({ type: 'status', sessionId: this.sessionId, status: 'connecting', message: '正在連接 Gemini 語音辨識…' });
    const interval = message.mode === 'fast' ? 1000 : config.translationIntervalMs;
    this.scheduler = new TranslationScheduler({
      intervalMs: interval,
      translate: (task, _requestId, onChunk) => streamTranslation({ ...task, onChunk }),
      onTranslation: (event) => this.send({
        type: 'translation', sessionId: this.sessionId, captionId: event.captionId,
        revision: event.revision, requestId: event.requestId, text: event.translatedText,
        final: event.complete && event.final, firstTokenAt: event.firstTokenAt,
      }),
      onUsage: (requestId, result, task) => {
        this.usage.addTranslation(requestId, result.inputTokens, result.outputTokens, task.context + task.text, result.text);
        this.sendUsage(true);
        this.checkBudget();
      },
      onWarning: (warning) => this.send({ type: 'warning', sessionId: this.sessionId, message: warning }),
    });
    this.stt = new GeminiSTTSession({
      onReady: () => this.send({ type: 'status', sessionId: this.sessionId, status: 'ready', message: '已連線，可以開始說話。' }),
      onInterim: (text) => this.onTranscript(text, false),
      onFinal: (text) => this.onTranscript(text, true),
      onError: (error) => this.fail('STT_ERROR', error, false),
      onClose: () => {
        if (!this.stopping && this.started) this.fail('STT_CLOSED', '語音辨識連線已中斷；未重送先前音訊，以免重複計費與字幕。', false);
      },
    });
    this.stt.connect(DIRECTIONS[this.direction].source);
  }

  private captionId() { return `${this.sessionId}-caption-${this.captionNumber}`; }

  private onTranscript(text: string, final: boolean) {
    if (this.stopping && !final) return;
    this.captionRevision += 1;
    const captionId = this.captionId();
    const revision = this.captionRevision;
    const context = this.completedOriginals.slice(-2).join('\n').slice(-(config.translationContextMaxTokens * 3));
    this.send({ type: 'transcript', sessionId: this.sessionId, captionId, revision, text, final, receivedAt: Date.now() });
    const task: TranslationTask = { sessionId: this.sessionId, captionId, revision, text, context, direction: this.direction, final };
    this.scheduler?.enqueue(task);
    if (final) {
      this.completedOriginals.push(text);
      this.completedOriginals = this.completedOriginals.slice(-2);
      this.captionNumber += 1;
      this.captionRevision = 0;
    }
  }

  private onAudio(data: Buffer) {
    if (!this.started || this.stopping || !this.stt) return;
    if (data.length < 2 || data.length > 64 * 1024 || data.length % 2 !== 0) return this.fail('BAD_AUDIO', '音訊封包格式不正確。', false);
    try {
      if (!this.stt.sendAudio(data)) return;
      this.usage.addAudioBytes(data.length);
      if (!this.listeningAnnounced) {
        this.listeningAnnounced = true;
        this.send({ type: 'status', sessionId: this.sessionId, status: 'listening', message: '正在聆聽與翻譯。' });
      }
      this.sendUsage(false);
      this.checkBudget();
    } catch (error) {
      this.fail('AUDIO_BACKPRESSURE', error instanceof Error ? error.message : '音訊傳送壅塞。', false);
      void this.stop();
    }
  }

  private sendUsage(force: boolean) {
    if (!force && Date.now() - this.lastUsageSentAt < 1000) return;
    this.lastUsageSentAt = Date.now();
    this.send({ type: 'usage', sessionId: this.sessionId, usage: this.usage.snapshot() });
  }

  private checkBudget() {
    if (this.budgetUsd && this.usage.snapshot().estimatedUsd >= this.budgetUsd && !this.stopping) {
      this.send({ type: 'warning', sessionId: this.sessionId, message: '本場估算費用已達設定上限，正在停止。已送出的請求仍可能產生少量費用。' });
      void this.stop();
    }
  }

  private async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.send({ type: 'status', sessionId: this.sessionId, status: 'finishing', message: '正在等待最後一句定稿…' });
    this.stt?.endAudio();
    await new Promise<void>((resolve) => { this.finishTimer = setTimeout(resolve, 1800); });
    await this.scheduler?.flush(3500);
    this.finishTimer = null;
    this.sendUsage(true);
    this.stt?.close();
    this.scheduler?.close();
    this.send({ type: 'status', sessionId: this.sessionId, status: 'stopped', message: '已停止。' });
  }

  private fail(code: string, message: string, recoverable: boolean) {
    this.send({ type: 'error', sessionId: this.sessionId, code, message, recoverable });
  }

  dispose() {
    this.stopping = true;
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.stt?.close();
    this.scheduler?.close();
  }
}

wss.on('connection', (client) => {
  activeConnections += 1;
  const session = new ClientSession(client);
  client.once('close', () => { session.dispose(); activeConnections = Math.max(0, activeConnections - 1); });
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`即時翻譯字幕已啟動：http://localhost:${config.port}`);
  if (!config.apiKey) console.warn('尚未設定 GEMINI_API_KEY；介面可開啟，但不能開始辨識。');
});
