import type { UsageSnapshot } from '../../shared/protocol';

const EMPTY_USAGE: UsageSnapshot = {
  audioSeconds: 0, translationRequests: 0, inputTokens: 0, outputTokens: 0,
  estimatedUsd: 0, isEstimate: true,
};

interface UsageHistory {
  total: UsageSnapshot;
  previous: UsageSnapshot;
  sessionId?: string;
}

type Action =
  | { type: 'start-session'; sessionId: string }
  | { type: 'usage'; sessionId: string; usage: UsageSnapshot }
  | { type: 'clear-history' };

export const INITIAL_USAGE_HISTORY: UsageHistory = { total: EMPTY_USAGE, previous: EMPTY_USAGE };

export function usageHistory(state: UsageHistory, action: Action): UsageHistory {
  if (action.type === 'clear-history') return INITIAL_USAGE_HISTORY;
  if (action.type === 'start-session') {
    if (action.sessionId === state.sessionId) return state;
    return { total: state.total, previous: state.total, sessionId: action.sessionId };
  }
  if (action.sessionId !== state.sessionId) return state;
  const { previous } = state;
  const current = action.usage;
  // 每則用量訊息已是本場累計；只加到先前場次，避免串流更新重複收費。
  return { ...state, total: {
    audioSeconds: previous.audioSeconds + current.audioSeconds,
    translationRequests: previous.translationRequests + current.translationRequests,
    inputTokens: previous.inputTokens === null || current.inputTokens === null ? null : previous.inputTokens + current.inputTokens,
    outputTokens: previous.outputTokens === null || current.outputTokens === null ? null : previous.outputTokens + current.outputTokens,
    estimatedUsd: previous.estimatedUsd + current.estimatedUsd,
    isEstimate: previous.isEstimate || current.isEstimate,
    tokenEstimate: previous.tokenEstimate || current.tokenEstimate,
    ...(previous.reviewRequests || current.reviewRequests ? {
      reviewRequests: (previous.reviewRequests ?? 0) + (current.reviewRequests ?? 0),
      reviewAudioSeconds: (previous.reviewAudioSeconds ?? 0) + (current.reviewAudioSeconds ?? 0),
      reviewEstimatedUsd: (previous.reviewEstimatedUsd ?? 0) + (current.reviewEstimatedUsd ?? 0),
    } : {}),
  } };
}
