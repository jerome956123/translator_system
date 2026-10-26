import type { UsageSnapshot } from '../../shared/protocol';
import { PRICES } from './config';

// 保守的本機字數估算，提示、前文及失敗的請求都要計入。優先使用實際 metadata。
export function estimateTokens(text: string) { return Math.ceil(text.length); }

export class UsageTracker {
  private audioBytes = 0;
  private attempts = new Map<string, { input: number; output: number; estimated: boolean }>();

  addAudioBytes(bytes: number) { this.audioBytes += Math.max(0, bytes); }

  record(requestId: string, inputText: string, outputText: string, inputTokens?: number, outputTokens?: number) {
    // SSE 中的 metadata 為同一請求累計值；用覆寫取代加總。
    this.attempts.set(requestId, {
      input: inputTokens ?? estimateTokens(inputText),
      output: outputTokens ?? estimateTokens(outputText),
      estimated: inputTokens === undefined || outputTokens === undefined,
    });
  }

  snapshot(): UsageSnapshot {
    let inputTokens = 0;
    let outputTokens = 0;
    let tokenEstimate = false;
    for (const item of this.attempts.values()) {
      inputTokens += item.input;
      outputTokens += item.output;
      tokenEstimate ||= item.estimated;
    }
    const audioSeconds = this.audioBytes / 32000;
    return {
      audioSeconds, translationRequests: this.attempts.size, inputTokens, outputTokens,
      estimatedUsd: audioSeconds / 60 * PRICES.sttPerMinute
        + inputTokens / 1e6 * PRICES.textInputPerMillion + outputTokens / 1e6 * PRICES.textOutputPerMillion,
      isEstimate: true, tokenEstimate,
    };
  }
}
