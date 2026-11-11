import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { captionHistory } from '../src/lib/history';
import { changedRange, exportParagraphs, gapText, groupCaptions } from '../src/lib/paragraphs';
import { exportComparison } from '../src/lib/diagnostics';
import type { Caption } from '../src/lib/types';

const apply = (events: ServerMessage[], items: Caption[] = []) =>
  events.reduce((history, event) => captionHistory(history, { type: 'message', event, direction: 'zh-ja' }), items);
const base = { sessionId: 's', captionId: 'w-0' };
const publish = (revision: number, original: string, translation: string, corrected?: boolean): ServerMessage[] => [
  { ...base, type: 'transcript', origin: 'precision', direction: 'ja-zh', revision, text: original, rawText: original, final: true, receivedAt: 1 },
  { ...base, type: 'translation', requestId: 'w', direction: 'ja-zh', revision, text: translation, final: true },
  ...(corrected === undefined ? [] : [{ ...base, type: 'caption-correction' as const, revision, direction: 'ja-zh' as const,
    original, translation, corrected, final: true }]),
];

describe('校正標示與未翻譯缺口', () => {
  it('找出兩版譯文之間改動的部分', () => {
    const range = (before: string, after: string) => { const { start, end } = changedRange(before, after); return after.slice(start, end); };
    expect(range('我打算去青森', '我沒有打算去青森')).toBe('沒有');
    expect(range('下週去青森。', '下週二去弘前。')).toBe('二去弘前');
    expect(range('完全相同', '完全相同')).toBe('');
    expect(range('要去青森的學校', '要去青森')).toBe('');
    expect(range('', '新的句子')).toBe('新的句子');
    expect(range('啊啊', '啊啊啊')).toBe('啊');
  });
  it('精準模式第一次顯示不算校正；後文改寫譯文才記下改寫前的版本', () => {
    const first = apply(publish(1, '青森に行くつもり', '我打算去青森'));
    expect(first[0].previousTranslation).toBeUndefined(); expect(first[0].revisedAt).toBeUndefined();
    const same = apply(publish(2, '青森に行くつもり', '我打算去青森', false), first);
    expect(same[0]).toMatchObject({ revision: 2, corrected: false }); expect(same[0].previousTranslation).toBeUndefined();
    const changed = apply(publish(3, '青森に行くつもり', '我沒有打算去青森', true), same);
    expect(changed[0]).toMatchObject({ translation: '我沒有打算去青森', previousTranslation: '我打算去青森', corrected: true, translationFinal: true });
    expect(changed[0].revisedAt).toBeTypeOf('number');
    // 之後整段重送但內容沒變：保留上一次的標示，不把它洗掉。
    const kept = apply(publish(4, '青森に行くつもり', '我沒有打算去青森', true), changed);
    expect(kept[0]).toMatchObject({ previousTranslation: '我打算去青森', revisedAt: changed[0].revisedAt });
  });
  it('即時模式串流中的草稿更新不算校正，已定稿的句子被上下文改寫才算', () => {
    const live = (text: string, final: boolean): ServerMessage => ({ ...base, type: 'translation', requestId: 'r', revision: 1, text, final });
    const draft = apply([
      { ...base, type: 'transcript', revision: 1, text: '下周二去庆生', final: true, receivedAt: 1 },
      live('来週', false), live('来週火曜日に誕生日を祝いに行きます。', true)]);
    expect(draft[0].previousTranslation).toBeUndefined();
    const corrected = apply([{ ...base, type: 'caption-correction', revision: 1, original: '下週二去青森', translation: '来週火曜日に青森へ行きます。', corrected: true, final: true }], draft);
    expect(corrected[0]).toMatchObject({ previousTranslation: '来週火曜日に誕生日を祝いに行きます。', corrected: true });
  });
  it('未翻譯的缺口成為獨立一列，沿用前一句方向，匯出與對照稿都正確', () => {
    const gap: ServerMessage = { type: 'precision-gap', sessionId: 's', gapId: 'g1', startSeconds: 20, endSeconds: 83.4, message: '無法連上 Google，網路可能中斷', receivedAt: 5 };
    const history = apply([...publish(1, '来週、青森に行きます。', '下週要去青森。'), gap, gap,
      ...publish(1, '弘前にも行きます。', '也要去弘前。').map(event => ({ ...event, captionId: 'x-0' }))]);
    expect(history).toHaveLength(3);
    expect(history[1]).toMatchObject({ id: 'g1', direction: 'ja-zh', gap: { startSeconds: 20, endSeconds: 83.4 } });
    const paragraphs = groupCaptions(history);
    expect(paragraphs.map(item => Boolean(item.gap))).toEqual([false, true, false]);
    expect(gapText(paragraphs[1].gap!)).toBe('收音 00:20–01:23 這段未能翻譯：無法連上 Google，網路可能中斷');
    const exported = exportParagraphs(paragraphs, true);
    expect(exported.split('\n\n')).toHaveLength(3);
    expect(exported.split('\n\n')[1]).toBe('[未翻譯] 收音 00:20–01:23 這段未能翻譯：無法連上 Google，網路可能中斷');
    expect(exported.split('\n\n')[2]).toContain('【日本語 → 繁體中文】');
    expect(exportComparison(history)).not.toContain('[目前原文] \n');
  });
  it('第一筆就是缺口時使用場次預設方向', () => {
    const history = apply([{ type: 'precision-gap', sessionId: 's', gapId: 'g', startSeconds: 0, endSeconds: 23, message: '預算不足', receivedAt: 1 }]);
    expect(history[0]).toMatchObject({ direction: 'zh-ja', translationFinal: true, original: '' });
  });
});
