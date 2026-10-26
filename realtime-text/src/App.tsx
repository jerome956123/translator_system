import { useEffect, useMemo, useRef, useState } from 'react';
import { DIRECTIONS, type Direction, type Mode, type ServerMessage, type UsageSnapshot } from '../shared/protocol';
import { MODELS } from './lib/config';
import { BrowserTranslationSession } from './lib/session';
import type { Caption } from './lib/types';

type Status = 'idle' | 'connecting' | 'ready' | 'listening' | 'finishing' | 'stopped' | 'error';
const EMPTY_USAGE: UsageSnapshot = { audioSeconds: 0, translationRequests: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, isEstimate: true };
const LABEL: Record<Status, string> = {
  idle: '尚未開始', connecting: '準備連線', ready: '準備完成', listening: '聆聽中',
  finishing: '處理最後一句', stopped: '已停止', error: '需要處理',
};

export default function App() {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [direction, setDirection] = useState<Direction>('zh-ja');
  const [mode, setMode] = useState<Mode>('saving');
  const [budget, setBudget] = useState('');
  const [showOriginal, setShowOriginal] = useState(true);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('填入自己的 API Key，按開始即可持續聆聽。');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [usage, setUsage] = useState(EMPTY_USAGE);
  const [elapsed, setElapsed] = useState(0);
  const session = useRef<BrowserTranslationSession | null>(null);
  const statusRef = useRef<Status>('idle');
  const startedAt = useRef(0);
  const captionPane = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const wakeLock = useRef<WakeLockSentinel | null>(null);

  const secure = window.isSecureContext && location.protocol !== 'file:';
  const supported = Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioContext !== 'undefined' && 'audioWorklet' in AudioContext.prototype;
  const running = ['connecting', 'ready', 'listening', 'finishing'].includes(status);

  function changeStatus(value: Status) { statusRef.current = value; setStatus(value); }

  function receive(event: ServerMessage) {
    if (event.sessionId !== session.current?.id) return;
    if (event.type === 'status') {
      changeStatus(event.status);
      setMessage(event.message ?? LABEL[event.status]);
      if (event.status === 'stopped') void wakeLock.current?.release().catch(() => {});
    } else if (event.type === 'error') {
      changeStatus('error'); setMessage(event.message);
      void wakeLock.current?.release().catch(() => {});
    } else if (event.type === 'warning') setMessage(event.message);
    else if (event.type === 'usage') setUsage(event.usage);
    else if (event.type === 'remove-captions') setCaptions(items => items.filter(item => !event.captionIds.includes(item.id)));
    else if (event.type === 'transcript') {
      setCaptions(items => {
        const existing = items.find(item => item.id === event.captionId);
        if (!existing) return [...items, {
          id: event.captionId, revision: event.revision, original: event.text, translation: '', translationRevision: 0,
          originalFinal: event.final, translationFinal: false,
        }];
        if (existing.revision > event.revision) return items;
        return items.map(item => item.id === event.captionId ? { ...item, revision: event.revision,
          original: event.text, originalFinal: event.final, translationFinal: false } : item);
      });
    } else if (event.type === 'translation') {
      setCaptions(items => items.map(item => item.id === event.captionId && event.revision >= item.translationRevision
        ? { ...item, translation: event.text, translationRevision: event.revision,
          translationFinal: event.final && item.revision === event.revision } : item));
    }
  }

  function start() {
    if (['connecting', 'ready', 'listening', 'finishing'].includes(statusRef.current)) return;
    if (!apiKey.trim() || !secure || !supported) return;
    const amount = budget.trim() ? Number(budget) : undefined;
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
      setMessage('預算請填大於 0 的美元金額，或留空。'); return;
    }
    session.current?.dispose();
    changeStatus('connecting');
    setCaptions([]); setUsage(EMPTY_USAGE); setElapsed(0);
    startedAt.current = Date.now(); followBottom.current = true;
    const next = new BrowserTranslationSession({ apiKey: apiKey.trim(), direction, mode, budgetUsd: amount }, receive);
    session.current = next;
    // 不把 Key 寫入 localStorage、sessionStorage、網頁網址列或部署產物。
    if (navigator.wakeLock) void navigator.wakeLock.request('screen').then(lock => {
      if (session.current !== next || !['connecting', 'ready', 'listening'].includes(statusRef.current)) void lock.release();
      else wakeLock.current = lock;
    }).catch(() => {});
    void next.start();
  }

  useEffect(() => {
    const tick = () => {
      if (startedAt.current && ['connecting', 'listening', 'finishing'].includes(statusRef.current))
        setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    };
    const interval = window.setInterval(tick, 1000);
    // 行動瀏覽器在背景可能暫停音訊，主動收尾而不是假裝仍持續辨識。
    const hidden = () => {
      if (document.hidden && ['connecting', 'ready', 'listening'].includes(statusRef.current))
        void session.current?.stop('頁面已切到背景，正在停止收音；返回後可重新開始。');
    };
    const leave = () => {
      session.current?.dispose();
      if (['connecting', 'ready', 'listening', 'finishing'].includes(statusRef.current)) {
        changeStatus('stopped'); setMessage('頁面已暫停，按開始可開啟新場次。');
      }
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leave);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leave);
      session.current?.dispose();
      void wakeLock.current?.release().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const pane = captionPane.current;
    if (pane && followBottom.current) pane.scrollTop = pane.scrollHeight;
  }, [captions]);

  const textOutput = useMemo(() => captions.map(item => {
    const label = item.originalFinal && item.translationFinal ? '' : '（草稿）';
    return [showOriginal ? `[原文${item.originalFinal ? '' : '草稿'}] ${item.original}` : '',
      item.translation ? `[譯文${label}] ${item.translation}` : ''].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n'), [captions, showOriginal]);

  function download() {
    const url = URL.createObjectURL(new Blob(['\uFEFF', textOutput], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `即時翻譯_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  const time = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  return <main className={`page-shell ${running ? 'session-active' : ''}`}>
    <header className="hero">
      <div><p className="eyebrow">LIVE TEXT INTERPRETER</p><h1>即時翻譯字幕</h1><p>邊聽、邊看翻譯。手機與電腦都能使用。</p></div>
      <span className={`status status-${status}`}><i />{LABEL[status]}</span>
    </header>

    {!secure && <div className="notice error-notice" role="alert">請用 HTTPS 網址開啟網頁，電腦測試也可使用 localhost。直接點開 HTML 或使用手機的 HTTP 網址無法開始收音。</div>}
    {secure && !supported && <div className="notice error-notice" role="alert">此瀏覽器不支援持續收音。請改用新版 Safari、Chrome 或 Edge，並從一般瀏覽器開啟。</div>}

    <section className="key-panel">
      <label htmlFor="api-key">你的 Gemini API Key</label>
      <div className="key-row"><input id="api-key" type={showKey ? 'text' : 'password'} value={apiKey} disabled={running}
        autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="貼上自己的 API Key" onChange={event => setApiKey(event.target.value)} />
        <button type="button" onClick={() => setShowKey(value => !value)} aria-label={showKey ? '隱藏金鑰' : '顯示金鑰'}>{showKey ? '隱藏' : '顯示'}</button>
        <button type="button" disabled={running || !apiKey} onClick={() => { setApiKey(''); session.current?.dispose(); session.current = null; }}>清除</button>
      </div>
      <p>金鑰只留在本次頁面，重新整理後需再輸入。音訊與文字會直接送往 Google Gemini。
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">取得 API Key ↗</a></p>
    </section>

    <section className="control-panel">
      <label>翻譯方向<select value={direction} disabled={running} onChange={event => setDirection(event.target.value as Direction)}>
        {Object.entries(DIRECTIONS).map(([value, item]) => <option value={value} key={value}>{item.sourceLabel} → {item.targetLabel}</option>)}
      </select></label>
      <label>更新模式<select value={mode} disabled={running} onChange={event => setMode(event.target.value as Mode)}>
        <option value="saving">省預算（約 1.5 秒）</option><option value="fast">快速（約 1 秒）</option>
      </select></label>
      <label>本場預算上限（美元）<input value={budget} disabled={running} inputMode="decimal" placeholder="留空不限制" onChange={event => setBudget(event.target.value)} /></label>
      <div className="main-actions">
        <button className="primary" disabled={running || !apiKey.trim() || !secure || !supported} onClick={start}>● 開始聆聽</button>
        <button className="stop" disabled={!running || status === 'finishing'} onClick={() => void session.current?.stop()}>■ 停止</button>
      </div>
    </section>
    <section className="session-bar" aria-live="polite"><div><strong>{DIRECTIONS[direction].sourceLabel} → {DIRECTIONS[direction].targetLabel}</strong><span>{message}</span></div><time>{time}</time></section>
    <section className="workspace">
      <div className="section-title"><div><h2>字幕</h2><p>譯文持續補上，草稿會隨後續內容修正。</p></div>
        <label className="switch"><input type="checkbox" checked={showOriginal} onChange={event => setShowOriginal(event.target.checked)} />顯示原文</label></div>
      <div className="captions" ref={captionPane} onScroll={event => {
        const pane = event.currentTarget; followBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
      }}>
        {!captions.length && <div className="empty"><span>聲</span><p>按開始，讓語言跟上你的對話</p><small>請保持頁面開啟；切到背景會自動停止。</small></div>}
        {captions.map(item => <article className={item.originalFinal ? 'caption' : 'caption draft'} key={item.id}>
          {showOriginal && <p className="original"><small>{item.originalFinal ? '原文' : '原文草稿'}</small>{item.original}</p>}
          <p className="translation"><small>{item.translationFinal ? '譯文' : running ? '譯文草稿' : '未完成草稿'}</small>{item.translation || '等待翻譯…'}</p>
        </article>)}
      </div>
      <div className="export-actions"><button disabled={!textOutput} onClick={() => void navigator.clipboard.writeText(textOutput)
        .then(() => setMessage('字幕已複製。')).catch(() => setMessage('瀏覽器無法複製，請使用下載 TXT。'))}>複製文字</button>
        <button disabled={!textOutput} onClick={download}>下載 TXT</button></div>
    </section>
    <section className="usage-grid">
      <div><span>傳送音訊</span><strong>{usage.audioSeconds.toFixed(1)} 秒</strong></div>
      <div><span>翻譯請求</span><strong>{usage.translationRequests}</strong></div>
      <div><span>文字 Tokens{usage.tokenEstimate ? '（估算）' : ''}</span><strong>{usage.inputTokens ?? '未知'} / {usage.outputTokens ?? '未知'}</strong></div>
      <div><span>估算費用</span><strong>US${usage.estimatedUsd.toFixed(4)}</strong></div>
    </section>
    <footer>本頁不生成語音。費用與預算停止都是估算，實際帳單以 Google 為準。<br />{MODELS.stt} ＋ {MODELS.translation}</footer>
  </main>;
}
