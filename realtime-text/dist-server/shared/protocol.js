export const DIRECTIONS = {
    'zh-ja': { source: 'cmn-Hans-CN', sourceLabel: '中文', target: 'ja', targetLabel: '日本語' },
    'ja-zh': { source: 'ja-JP', sourceLabel: '日本語', target: 'zh-Hant', targetLabel: '繁體中文' },
    'zh-en': { source: 'cmn-Hans-CN', sourceLabel: '中文', target: 'en', targetLabel: 'English' },
    'en-zh': { source: 'en-US', sourceLabel: 'English', target: 'zh-Hant', targetLabel: '繁體中文' },
};
export function isDirection(value) {
    return typeof value === 'string' && value in DIRECTIONS;
}
//# sourceMappingURL=protocol.js.map