import { Fragment, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { DIRECTIONS, LANGUAGE_PAIRS, type AudioSource, type Language, type LanguagePair, type TranslationMode, type TalkState, type ServerMessage } from '../shared/protocol';
import { BrowserTranslationSession } from './lib/session';
import { changedRange, exportParagraphs, gapText, groupCaptions, inlineText, joinSpeech, type CaptionParagraph } from './lib/paragraphs';
import { loadApiKey, saveApiKey, loadVocabulary, saveVocabulary, loadExchangeRate, saveExchangeRate, loadTranslationMode, saveTranslationMode,
  loadScene, saveScene, loadJapaneseRegister, saveJapaneseRegister, pairPreference, qualityPreference, pacePreference, themePreference,
  audioSourcePreference, showOriginalPreference, autoResumePreference, autoSpeakPreference, loadBudget, saveBudget,
  faceNearPreference, faceFlipPreference, faceSpeakPreference,
  loadFontScale, saveFontScale, clampFontScale, FONT_SCALE, type Theme } from './lib/preferences';
import { cleanScene, JAPANESE_REGISTERS, parseTerms, recentPairs, SCENE_MAX_CHARS, type JapaneseRegister } from './lib/guidance';
import { PACES, QUALITY_MODELS, type Pace, type Quality } from './lib/config';
import type { Caption } from './lib/types';
import { captionHistory } from './lib/history';
import { clearCaptions, loadCaptions, saveCaptions } from './lib/history-store';
import { INITIAL_USAGE_HISTORY, usageHistory } from './lib/usage-history';
import { resumeOnReturn, stopWhenHidden } from './lib/page-visibility';
import { sourceLang, targetLang } from './lib/chinese';
import { defaultDirection, LANGUAGE_LABELS } from './lib/languages';
import { EXCHANGE_RATE_DATE, EXCHANGE_RATE_SOURCE, formatTwd, twdBudgetToUsd, usdToTwd, validExchangeRate } from './lib/currency';
import { recognitionText, exportComparison, audioTime } from './lib/diagnostics';
import { PrecisionTranslationSession } from './lib/precision-session';
import { PushToTalkButton } from './PushToTalkButton';
import { FaceToFace } from './FaceToFace';
import { faceLanguages } from './lib/face';
import { watchPageInactivity } from './lib/page-inactivity';
import { speak, speechSupported, stopSpeaking, unlockSpeech } from './lib/speech';

type Status = 'idle' | 'connecting' | 'ready' | 'listening' | 'finishing' | 'stopped' | 'error';
const LABEL: Record<Status, string> = {
  idle: '尚未開始', connecting: '準備連線', ready: '準備完成', listening: '聆聽中',
  finishing: '處理最後一句', stopped: '已停止', error: '需要處理',
};
const ACTIVE: Status[] = ['connecting', 'ready', 'listening', 'finishing'];
const THEMES: Record<Theme, string> = { auto: '跟隨系統', dark: '深色', light: '淺色' };

function FlowingCaption({ captions, field }: { captions: Caption[]; field: 'original' | 'translation' | 'recognition' }) {
  let previous = '';
  return captions.map(caption => {
    const text = inlineText(field === 'recognition' ? recognitionText(caption) : caption[field]);
    if (!text) return null;
    const joined = joinSpeech(previous, text);
    const addition = joined.slice(previous.length);
    previous = joined;
    const final = field === 'translation' ? caption.translationFinal : caption.originalFinal;
    // 已顯示過的譯文被後文校對改寫：標出改動的部分，游標停留可看校對前的版本。
    const before = field === 'translation' && caption.previousTranslation ? inlineText(caption.previousTranslation) : '';
    if (before && before !== text) {
      const lead = addition.length - text.length;
      const { start, end } = changedRange(before, text);
      if (end > start) return <span className={final ? '' : 'live-fragment'} key={caption.id}>{addition.slice(0, lead + start)}
        <mark className="revised" key={caption.revisedAt} title={`校對前：${before}`}>{text.slice(start, end)}</mark>{text.slice(end)}</span>;
    }
    return <span className={final ? '' : 'live-fragment'} key={caption.id}>{addition}</span>;
  });
}

export default function App() {
  const [apiKey, setApiKey] = useState(() => loadApiKey());
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [keyExpanded, setKeyExpanded] = useState(() => !apiKey.trim());
  // 還沒有金鑰時把金鑰欄放在最上面；設定好並開始過一次後移到設定區。
  const [keyOnTop, setKeyOnTop] = useState(() => !apiKey.trim());
  const [vocabulary, setVocabulary] = useState(() => loadVocabulary());
  const [scene, setScene] = useState(() => loadScene());
  const [register, setRegister] = useState<JapaneseRegister>(() => loadJapaneseRegister());
  const [quality, setQuality] = useState<Quality>(() => qualityPreference.load());
  const [pace, setPace] = useState<Pace>(() => pacePreference.load());
  const [theme, setTheme] = useState<Theme>(() => themePreference.load());
  const [fontScale, setFontScale] = useState(() => loadFontScale());
  const [autoResume, setAutoResume] = useState(() => autoResumePreference.load());
  const [autoSpeak, setAutoSpeak] = useState(() => autoSpeakPreference.load());
  const [faceNear, setFaceNear] = useState<Language>(() => faceNearPreference.load());
  const [faceFlip, setFaceFlip] = useState(() => faceFlipPreference.load());
  const [faceSpeak, setFaceSpeak] = useState(() => faceSpeakPreference.load());
  const [faceOpen, setFaceOpen] = useState(false);
  const [talkSpeaker, setTalkSpeaker] = useState<Language | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [pendingSeconds, setPendingSeconds] = useState(0);
  const [precisionBusy, setPrecisionBusy] = useState(false);
  const [pair, setPair] = useState<LanguagePair>(() => pairPreference.load());
  const direction = defaultDirection(pair);
  const [translationMode, setTranslationMode] = useState(() => loadTranslationMode());
  const [talkState, setTalkState] = useState<TalkState>('idle');
  const [audioSource, setAudioSource] = useState<AudioSource>(() => audioSourcePreference.load());
  const [audioLevel, setAudioLevel] = useState<number | null>(null);
  const [budget, setBudget] = useState(() => loadBudget());
  const [exchangeRate, setExchangeRate] = useState(() => String(loadExchangeRate()));
  const [sessionExchangeRate, setSessionExchangeRate] = useState(() => loadExchangeRate());
  const [showOriginal, setShowOriginal] = useState(() => showOriginalPreference.load());
  const [readingMode, setReadingMode] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const [recentAudioSeconds, setRecentAudioSeconds] = useState(0);
  const [audioClip, setAudioClip] = useState<{
    url: string; durationSeconds: number; startSeconds: number; endSeconds: number;
    sessionId: string; pairLabel: string; filename: string;
  } | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  // 上次的翻譯文字自動保存在此瀏覽器；開啟時直接還原。
  const [captions, dispatchCaptions] = useReducer(captionHistory, undefined, () => loadCaptions().captions);
  const [message, setMessage] = useState(() => captions.length
    ? `已還原上次保存的翻譯紀錄（${captions.filter(item => !item.gap).length} 句）；按「清除紀錄」可刪除。`
    : apiKey.trim() ? '已帶入記住的 API Key，按開始即可使用。' : '填入自己的 API Key，按開始即可使用。');
  const [{ total: usage }, dispatchUsage] = useReducer(usageHistory, INITIAL_USAGE_HISTORY);
  const [elapsed, setElapsed] = useState(0);
  const session = useRef<BrowserTranslationSession | PrecisionTranslationSession | null>(null);
  const sessionPair = useRef<LanguagePair>(pair);
  const statusRef = useRef<Status>('idle');
  const startedAt = useRef(0);
  const captionPane = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const hiddenStopAt = useRef<number | undefined>(undefined);
  const spoken = useRef(new Set<string>());
  const faceOpenRef = useRef(false);
  const faceSince = useRef(0);
  const latestCaptions = useRef(captions); latestCaptions.current = captions;
  const autoResumeRef = useRef(autoResume); autoResumeRef.current = autoResume;

  const manual = translationMode !== 'precision';
  const face = translationMode === 'face-to-face';
  // 面對面對講只用麥克風；分享分頁音訊對兩人對話沒有意義。
  const source: AudioSource = face ? 'microphone' : audioSource;
  const secure = window.isSecureContext && location.protocol !== 'file:';
  const displaySupported = Boolean(navigator.mediaDevices?.getDisplayMedia);
  const supported = Boolean(source === 'display' ? displaySupported : navigator.mediaDevices?.getUserMedia)
    && typeof AudioContext !== 'undefined' && 'audioWorklet' in AudioContext.prototype;
  const canSpeak = speechSupported();
  const running = ACTIVE.includes(status);
  const statusLabel = status === 'listening' && manual
    ? talkState === 'speaking' ? '收音翻譯中' : talkState === 'tail' ? '收完尾音' : talkState === 'finishing' ? '完成這句中' : face ? '對講中' : '對講機待命'
    : status === 'listening' ? '精準翻譯中' : LABEL[status];
  const displayRate = running || !validExchangeRate(Number(exchangeRate)) ? sessionExchangeRate : Number(exchangeRate);
  const terms = useMemo(() => parseTerms(vocabulary), [vocabulary]);
  const paragraphs = useMemo(() => groupCaptions(captions), [captions]);
  const japanesePair = (LANGUAGE_PAIRS[pair].languages as readonly string[]).includes('ja');
  const rhythm = PACES[pace];
  const firstText = `${rhythm.minSeconds + rhythm.lookaheadSeconds}–${rhythm.maxSeconds + rhythm.lookaheadSeconds}`;
  const sides = faceLanguages(pair, faceNear);
  const touchDevice = useMemo(() => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches, []);
  const flip = faceFlip === 'on' || (faceFlip === 'auto' && touchDevice);
  const speakAuto = face ? faceSpeak : autoSpeak;

  function changeStatus(value: Status) { statusRef.current = value; setStatus(value); }

  function updateApiKey(value: string) {
    setApiKey(value);
    setStorageAvailable(saveApiKey(value));
  }

  // 因手機切到背景而停止後回到此頁：短時間內自動接續，不必再按一次開始。
  function tryResume() {
    if (document.hidden || hiddenStopAt.current === undefined) return;
    if (!autoResumeRef.current || !resumeOnReturn(hiddenStopAt.current, Date.now())) { hiddenStopAt.current = undefined; return; }
    if (statusRef.current !== 'stopped') return; // 還在翻譯最後一段，等它結束再接續。
    hiddenStopAt.current = undefined;
    startRef.current(true);
  }

  function stopForBackground(text: string) {
    hiddenStopAt.current = Date.now();
    void session.current?.stop(text);
  }

  function receive(event: ServerMessage) {
    if (event.sessionId !== session.current?.id) return;
    if (event.type === 'status') {
      setRecentAudioSeconds(session.current?.recentAudioSeconds ?? 0);
      changeStatus(event.status);
      if (event.status === 'listening' && !startedAt.current) startedAt.current = Date.now();
      setMessage(event.message ?? LABEL[event.status]);
      if (event.status === 'stopped') {
        setPrecisionBusy(false); setPendingSeconds(0);
        void wakeLock.current?.release().catch(() => {});
        window.setTimeout(tryResume, 0);
      }
      if (event.status === 'listening' && document.hidden && stopWhenHidden(navigator))
        stopForBackground('手機頁面已切到背景，已停止收音；回到此頁會自動繼續。');
    } else if (event.type === 'error') {
      setRecentAudioSeconds(session.current?.recentAudioSeconds ?? 0);
      changeStatus('error'); setMessage(event.message); setPrecisionBusy(false); setPendingSeconds(0);
      hiddenStopAt.current = undefined;
      void wakeLock.current?.release().catch(() => {});
    } else if (event.type === 'warning') setMessage(event.message);
    else if (event.type === 'audio-level') {
      setAudioLevel(event.level); setRecentAudioSeconds(session.current?.recentAudioSeconds ?? 0);
      setPendingSeconds(session.current instanceof PrecisionTranslationSession ? Math.floor(session.current.pendingSeconds) : 0);
    }
    else if (event.type === 'talk-state') setTalkState(event.state);
    else if (event.type === 'precision-status') { setMessage(event.message); setPrecisionBusy(event.state === 'working'); }
    else if (event.type === 'usage') dispatchUsage(event);
    else dispatchCaptions({ type: 'message', event, direction });
  }

  function start(resumed = false) {
    if (ACTIVE.includes(statusRef.current)) return;
    if (!apiKey.trim() || !secure || !supported) return;
    let amount: number | undefined;
    const rate = Number(exchangeRate);
    try { amount = twdBudgetToUsd(budget, rate); }
    catch (error) { setMessage(error instanceof Error ? error.message : '請檢查預算與匯率。'); return; }
    session.current?.dispose();
    stopSpeaking(); setSpeakingId(null);
    if (!resumed) hiddenStopAt.current = undefined;
    changeStatus('connecting');
    dispatchCaptions({ type: 'start-session' }); setElapsed(0); setAudioLevel(null); setRecentAudioSeconds(0); setTalkState('idle');
    setPendingSeconds(0); setPrecisionBusy(false); setTalkSpeaker(null);
    setKeyExpanded(false); setKeyOnTop(false);
    setSessionExchangeRate(rate);
    startedAt.current = 0; followBottom.current = true;
    if (face && !faceOpenRef.current) {
      // 對講畫面只顯示這次打開之後的對話；先前的紀錄仍留在主頁面。
      faceOpenRef.current = true; faceSince.current = Date.now(); setFaceOpen(true);
    }
    const earlier = captions.filter(item => !item.gap);
    spoken.current = new Set(captions.map(item => item.id));
    const settings = { apiKey: apiKey.trim(), direction, pair, mode: 'saving' as const, audioSource: source, budgetUsd: amount,
      customVocabulary: terms.vocabulary, quality, pace,
      guidance: { register, glossary: terms.glossary, ...(cleanScene(scene) ? { scene: cleanScene(scene) } : {}) },
      // 接續先前的對話：帶入最近幾句原文，以及已定稿的原文／譯文對照，維持譯名一致。
      recent: recentPairs(earlier.filter(item => item.translationFinal && item.translation)
        .map(item => [item.original, item.translation] as [string, string])),
      context: earlier.slice(-4)
        .map(item => `${DIRECTIONS[item.direction].sourceLabel}: ${item.original}`).join('\n').slice(-512) };
    const next = manual ? new BrowserTranslationSession({ ...settings, listeningMode: 'push-to-talk', precisionReview: false }, receive)
      : new PrecisionTranslationSession(settings, receive);
    session.current = next;
    sessionPair.current = pair;
    dispatchUsage({ type: 'start-session', sessionId: next.id });
    if (navigator.wakeLock) void navigator.wakeLock.request('screen').then(lock => {
      if (session.current !== next || !['connecting', 'ready', 'listening'].includes(statusRef.current)) void lock.release();
      else wakeLock.current = lock;
    }).catch(() => {});
    void next.start();
  }
  const startRef = useRef(start); startRef.current = start;

  function toggle() {
    hiddenStopAt.current = undefined;
    if (statusRef.current === 'finishing') return;
    if (ACTIVE.includes(statusRef.current)) void session.current?.stop();
    else { start(); primeSpeech(); }
  }
  const toggleRef = useRef(toggle); toggleRef.current = toggle;

  // 自動朗讀要先在點按的當下解鎖語音，手機才允許之後由程式開始朗讀。
  function primeSpeech(enabled = manual && speakAuto) { if (enabled) unlockSpeech(); }
  function releaseTalk() {
    if (session.current instanceof BrowserTranslationSession) session.current.releaseTalk();
    primeSpeech();
  }

  function closeFace() {
    faceOpenRef.current = false; setFaceOpen(false);
    hiddenStopAt.current = undefined;
    if (ACTIVE.includes(statusRef.current) && statusRef.current !== 'finishing') void session.current?.stop();
  }

  function pressFace(language: Language) {
    stopSpeaking(); setSpeakingId(null);
    const current = session.current;
    if (!(current instanceof BrowserTranslationSession) || !current.pressTalk(language)) return false;
    setTalkSpeaker(language);
    return true;
  }

  useEffect(() => {
    const tick = () => {
      if (startedAt.current && ['listening', 'finishing'].includes(statusRef.current))
        setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    };
    const interval = window.setInterval(tick, 1000);
    // 行動瀏覽器在背景可能暫停音訊，主動收尾而不是假裝仍持續辨識。
    const visibility = () => {
      if (document.hidden) {
        stopSpeaking(); setSpeakingId(null);
        if (stopWhenHidden(navigator) && ['ready', 'listening'].includes(statusRef.current))
          stopForBackground('頁面已切到背景，正在停止收音；回到此頁會自動繼續。');
      } else tryResume();
    };
    const leave = () => {
      saveCaptions(latestCaptions.current);
      session.current?.dispose();
      if (ACTIVE.includes(statusRef.current)) {
        changeStatus('stopped'); setMessage('頁面已暫停，按開始可開啟新場次。');
      }
    };
    // Ctrl／⌘ + Enter：開始或停止，各模式都適用。
    const shortcut = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.altKey || event.repeat || event.isComposing) return;
      event.preventDefault(); toggleRef.current();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', leave);
    window.addEventListener('keydown', shortcut);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('keydown', shortcut);
      session.current?.dispose(); stopSpeaking();
      void wakeLock.current?.release().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!running || manual) return;
    const current = session.current;
    if (!current) return;
    return watchPageInactivity(document, () => {
      if (session.current !== current || !['connecting', 'ready', 'listening'].includes(statusRef.current)) return;
      // Cancel immediately: inactivity must not enqueue a fresh paid request for the remaining audio.
      current.dispose();
      setRecentAudioSeconds(current.recentAudioSeconds);
      changeStatus('stopped');
      setMessage('已暫停：本頁超過 1 小時沒有操作。紀錄已保留，按「繼續翻譯」可恢復。');
      void wakeLock.current?.release().catch(() => {});
    }, window);
  }, [running, manual]);

  useEffect(() => {
    const pane = captionPane.current;
    if (pane && followBottom.current) pane.scrollTop = pane.scrollHeight;
  }, [captions, running]);

  // 翻譯文字變動後稍候寫入瀏覽器儲存；草稿更新頻繁，不必每個字都存。
  useEffect(() => {
    const timer = window.setTimeout(() => saveCaptions(captions), 600);
    return () => clearTimeout(timer);
  }, [captions]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme; else root.dataset.theme = theme;
  }, [theme]);

  // 按住說話的兩個模式：一句定稿後自動唸出譯文。只在待命時朗讀，按下說話會立刻中斷。
  useEffect(() => {
    if (!speakAuto || !manual || status !== 'listening' || talkState !== 'idle' || !canSpeak) return;
    const current = session.current?.id;
    const ready = captions.filter(item => item.sessionId === current && !item.gap && item.translationFinal
      && item.translation && !spoken.current.has(item.id));
    if (!ready.length) return;
    for (const item of ready) spoken.current.add(item.id);
    const last = ready.at(-1)!;
    const paragraph = paragraphs.find(group => group.captions.some(caption => caption.id === last.id));
    if (speak(ready.map(item => item.translation).join(' '), targetLang(last.direction), () => setSpeakingId(null)))
      setSpeakingId(paragraph?.id ?? null);
  }, [captions, paragraphs, talkState, speakAuto, manual, status, canSpeak]);

  // Replacing/clearing a clip releases its URL, including on unmount. Nothing goes to storage.
  useEffect(() => () => { if (audioClip) URL.revokeObjectURL(audioClip.url); }, [audioClip]);

  const textOutput = useMemo(() => exportParagraphs(paragraphs, showOriginal), [paragraphs, showOriginal]);
  const comparisonOutput = useMemo(() => exportComparison(captions), [captions]);
  const faceCaptions = useMemo(() => faceOpen ? captions.filter(item => item.receivedAt >= faceSince.current) : [], [captions, faceOpen]);
  const hasUsage = usage.audioSeconds > 0 || usage.translationRequests > 0 || usage.estimatedUsd > 0;

  function clearHistory() {
    session.current?.dispose(); session.current = null;
    stopSpeaking(); setSpeakingId(null);
    dispatchCaptions({ type: 'clear-history' });
    dispatchUsage({ type: 'clear-history' });
    clearCaptions();
    startedAt.current = 0; setElapsed(0); setAudioLevel(null); setRecentAudioSeconds(0); setAudioClip(null);
    setPendingSeconds(0); setPrecisionBusy(false);
    setMessage('已清除翻譯紀錄（含瀏覽器保存的內容）與累計用量、費用。');
  }

  // 朗讀會被麥克風收進去：只在沒有收音，或按住說話模式待命（聲音不會送出）時提供。
  const speakAllowed = canSpeak && (!running || (manual && talkState === 'idle'));
  function toggleSpeak(item: CaptionParagraph) {
    if (speakingId === item.id) { stopSpeaking(); setSpeakingId(null); return; }
    if (speak(item.translation, targetLang(item.direction), () => setSpeakingId(current => current === item.id ? null : current)))
      setSpeakingId(item.id);
  }

  function changeFontScale(delta: number) {
    setFontScale(value => { const next = clampFontScale(value + delta); saveFontScale(next); return next; });
  }

  // 精準模式：最新一段要等下一段的後文才定案；等待期間在字幕底部顯示進度。
  const liveSessionId = running ? session.current?.id : undefined;
  const sessionCaptions = captions.filter(item => !item.gap && item.sessionId === liveSessionId);
  const latestPrecision = manual ? undefined : sessionCaptions.filter(item => item.origin === 'precision').at(-1);
  const provisionalWindow = latestPrecision ? latestPrecision.id.slice(0, latestPrecision.id.lastIndexOf('-') + 1) : '';
  const pendingTitle = status === 'finishing' ? '正在翻譯最後一段…'
    : status !== 'listening' ? '正在準備麥克風…'
      : precisionBusy ? '正在翻譯剛才的內容…' : `聆聽中，這一段已收 ${pendingSeconds} 秒`;
  const pendingHint = status === 'finishing' ? '完成後會自動停止。'
    : status !== 'listening' ? '允許使用麥克風後就會開始收音。'
      : precisionBusy ? `同時繼續收音，這一段已收 ${pendingSeconds} 秒。`
        : sessionCaptions.length ? `遇到停頓或滿 ${rhythm.maxSeconds} 秒就會送出翻譯。` : `第一段約 ${firstText} 秒後出現，之後會持續更新。`;

  function keepRecentAudio() {
    const current = session.current;
    const clip = current?.snapshotAudio();
    if (!current || !clip) { setMessage('目前還沒有可回放的音訊，請先開始聆聽。'); return; }
    setAudioClip({ url: URL.createObjectURL(new Blob([clip.wav], {type:'audio/wav'})),
      durationSeconds: clip.durationSeconds, startSeconds: clip.startSeconds, endSeconds: clip.endSeconds,
      sessionId: current.id, pairLabel: LANGUAGE_PAIRS[sessionPair.current].label,
      filename: `原音片段_${new Date().toISOString().replace(/[:.]/g, '-')}.wav` });
  }

  function saveText(content: string, name: string) {
    const url = URL.createObjectURL(new Blob(['﻿', content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${name}_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  const startLabel = face ? '開始對講' : manual ? captions.length ? '繼續待命' : '開始待命'
    : captions.length || status === 'stopped' ? '繼續翻譯' : '開始翻譯';
  const time = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  const requests = usage.translationRequests + (usage.reviewRequests ?? 0);

  const keyPanel = <section className={`key-panel ${keyExpanded ? 'expanded' : ''}`}>
    <div className="key-summary"><strong>Gemini API Key</strong><span>{apiKey.trim() ? storageAvailable ? '已記住' : '僅本次使用' : '尚未設定'}</span>
      <button type="button" onClick={() => setKeyExpanded(value => !value)} aria-expanded={keyExpanded}>
        {keyExpanded ? '收合' : '更改金鑰'}</button></div>
    {keyExpanded && <div className="key-editor"><label className="sr-only" htmlFor="api-key">你的 Gemini API Key</label>
    <div className="key-row"><input id="api-key" type={showKey ? 'text' : 'password'} value={apiKey} disabled={running}
      autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="貼上一次，下次自動帶入" onChange={event => updateApiKey(event.target.value)} />
      <button type="button" onClick={() => setShowKey(value => !value)} aria-label={showKey ? '隱藏金鑰' : '顯示金鑰'}>{showKey ? '隱藏' : '顯示'}</button>
      <button type="button" disabled={running || !apiKey} title="刪除此瀏覽器記住的 API Key"
        onClick={() => { updateApiKey(''); session.current?.dispose(); session.current = null; setRecentAudioSeconds(0); }}>清除</button>
    </div>
    <p role="status">{!storageAvailable ? '瀏覽器暫時無法更新儲存的金鑰。重新開啟後請確認輸入內容，本次仍可使用。'
      : apiKey.trim() ? '已在此瀏覽器記住金鑰，下次開啟會自動帶入。按「清除」即可刪除。'
      : '貼上後自動記住，只存在此裝置的這個瀏覽器。'} 音訊與文字直接送往 Google Gemini。
      <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">取得 API Key ↗</a></p>
    </div>}
  </section>;

  return <main className={`page-shell ${running ? 'session-active' : ''} ${readingMode ? 'reading-mode' : ''}`}>
    <aside className="side">
      <div className="side-primary">
        <header className="hero">
          <h1>語音翻譯</h1>
          <span className={`status status-${status}`}><i />{statusLabel}</span>
        </header>

        {!secure && <div className="notice error-notice" role="alert">請用 HTTPS 網址開啟網頁，電腦測試也可使用 localhost。直接點開 HTML 或使用手機的 HTTP 網址無法開始收音。</div>}
        {secure && !supported && <div className="notice error-notice" role="alert">此瀏覽器不支援持續收音。請改用新版 Safari、Chrome 或 Edge，並從一般瀏覽器開啟。</div>}
        {keyOnTop && keyPanel}

        <section className="control-panel">
          <label>翻譯模式<select value={translationMode} disabled={running} onChange={event => {
            const next = event.target.value as TranslationMode; setTranslationMode(next); saveTranslationMode(next);
          }}><option value="precision">精準原音翻譯</option><option value="push-to-talk">空白鍵 · 按住說話</option>
            <option value="face-to-face">面對面對講 · 一人按一邊</option></select></label>
          <label>翻譯語言（雙向）<select value={pair} disabled={running} onChange={event => {
            const next = event.target.value as LanguagePair; setPair(next); pairPreference.save(next);
          }}>{Object.entries(LANGUAGE_PAIRS).map(([value, item]) => <option value={value} key={value}>{item.label}</option>)}
          </select></label>
          <label>本場預算上限（台幣）<input value={budget} disabled={running} inputMode="decimal" placeholder="NT$，留空不限制"
            onChange={event => { setBudget(event.target.value); saveBudget(event.target.value); }} /></label>
          <div className="main-actions">
            <button className={running ? 'stop' : 'primary'} aria-keyshortcuts="Control+Enter"
              disabled={running ? status === 'finishing' : !apiKey.trim() || !secure || !supported} onClick={toggle}>
              {status === 'finishing' ? '收尾中…' : running ? '■ 停止' : `● ${startLabel}`}</button>
          </div>
        </section>

        {face ? <section className="mode-options">
          <p>按「開始對講」後畫面分成兩半，手機放在兩人中間，各自按住靠近自己的按鈕說話；放開後，對方那一半會顯示翻譯。按哪一邊就當作哪一種語言，不必等系統判斷。</p>
          <label>我這一側的語言<select value={sides.near} disabled={running} onChange={event => {
            const next = event.target.value as Language; setFaceNear(next); faceNearPreference.save(next);
          }}>{LANGUAGE_PAIRS[pair].languages.map(language => <option value={language} key={language}>{LANGUAGE_LABELS[language]}</option>)}</select></label>
          <label className="switch"><input type="checkbox" checked={flip} onChange={event => {
            const next = event.target.checked ? 'on' : 'off'; setFaceFlip(next); faceFlipPreference.save(next);
          }} />對面那一半上下顛倒（手機平放在兩人中間時使用）</label>
          {canSpeak && <label className="switch"><input type="checkbox" checked={faceSpeak} onChange={event => {
            setFaceSpeak(event.target.checked); faceSpeakPreference.save(event.target.checked);
            if (!event.target.checked) { stopSpeaking(); setSpeakingId(null); } else primeSpeech(true);
          }} />翻譯完成後自動朗讀給對方聽</label>}
        </section>
        : manual ? <section className="mode-options">
          <details className="mode-help"><summary>先按「開始待命」，再按住空白鍵或字幕下方的按鈕說話，放開結束這句。<em>運作方式</em></summary>
            <p>按住時邊說邊顯示原文和譯文，放開後等待定稿再講下一句。會保留按下前最多 0.8 秒及放開後約 0.3 秒的聲音；待命時麥克風開著，但沒有按住的聲音不會送出。電腦可按 Ctrl＋Enter 開始或停止待命。</p></details>
          {canSpeak && <label className="switch"><input type="checkbox" checked={autoSpeak} onChange={event => {
            setAutoSpeak(event.target.checked); autoSpeakPreference.save(event.target.checked);
            if (!event.target.checked) { stopSpeaking(); setSpeakingId(null); } else primeSpeech(true);
          }} />每句完成後自動朗讀譯文</label>}
        </section>
        : <details className="mode-help"><summary>持續收音，約 {firstText} 秒出現一段譯文，之後會依後文自動校對。<em>運作方式</em></summary>
          <p>約 {rhythm.minSeconds}–{rhythm.maxSeconds} 秒優先在停頓處分段，再等 {rhythm.lookaheadSeconds} 秒後文交給 AI。下一段會重聽前段並校對，所以最新一段的譯文可能更新；重聽的用量計入費用。
            網路或服務暫時異常會自動重試，並由下一段補翻；完全沒有聲音訊號的段落不會送出。本頁 1 小時無操作會暫停，按「繼續翻譯」恢復。電腦可按 Ctrl＋Enter 開始或停止。</p></details>}
        {source === 'display' && <p className="source-hint">按開始後選擇正在播放的分頁，勾選「分享分頁音訊」。分享視窗或整個螢幕時也必須包含音訊；只傳聲音，不傳畫面。</p>}
      </div>

      <div className="side-more">
        {!keyOnTop && keyPanel}
        <div className="settings-list">
          <details className="recognition-settings"><summary>情境與詞彙<em>{scene.trim() || vocabulary.trim() || register !== 'auto' ? '已設定' : '選填'}</em></summary>
            <label htmlFor="scene">場合說明：這場對話在做什麼</label>
            <textarea id="scene" value={scene} disabled={running} maxLength={SCENE_MAX_CHARS} rows={2}
              placeholder="例如：與日本指導教授討論雙聯學位的修課與研究計畫"
              onChange={event => { setScene(event.target.value); saveScene(event.target.value); }} />
            <p>AI 會依場合挑選用詞、分辨同音字與拿捏語氣；不會把這段說明當成有人說過的話。</p>
            {japanesePair && <label>譯成日文時的語體<select value={register} disabled={running} onChange={event => {
              const next = event.target.value as JapaneseRegister; setRegister(next); saveJapaneseRegister(next);
            }}>{Object.entries(JAPANESE_REGISTERS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}
            <label htmlFor="vocabulary">常用詞與固定譯法</label>
            <textarea id="vocabulary" value={vocabulary} disabled={running} maxLength={6000} rows={2}
              placeholder="例如：青森、弘前、雙聯學位=ダブルディグリー、國立中央大學=国立中央大学"
              onChange={event => { setVocabulary(event.target.value); saveVocabulary(event.target.value); }} />
            <p>以逗號或換行分隔，最多 100 詞。一般詞幫助辨識姓名與地名；寫成「原詞=譯法」會固定使用該譯法，兩個方向都適用。
              {terms.vocabulary.length > 0 && ` 目前：辨識提示 ${terms.vocabulary.length} 詞、固定譯法 ${terms.glossary.length} 組。`}</p>
          </details>
          <details className="recognition-settings"><summary>品質與速度<em>{quality !== 'economy' || pace !== 'standard' || audioSource !== 'microphone' ? '已調整' : ''}</em></summary>
            <label>翻譯品質<select value={quality} disabled={running} onChange={event => {
              const next = event.target.value as Quality; setQuality(next); qualityPreference.save(next);
            }}>{Object.entries(QUALITY_MODELS).map(([value, item]) => <option value={value} key={value}>{item.label}</option>)}</select></label>
            <p>高品質改用較強的模型（{QUALITY_MODELS.quality.model}），回應較慢；價格依 Google 公告，2027 年起會再調高。重要場合再開即可。</p>
            <label>精準模式的出字速度<select value={pace} disabled={running} onChange={event => {
              const next = event.target.value as Pace; setPace(next); pacePreference.save(next);
            }}>{Object.entries(PACES).map(([value, item]) => <option value={value} key={value}>{item.label}</option>)}</select></label>
            <p>快速會把聲音切成較短的段落，較早看到譯文；句子較容易被切開，要靠下一段的校對接回。</p>
            <label>音訊來源（進階）<select value={audioSource} disabled={running} onChange={event => {
              const next = event.target.value as AudioSource; setAudioSource(next); audioSourcePreference.save(next);
            }}>
              <option value="microphone">麥克風（預設，含喇叭外放）</option>
              <option value="display" disabled={!displaySupported}>分享分頁音訊（選用）{!displaySupported ? '（此瀏覽器不支援）' : ''}</option>
            </select></label>
            <p>一般使用直接按開始即可，同一支麥克風會收取人聲與喇叭外放的聲音，無須選分頁。面對面對講一律使用麥克風。</p>
          </details>
          <details className="recognition-settings cost-settings"><summary>顯示與其他<em /></summary>
            <label>外觀<select value={theme} onChange={event => {
              const next = event.target.value as Theme; setTheme(next); themePreference.save(next);
            }}>{Object.entries(THEMES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label className="switch"><input type="checkbox" checked={autoResume} onChange={event => {
              setAutoResume(event.target.checked); autoResumePreference.save(event.target.checked);
            }} />手機切到背景後，10 分鐘內回到此頁自動繼續</label>
            <label htmlFor="exchange-rate">1 美元換算多少台幣</label>
            <input id="exchange-rate" value={exchangeRate} disabled={running} inputMode="decimal" onChange={event => {
              setExchangeRate(event.target.value); saveExchangeRate(Number(event.target.value));
            }} />
            <p>此為可調整、會記住的參考匯率，不會自動更新。預設參考 <a href={EXCHANGE_RATE_SOURCE} target="_blank" rel="noreferrer">臺灣銀行 {EXCHANGE_RATE_DATE} 牌告</a>。實際台幣扣款依 Google 與付款方式的匯率為準。</p>
          </details>
          <details className="recognition-settings diagnostics-panel">
            <summary>漏字檢查<em>原音與辨識稿</em></summary>
            <p>只在此頁記憶體保留最近 30 秒原音，不增加 AI 呼叫或費用。聽到漏字時先擷取，停止聆聽後再播放。</p>
            <div className="diagnostic-actions">
              <button disabled={!recentAudioSeconds} onClick={keepRecentAudio}>擷取最近30秒</button>
              <span>目前可擷取 {recentAudioSeconds.toFixed(1)} 秒</span>
              <button disabled={!comparisonOutput} onClick={() => saveText(comparisonOutput, '辨識稿對照')}>下載對照文字</button>
            </div>
            {audioClip && <div className="saved-audio">
              <span>已保留 {audioClip.durationSeconds.toFixed(1)} 秒 · {audioClip.pairLabel} · 收音位置 {audioTime(audioClip.startSeconds)}–{audioTime(audioClip.endSeconds)}</span>
              {running ? <p>已保留片段。停止聆聽後即可播放，避免播放聲音再次被翻譯。</p>
                : <audio controls preload="metadata" src={audioClip.url} aria-label="保留的原音片段" />}
              <div className="diagnostic-actions">
                <a href={audioClip.url} download={audioClip.filename}>下載原音 WAV</a>
                <button onClick={() => setAudioClip(null)}>清除保留片段</button>
              </div>
            </div>}
            <label className="switch"><input type="checkbox" checked={showComparison} onChange={event => setShowComparison(event.target.checked)} />在字幕中顯示辨識稿對照</label>
            <p>按住說話的模式可比較文字校正前後；精準模式的原文直接由原音翻譯模型產生。對照不與片段逐句對齊。未擷取的聲音循環覆蓋，重新整理或清除紀錄會清除保留片段。</p>
          </details>
        </div>
        <details className="usage-panel">
          <summary><span>累計估算費用 <strong>{formatTwd(usdToTwd(usage.estimatedUsd, displayRate))}</strong></span>
            <span>音訊 {audioTime(usage.audioSeconds)}</span><span>請求 {requests} 次</span><em>明細</em></summary>
          <div className="usage-grid" aria-label="清除紀錄前的累計用量與費用">
            <div><span>累計處理音訊</span><strong>{usage.audioSeconds.toFixed(1)} 秒</strong></div>
            <div><span>累計翻譯請求</span><strong>{requests}</strong>{Boolean(usage.reviewRequests) && <small>含 {usage.reviewRequests} 次原音翻譯 · {usage.reviewAudioSeconds?.toFixed(1)} 秒（含前後文重聽及重試）</small>}</div>
            <div><span>累計輸入／輸出 Tokens{usage.tokenEstimate ? '（估算）' : ''}</span><strong>{usage.inputTokens ?? '未知'} / {usage.outputTokens ?? '未知'}</strong></div>
            <div><span>累計估算費用（台幣）</span><strong>{formatTwd(usdToTwd(usage.estimatedUsd, displayRate))}</strong>
              <small>US$1 ≈ NT${displayRate.toLocaleString('zh-TW', {maximumFractionDigits:4})}</small></div>
          </div>
          <p className="precision-cost">{Boolean(usage.reviewRequests) && `總額已含原音翻譯 ${formatTwd(usdToTwd(usage.reviewEstimatedUsd ?? 0, displayRate))}。`}請求進行中先顯示保守估算，再依實際用量更新；失敗與重試也可能計費。費用與預算停止皆為估算，實際以 Google 帳單為準。</p>
        </details>
        <footer>版本 2.11.1 ·翻譯文字會自動保存在此瀏覽器，按「清除紀錄」即可刪除；原音片段與用量不保存。</footer>
      </div>
    </aside>

    <section className="main">
      <section className="session-bar"><div className="session-info" aria-live="polite"><strong>{LANGUAGE_PAIRS[pair].label}</strong><span>{message}</span></div>
        {running && <span className="audio-signal"><meter min={0} max={1} value={Math.min(1, (audioLevel ?? 0) * 8)} aria-label="輸入音量" />
          {audioLevel === null ? '等待音訊' : audioLevel >= 0.008 ? '收到聲音' : '音量低／安靜'}</span>}
        <time>{time}</time></section>
      <section className="workspace">
        <div className="section-title"><h2>翻譯紀錄</h2>
          <div className="workspace-options"><label className="switch"><input type="checkbox" checked={showOriginal} onChange={event => {
            setShowOriginal(event.target.checked); showOriginalPreference.save(event.target.checked);
          }} />顯示原文</label>
            <span className="font-size" role="group" aria-label="字幕字級">
              <button disabled={fontScale <= FONT_SCALE.min} aria-label="縮小字幕" onClick={() => changeFontScale(-FONT_SCALE.step)}>A−</button>
              <button disabled={fontScale >= FONT_SCALE.max} aria-label="放大字幕" onClick={() => changeFontScale(FONT_SCALE.step)}>A＋</button>
            </span>
            <button className="reading-toggle" aria-pressed={readingMode} onClick={() => setReadingMode(value => !value)}>{readingMode ? '返回設定' : '專注閱讀'}</button></div></div>
        <div className="captions" ref={captionPane} style={{ '--caption-scale': fontScale } as CSSProperties} onScroll={event => {
          const pane = event.currentTarget; followBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
        }}>
          {!captions.length && !(running && !manual) && <div className="empty"><span>聲</span><p>{face
            ? '按「開始對講」，把手機放在兩人中間，各自按住自己那一側的按鈕說話'
            : manual ? running ? '對講機待命中：按住空白鍵或下方按鈕說話' : '先開始待命，再按住空白鍵或下方按鈕說話'
              : '按開始翻譯，稍候顯示完整的原文與譯文'}</p><small>手機請保持此頁在前景。</small></div>}
          {paragraphs.map((item, index) => <Fragment key={item.id}>
            {(index === 0 || paragraphs[index - 1].sessionId !== item.sessionId || paragraphs[index - 1].direction !== item.direction) && <div className="session-divider">
              <strong>{DIRECTIONS[item.direction].sourceLabel} → {DIRECTIONS[item.direction].targetLabel}</strong>
              <time>{new Date(item.receivedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></div>}
            {item.gap ? <div className="gap-notice" role="note"><strong>未翻譯</strong><span>{gapText(item.gap)}</span></div>
            : <article className="caption">
            {showComparison && <div className="comparison-grid">
              <div><small>語音辨識稿 · 文字校正前</small><p lang={sourceLang(item.direction)}><FlowingCaption captions={item.captions} field="recognition" /></p></div>
              <div><small>目前原文 · 含可能的校正</small><p lang={sourceLang(item.direction)}><FlowingCaption captions={item.captions} field="original" /></p></div>
            </div>}
            {showOriginal && !showComparison && <div className="original"><small>{item.captions[0]?.origin === 'precision' ? '原文 · 精準原音翻譯' : item.originalFinal ? 'AI 原文' : 'AI 原文 · 草稿'}{item.corrected ? ' · 已依上下文校正' : ''}</small>
              <p lang={sourceLang(item.direction)}><FlowingCaption captions={item.captions} field="original" /></p></div>}
            <div className="translation"><div className="caption-label"><small>{item.translationFinal
              ? provisionalWindow && item.captions.some(caption => caption.id.startsWith(provisionalWindow)) ? '譯文 · 暫定，下一段會再校對' : '譯文'
              : running && item.sessionId === session.current?.id ? '譯文 · 更新中' : '譯文 · 含未完成草稿'}
              {item.captions.some(caption => caption.previousTranslation) && <span className="revised-tag"> · 已校正，標示處為改動</span>}</small>
              {speakAllowed && item.translation && <button className="speak-button" aria-pressed={speakingId === item.id}
                onClick={() => toggleSpeak(item)}>{speakingId === item.id ? '■ 停止朗讀' : '朗讀'}</button>}</div>
              <p lang={targetLang(item.direction)}>{item.translation ? <FlowingCaption captions={item.captions} field="translation" /> : '等待翻譯…'}</p></div>
          </article>}</Fragment>)}
          {running && !manual && <div className={`pending-card ${precisionBusy || status === 'finishing' ? 'busy' : ''}`}>
            <span className="pending-dot" aria-hidden="true" />
            <div><strong>{pendingTitle}</strong><small>{pendingHint}</small></div>
            {status === 'listening' && <div className="pending-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, pendingSeconds / (rhythm.maxSeconds + rhythm.lookaheadSeconds) * 100)}%` }} /></div>}
          </div>}
        </div>
        {manual && !face && <div className="talk-bar manual-controls">
          <PushToTalkButton disabled={status !== 'listening' || talkState === 'finishing' || talkState === 'closed'} state={talkState}
            onPress={() => { stopSpeaking(); setSpeakingId(null); return session.current instanceof BrowserTranslationSession && session.current.pressTalk(); }}
            onRelease={releaseTalk} />
        </div>}
        <div className="export-actions"><button disabled={!textOutput} onClick={() => void navigator.clipboard.writeText(textOutput)
          .then(() => setMessage('字幕已複製。')).catch(() => setMessage('瀏覽器無法複製，請使用下載 TXT。'))}>複製文字</button>
          <button disabled={!textOutput} onClick={() => saveText(textOutput, '語音翻譯')}>下載 TXT</button>
          <button disabled={(!captions.length && !hasUsage && !recentAudioSeconds && !audioClip) || running} title="清除翻譯（含瀏覽器保存的內容）、原音與累計用量、費用" onClick={clearHistory}>清除紀錄</button></div>
      </section>
    </section>

    {faceOpen && <FaceToFace near={sides.near} far={sides.far} flip={flip} captions={faceCaptions}
      listening={status === 'listening'} ended={!running} failed={status === 'error'} finishing={status === 'finishing'} message={message}
      talkState={talkState} speaker={talkSpeaker} canSpeak={canSpeak} autoSpeak={faceSpeak} fontScale={fontScale}
      onPress={pressFace} onRelease={releaseTalk}
      onSwap={() => { const next = sides.far; setFaceNear(next); faceNearPreference.save(next); }}
      onFlip={() => { const next = flip ? 'off' : 'on'; setFaceFlip(next); faceFlipPreference.save(next); }}
      onAutoSpeak={value => { setFaceSpeak(value); faceSpeakPreference.save(value); if (!value) { stopSpeaking(); setSpeakingId(null); } else primeSpeech(true); }}
      onRestart={() => { start(); primeSpeech(); }} onClose={closeFace} />}
  </main>;
}
