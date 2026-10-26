import { describe, expect, it } from 'vitest';
import { captionHistory } from '../src/lib/history';
import { exportParagraphs, groupCaptions } from '../src/lib/paragraphs';
import type { Caption } from '../src/lib/types';

const transcript = (sessionId: string, id: string, text: string) => ({
  type:'transcript' as const, sessionId, captionId:id, paragraphId:id, revision:1, text, final:true, receivedAt:1000,
});
describe('換語言保留紀錄', () => {
  it('同一場雙向對話依每句方向分組，匯出也保留方向，不會黏在同一段', () => {
    let items: Caption[] = [];
    const turns = [
      {id:'a',text:'我們去青森。',direction:'zh-ja' as const},
      {id:'b',text:'はい。',direction:'ja-zh' as const},
      {id:'c',text:'明天出發。',direction:'zh-ja' as const},
    ];
    for (const turn of turns) items = captionHistory(items,{type:'message',direction:'zh-ja',event:{
      ...transcript('s1',turn.id,turn.text),paragraphId:'same-paragraph',direction:turn.direction,
    }});
    const paragraphs = groupCaptions(items);
    expect(paragraphs).toHaveLength(3);
    expect(new Set(paragraphs.map(item=>item.id)).size).toBe(3);
    const text = exportParagraphs(paragraphs,true);
    expect(text.match(/【繁體中文 → 日本語】/g)).toHaveLength(2);
    expect(text).toContain('【日本語 → 繁體中文】');
  });
  it('AI 改判日文後，從原始聽寫還原字形，不沿用草稿的繁體轉字', () => {
    let items = captionHistory([],{type:'message',direction:'zh-ja',event:{
      ...transcript('s1','a','青森大學'),rawText:'青森大学',direction:'zh-ja',
    }});
    items = captionHistory(items,{type:'message',direction:'zh-ja',event:{type:'translation',sessionId:'s1',captionId:'a',
      revision:1,requestId:'r1',text:'青森大學',direction:'ja-zh',final:true}});
    expect(items[0]).toMatchObject({direction:'ja-zh',original:'青森大学',translation:'青森大學'});
  });
  it('換語言再開始仍保留舊內容，顯示與匯出沿用各自的翻譯方向', () => {
    let items: Caption[] = captionHistory([], {type:'message',direction:'zh-ja',event:transcript('s1','a','下週二去青森。')});
    items = captionHistory(items, {type:'start-session'});
    items = captionHistory(items, {type:'message',direction:'ja-zh',event:transcript('s2','b','こんにちは。')});
    expect(items.map(item=>item.original)).toEqual(['下週二去青森。','こんにちは。']);
    expect(items.map(item=>item.direction)).toEqual(['zh-ja','ja-zh']);
    const text = exportParagraphs(groupCaptions(items), true);
    expect(text).toContain('【繁體中文 → 日本語】'); expect(text).toContain('【日本語 → 繁體中文】');
    expect(captionHistory(items, {type:'clear-history'})).toEqual([]);
  });
  it('上下文校正同時更新原文與譯文，舊版本或別場次不能覆蓋', () => {
    const items = captionHistory([], {type:'message',direction:'zh-ja',event:transcript('s1','a','下週二去慶生。')});
    const correction = {type:'caption-correction' as const, sessionId:'s1',captionId:'a',revision:1,
      original:'下週二去青森。',translation:'来週火曜日に青森へ行きます。',final:true,corrected:true};
    const corrected = captionHistory(items, {type:'message',direction:'zh-ja',event:correction});
    expect(corrected[0].original).toBe('下週二去青森。'); expect(corrected[0].corrected).toBe(true);
    expect(corrected[0].translation).toContain('青森');
    expect(captionHistory(corrected, {type:'message',direction:'zh-ja',event:{...correction,revision:0}})).toEqual(corrected);
    expect(captionHistory(corrected, {type:'message',direction:'zh-ja',event:{...correction,sessionId:'s2'}})).toEqual(corrected);
  });
});
