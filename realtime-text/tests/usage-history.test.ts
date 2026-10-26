import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../shared/protocol';
import { INITIAL_USAGE_HISTORY, usageHistory } from '../src/lib/usage-history';

const first: UsageSnapshot = {
  audioSeconds: 60, translationRequests: 2, inputTokens: 100, outputTokens: 40,
  estimatedUsd: 0.01, isEstimate: true,
};
const second: UsageSnapshot = {
  audioSeconds: 30, translationRequests: 1, inputTokens: 50, outputTokens: 20,
  estimatedUsd: 0.005, isEstimate: true, tokenEstimate: true,
};

describe('清除紀錄前的跨場次用量', () => {
  it('換語言或續講的新場次保留總費用，重複快照不重複累加', () => {
    let state = usageHistory(INITIAL_USAGE_HISTORY, { type: 'start-session', sessionId: 'zh-ja' });
    state = usageHistory(state, { type: 'usage', sessionId: 'zh-ja', usage: first });
    state = usageHistory(state, { type: 'start-session', sessionId: 'ja-en' });
    expect(state.total.estimatedUsd).toBe(0.01);
    state = usageHistory(state, { type: 'usage', sessionId: 'ja-en', usage: second });
    state = usageHistory(state, { type: 'usage', sessionId: 'ja-en', usage: second });
    expect(state.total).toEqual({
      audioSeconds: 90, translationRequests: 3, inputTokens: 150, outputTokens: 60,
      estimatedUsd: 0.015, isEstimate: true, tokenEstimate: true,
    });
    // 同場後續 metadata 覆寫估算，不將新快照直接加到目前總額。
    state = usageHistory(state, { type: 'usage', sessionId: 'ja-en', usage: { ...second, estimatedUsd: 0.004 } });
    expect(state.total.estimatedUsd).toBeCloseTo(0.014);
    state = usageHistory(state, { type: 'start-session', sessionId: 'continue' });
    state = usageHistory(state, { type: 'usage', sessionId: 'continue', usage: second });
    expect(state.total.estimatedUsd).toBeCloseTo(0.019);
  });

  it('空場次與重複開始不會清除或重複計算，舊場次訊息不能改寫總額', () => {
    let state = usageHistory(INITIAL_USAGE_HISTORY, { type: 'start-session', sessionId: 'first' });
    state = usageHistory(state, { type: 'usage', sessionId: 'first', usage: first });
    state = usageHistory(state, { type: 'start-session', sessionId: 'first' });
    state = usageHistory(state, { type: 'usage', sessionId: 'first', usage: first });
    state = usageHistory(state, { type: 'start-session', sessionId: 'empty' });
    state = usageHistory(state, { type: 'start-session', sessionId: 'next' });
    const before = state;
    state = usageHistory(state, { type: 'usage', sessionId: 'first', usage: second });
    expect(state).toBe(before);
    expect(state.total.estimatedUsd).toBe(0.01);
  });

  it('即使沒有字幕，清除紀錄也能歸零費用，並忽略清除前的延遲訊息', () => {
    let state = usageHistory(INITIAL_USAGE_HISTORY, { type: 'start-session', sessionId: 'audio-only' });
    state = usageHistory(state, { type: 'usage', sessionId: 'audio-only', usage: { ...first, translationRequests: 0 } });
    state = usageHistory(state, { type: 'clear-history' });
    state = usageHistory(state, { type: 'usage', sessionId: 'audio-only', usage: first });
    expect(state).toBe(INITIAL_USAGE_HISTORY);
    state = usageHistory(state, { type: 'start-session', sessionId: 'new' });
    state = usageHistory(state, { type: 'usage', sessionId: 'new', usage: second });
    expect(state.total.estimatedUsd).toBe(0.005);
  });

  it('保留未知 token 與估算標記，避免將部分總量標成完整 metadata', () => {
    let state = usageHistory(INITIAL_USAGE_HISTORY, { type: 'start-session', sessionId: 'first' });
    state = usageHistory(state, { type: 'usage', sessionId: 'first', usage: { ...first, inputTokens: null, tokenEstimate: true } });
    state = usageHistory(state, { type: 'start-session', sessionId: 'second' });
    state = usageHistory(state, { type: 'usage', sessionId: 'second', usage: second });
    expect(state.total.inputTokens).toBeNull();
    expect(state.total.outputTokens).toBe(60);
    expect(state.total.tokenEstimate).toBe(true);
  });
});
