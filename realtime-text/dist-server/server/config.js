import 'dotenv/config';
const int = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};
const optionalNumber = (name) => {
    const raw = process.env[name]?.trim();
    if (!raw)
        return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
};
export const config = {
    apiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
    sttModel: process.env.STT_MODEL?.trim() || 'gemini-3.5-transcribe-live',
    translationModel: process.env.TRANSLATION_MODEL?.trim() || 'gemini-3.1-flash-lite',
    translationIntervalMs: int('TRANSLATION_INTERVAL_MS', 1500),
    translationContextMaxTokens: int('TRANSLATION_CONTEXT_MAX_TOKENS', 256),
    translationOutputMaxTokens: int('TRANSLATION_OUTPUT_MAX_TOKENS', 256),
    port: int('PORT', 3000),
    defaultBudgetUsd: optionalNumber('DEFAULT_BUDGET_USD'),
};
export function publicConfig() {
    return {
        configured: Boolean(config.apiKey),
        sttModel: config.sttModel,
        translationModel: config.translationModel,
        defaultBudgetUsd: config.defaultBudgetUsd ?? null,
    };
}
//# sourceMappingURL=config.js.map