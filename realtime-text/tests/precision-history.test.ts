import { describe, expect, it } from 'vitest';
import { precisionHistory, exportPrecision } from '../src/lib/precision-history';
import type { PrecisionWindow } from '../shared/protocol';
import { INITIAL_USAGE_HISTORY, usageHistory } from '../src/lib/usage-history';

describe('回聽紀錄與費用保留', () => {
  it('換語言或新場次保留結果、不重複加入，只有明確清除才歸零', () => {
    const window: PrecisionWindow = { id: 'a', sessionId: 'first', startSeconds: 0, endSeconds: 12,
      segments: [{ direction: 'zh-ja', original: '青森', translation: '青森' }] };
    let history = precisionHistory([], { type: 'precision-result', sessionId: 'first', window });
    history = precisionHistory(history, { type: 'precision-result', sessionId: 'first', window });
    const second = { ...window, id: 'b', sessionId: 'second', segments: [] };
    history = precisionHistory(history, { type: 'precision-result', sessionId: 'second', window: second });
    expect(history).toHaveLength(2); expect(exportPrecision(history)).toContain('青森');
    expect(exportPrecision(history)).toContain('未辨識到清楚語音');
    expect(exportPrecision(history)).toContain('00:00–00:12');
    expect(precisionHistory(history, { type: 'clear-history' })).toEqual([]);
  });
  it('回聽費用含在總額，跨場次及 metadata 更新都不重複計算', () => {
    const usage = { audioSeconds: 15, translationRequests: 1, inputTokens: 200, outputTokens: 20,
      estimatedUsd: .01, isEstimate: true, reviewRequests: 1, reviewAudioSeconds: 13, reviewEstimatedUsd: .002 };
    let state = usageHistory(INITIAL_USAGE_HISTORY, { type: 'start-session', sessionId: '1' });
    state = usageHistory(state, { type: 'usage', sessionId: '1', usage });
    state = usageHistory(state, { type: 'usage', sessionId: '1', usage });
    expect(state.total.reviewRequests).toBe(1);
    state = usageHistory(state, { type: 'start-session', sessionId: '2' });
    state = usageHistory(state, { type: 'usage', sessionId: '2', usage });
    expect(state.total.reviewRequests).toBe(2); expect(state.total.estimatedUsd).toBeCloseTo(.02);
    expect(state.total.reviewEstimatedUsd).toBeCloseTo(.004); expect(state.total.reviewAudioSeconds).toBe(26);
  });
});
