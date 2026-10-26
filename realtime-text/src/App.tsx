import { Fragment, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { DIRECTIONS, LANGUAGE_PAIRS, type LanguagePair, type Mode, type ServerMessage } from '../shared/protocol';
import { BrowserTranslationSession } from './lib/session';
import { exportParagraphs, groupCaptions, inlineText, joinSpeech } from './lib/paragraphs';
import { loadApiKey, saveApiKey, loadVocabulary, saveVocabulary, parseVocabulary, loadExchangeRate, saveExchangeRate } from './lib/preferences';
import type { Caption } from './lib/types';
import { captionHistory } from './lib/history';
import { INITIAL_USAGE_HISTORY, usageHistory } from './lib/usage-history';
import { sourceLang, targetLang } from './lib/chinese';
import { defaultDirection } from './lib/languages';
import { EXCHANGE_RATE_DATE, EXCHANGE_RATE_SOURCE, formatTwd, twdBudgetToUsd, usdToTwd, validExchangeRate } from './lib/currency';

type Status = 'idle' | 'connecting' | 'ready' | 'listening' | 'finishing' | 'stopped' | 'error';
const LABEL: Record<Status, string> = {
  idle: '尚未開始', connecting: '準備連線', ready: '準備完成', listening: '聆聽中',
  finishing: '處理最後一句', stopped: '已停止', error: '需要處理',
};

function FlowingCaption({ captions, field }: { captions: Caption[]; field: 'original' | 'translation' }) {
  let previous = '';
  return captions.map(caption => {
    const text = inlineText(caption[field]);
    if (!text) return null;
    const joined = joinSpeech(previous, text);
    const addition = joined.slice(previous.length);
    previous = joined;
    const final = field === 'original' ? caption.originalFinal : caption.translationFinal;
    return <span className={final ? '' : 'live-fragment'} key={caption.id}>{addition}</span>;
  });
}

export default function App() {
  const [apiKey, setApiKey] = useState(() => loadApiKey());
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [keyExpanded, setKeyExpanded] = useState(() => !apiKey.trim());
  const [vocabulary, setVocabulary] = useState(() => loadVocabulary());
  const [pair, setPair] = useState<LanguagePair>('zh-ja');
  const direction = defaultDirection(pair);
  const [mode, setMode] = useState<Mode>('saving');
  const [budget, setBudget] = useState('');
  const [exchangeRate, setExchangeRate] = useState(() => String(loadExchangeRate()));
  const [sessionExchangeRate, setSessionExchangeRate] = useState(() => loadExchangeRate());
  const [showOriginal, setShowOriginal] = useState(true);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState(() => apiKey.trim()
    ? '已帶入記住的 API Key，按開始即可持續聆聽。' : '填入自己的 API Key，按開始即可持續聆聽。');
  const [captions, dispatchCaptions] = useReducer(captionHistory, []);
  const [{ total: usage }, dispatchUsage] = useReducer(usageHistory, INITIAL_USAGE_HISTORY);
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
  const displayRate = running || !validExchangeRate(Number(exchangeRate)) ? sessionExchangeRate : Number(exchangeRate);

  function changeStatus(value: Status) { statusRef.current = value; setStatus(value); }

  function updateApiKey(value: string) {
    setApiKey(value);
    setStorageAvailable(saveApiKey(value));
  }

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
    else if (event.type === 'usage') dispatchUsage(event);
    else dispatchCaptions({ type: 'message', event, direction });
  }

  function start() {
    if (['connecting', 'ready', 'listening', 'finishing'].includes(statusRef.current)) return;
    if (!apiKey.trim() || !secure || !supported) return;
    let amount: number | undefined;
    const rate = Number(exchangeRate);
    try { amount = twdBudgetToUsd(budget, rate); }
    catch (error) { setMessage(error instanceof Error ? error.message : '請檢查預算與匯率。'); return; }
    session.current?.dispose();
    changeStatus('connecting');
    dispatchCaptions({ type: 'start-session' }); setElapsed(0);
    setKeyExpanded(false);
    setSessionExchangeRate(rate);
    startedAt.current = Date.now(); followBottom.current = true;
    const next = new BrowserTranslationSession({ apiKey: apiKey.trim(), direction, pair, mode, budgetUsd: amount,
      customVocabulary: parseVocabulary(vocabulary), context: captions.slice(-4)
        .map(item => `${DIRECTIONS[item.direction].sourceLabel}: ${item.original}`).join('\n').slice(-512) }, receive);
    session.current = next;
    dispatchUsage({ type: 'start-session', sessionId: next.id });
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

  const paragraphs = useMemo(() => groupCaptions(captions), [captions]);
  const textOutput = useMemo(() => exportParagraphs(paragraphs, showOriginal), [paragraphs, showOriginal]);
  const hasUsage = usage.audioSeconds > 0 || usage.translationRequests > 0 || usage.estimatedUsd > 0;

  function clearHistory() {
    session.current?.dispose(); session.current = null;
    dispatchCaptions({ type: 'clear-history' });
    dispatchUsage({ type: 'clear-history' });
    startedAt.current = 0; setElapsed(0);
    setMessage('已清除字幕紀錄與累計用量、費用。');
  }

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
      <h1>即時翻譯字幕</h1>
      <span className={`status status-${status}`}><i />{LABEL[status]}</span>
    </header>

    {!secure && <div className="notice error-notice" role="alert">請用 HTTPS 網址開啟網頁，電腦測試也可使用 localhost。直接點開 HTML 或使用手機的 HTTP 網址無法開始收音。</div>}
    {secure && !supported && <div className="notice error-notice" role="alert">此瀏覽器不支援持續收音。請改用新版 Safari、Chrome 或 Edge，並從一般瀏覽器開啟。</div>}

    <section className={`key-panel ${keyExpanded ? 'expanded' : ''}`}>
      <div className="key-summary"><strong>Gemini API Key</strong><span>{apiKey.trim() ? storageAvailable ? '已記住' : '僅本次使用' : '尚未設定'}</span>
        <button type="button" onClick={() => setKeyExpanded(value => !value)} aria-expanded={keyExpanded}>
          {keyExpanded ? '收合' : '更改金鑰'}</button></div>
      {keyExpanded && <div className="key-editor"><label className="sr-only" htmlFor="api-key">你的 Gemini API Key</label>
      <div className="key-row"><input id="api-key" type={showKey ? 'text' : 'password'} value={apiKey} disabled={running}
        autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="貼上一次，下次自動帶入" onChange={event => updateApiKey(event.target.value)} />
        <button type="button" onClick={() => setShowKey(value => !value)} aria-label={showKey ? '隱藏金鑰' : '顯示金鑰'}>{showKey ? '隱藏' : '顯示'}</button>
        <button type="button" disabled={running || !apiKey} title="刪除此瀏覽器記住的 API Key"
          onClick={() => { updateApiKey(''); session.current?.dispose(); session.current = null; }}>清除</button>
      </div>
      <p role="status">{!storageAvailable ? '瀏覽器暫時無法更新儲存的金鑰。重新開啟後請確認輸入內容，本次仍可使用。'
        : apiKey.trim() ? '已在此瀏覽器記住金鑰，下次開啟會自動帶入。按「清除」即可刪除。'
        : '貼上後自動記住，只存在此裝置的這個瀏覽器。'} 音訊與文字直接送往 Google Gemini。
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">取得 API Key ↗</a></p>
      </div>}
    </section>

    <section className="control-panel">
      <label>翻譯語言（雙向）<select value={pair} disabled={running} onChange={event => setPair(event.target.value as LanguagePair)}>
        {Object.entries(LANGUAGE_PAIRS).map(([value, item]) => <option value={value} key={value}>{item.label}</option>)}
      </select></label>
      <label>更新模式<select value={mode} disabled={running} onChange={event => setMode(event.target.value as Mode)}>
        <option value="saving">省預算（約 1.5 秒）</option><option value="fast">快速（約 1 秒）</option>
      </select></label>
      <label>本場預算上限（台幣）<input value={budget} disabled={running} inputMode="decimal" placeholder="NT$，留空不限制" onChange={event => setBudget(event.target.value)} /></label>
      <div className="main-actions">
        <button className="primary" disabled={running || !apiKey.trim() || !secure || !supported} onClick={start}>● {captions.length ? '繼續聆聽' : '開始聆聽'}</button>
        <button className="stop" disabled={!running || status === 'finishing'} onClick={() => void session.current?.stop()}>■ 停止</button>
      </div>
    </section>
    <div className="settings-row"><details className="recognition-settings"><summary>辨識提示與常用詞（選填）</summary>
      <label htmlFor="vocabulary">常用詞：姓名、地名或專有名詞</label>
      <textarea id="vocabulary" value={vocabulary} disabled={running} maxLength={6000} rows={2}
        placeholder="例如：青森、弘前、國立中央大學、你的姓名"
        onChange={event => { setVocabulary(event.target.value); saveVocabulary(event.target.value); }} />
      <p>以逗號或換行分隔，最多 100 詞。AI 會在翻譯時一併校對最近語句；有明確線索才回頭修正。常用詞會在此瀏覽器記住。</p>
    </details>
    <details className="recognition-settings cost-settings"><summary>調整台幣換算匯率</summary>
      <label htmlFor="exchange-rate">1 美元換算多少台幣</label>
      <input id="exchange-rate" value={exchangeRate} disabled={running} inputMode="decimal" onChange={event => {
        setExchangeRate(event.target.value); saveExchangeRate(Number(event.target.value));
      }} />
      <p>此為可調整、會記住的參考匯率，不會自動更新。預設參考 <a href={EXCHANGE_RATE_SOURCE} target="_blank" rel="noreferrer">臺灣銀行 {EXCHANGE_RATE_DATE} 牌告</a>。實際台幣扣款依 Google 與付款方式的匯率為準。</p>
    </details></div>
    <section className="session-bar" aria-live="polite"><div><strong>{LANGUAGE_PAIRS[pair].label}</strong><span>{message}</span></div><time>{time}</time></section>
    <section className="workspace">
      <div className="section-title"><h2>字幕紀錄</h2>
        <label className="switch"><input type="checkbox" checked={showOriginal} onChange={event => setShowOriginal(event.target.checked)} />顯示原文</label></div>
      <div className="captions" ref={captionPane} onScroll={event => {
        const pane = event.currentTarget; followBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
      }}>
        {!captions.length && <div className="empty"><span>聲</span><p>按開始，讓語言跟上你的對話</p><small>請保持頁面開啟；切到背景會自動停止。</small></div>}
        {paragraphs.map((item, index) => <Fragment key={item.id}>
          {(index === 0 || paragraphs[index - 1].sessionId !== item.sessionId || paragraphs[index - 1].direction !== item.direction) && <div className="session-divider">
            <strong>{DIRECTIONS[item.direction].sourceLabel} → {DIRECTIONS[item.direction].targetLabel}</strong>
            <time>{new Date(item.receivedAt).toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit'})}</time></div>}
          <article className="caption">
          {showOriginal && <p className="original" lang={sourceLang(item.direction)}><small>{item.originalFinal ? 'AI 原文' : 'AI 原文 · 草稿'}{item.corrected ? ' · 已依上下文校正' : ''}
            </small><FlowingCaption captions={item.captions} field="original" /></p>}
          <p className="translation" lang={targetLang(item.direction)}><small>{item.translationFinal ? '譯文' : running && item.sessionId === session.current?.id ? '譯文 · 更新中' : '譯文 · 含未完成草稿'}</small>
            {item.translation ? <FlowingCaption captions={item.captions} field="translation" /> : '等待翻譯…'}</p>
        </article></Fragment>)}
      </div>
      <div className="export-actions"><button disabled={!textOutput} onClick={() => void navigator.clipboard.writeText(textOutput)
        .then(() => setMessage('字幕已複製。')).catch(() => setMessage('瀏覽器無法複製，請使用下載 TXT。'))}>複製文字</button>
        <button disabled={!textOutput} onClick={download}>下載 TXT</button>
        <button disabled={(!captions.length && !hasUsage) || running} title="清除字幕與累計用量、費用" onClick={clearHistory}>清除紀錄</button></div>
    </section>
    <section className="usage-grid" aria-label="清除紀錄前的累計用量與費用">
      <div><span>累計音訊</span><strong>{usage.audioSeconds.toFixed(1)} 秒</strong></div>
      <div><span>累計翻譯請求</span><strong>{usage.translationRequests}</strong></div>
      <div><span>累計文字 Tokens{usage.tokenEstimate ? '（估算）' : ''}</span><strong>{usage.inputTokens ?? '未知'} / {usage.outputTokens ?? '未知'}</strong></div>
      <div><span>累計估算費用（台幣）</span><strong>{formatTwd(usdToTwd(usage.estimatedUsd, displayRate))}</strong>
        <small>US$1 ≈ NT${displayRate.toLocaleString('zh-TW', {maximumFractionDigits:4})}</small></div>
    </section>
    <footer>版本 2.3 · 重新整理會清除字幕及累計用量，請先下載。費用與預算停止皆為估算，實際以帳單為準。</footer>
  </main>;
}
