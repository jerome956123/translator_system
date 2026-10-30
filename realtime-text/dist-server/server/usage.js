const STT_USD_PER_MINUTE = 0.009;
const TEXT_INPUT_USD_PER_MILLION = 0.25;
const TEXT_OUTPUT_USD_PER_MILLION = 1.5;
export class UsageTracker {
    audioBytes = 0;
    requests = 0;
    inputTokens = 0;
    outputTokens = 0;
    estimatedTokens = false;
    recordedRequestIds = new Set();
    addAudioBytes(bytes) {
        this.audioBytes += Math.max(0, bytes);
    }
    addTranslation(requestId, inputTokens, outputTokens, inputText, outputText) {
        if (this.recordedRequestIds.has(requestId))
            return;
        this.recordedRequestIds.add(requestId);
        this.requests += 1;
        if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
            this.inputTokens += inputTokens;
            this.outputTokens += outputTokens;
        }
        else {
            this.estimatedTokens = true;
            this.inputTokens += Math.max(1, Math.ceil(inputText.length / 3));
            this.outputTokens += Math.max(1, Math.ceil(outputText.length / 3));
        }
    }
    snapshot() {
        const audioSeconds = this.audioBytes / 2 / 16000;
        const estimatedUsd = (audioSeconds / 60) * STT_USD_PER_MINUTE
            + (this.inputTokens / 1_000_000) * TEXT_INPUT_USD_PER_MILLION
            + (this.outputTokens / 1_000_000) * TEXT_OUTPUT_USD_PER_MILLION;
        return {
            audioSeconds: Math.round(audioSeconds * 10) / 10,
            translationRequests: this.requests,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            estimatedUsd: Math.round(estimatedUsd * 100000) / 100000,
            isEstimate: true,
        };
    }
}
export function cumulativeDelta(previous, next) {
    return Math.max(0, next - previous);
}
//# sourceMappingURL=usage.js.map