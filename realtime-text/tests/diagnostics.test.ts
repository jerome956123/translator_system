import { describe, expect, it } from 'vitest';
import { captionHistory } from '../src/lib/history';
import { recognitionText, exportComparison, audioTime } from '../src/lib/diagnostics';
import type { Caption } from '../src/lib/types';

describe('辨識稿與後續校正分開追查', () => {
  it('校正能改原文與譯文，但不能蓋掉辨識稿', () => {
    let items = captionHistory([],{type:'message',direction:'zh-ja',event:{type:'transcript',sessionId:'s',captionId:'c',
      revision:1,text:'下週二去慶生。',rawText:'下周二去庆生。',final:true,receivedAt:1000}});
    items = captionHistory(items,{type:'message',direction:'zh-ja',event:{type:'caption-correction',sessionId:'s',captionId:'c',
      revision:1,original:'下週二去青森。',translation:'青森に行きます。',corrected:true,final:true}});
    expect(items[0].rawOriginal).toBe('下周二去庆生。'); expect(recognitionText(items[0])).toBe('下週二去慶生。');
    const text = exportComparison(items);
    expect(text).toContain('[語音辨識稿] 下週二去慶生。'); expect(text).toContain('[目前原文] 下週二去青森。');
    expect(text).toContain('[譯文] 青森に行きます。'); expect(text).toContain('繁體中文 → 日本語');
  });
  it('日文漢字不轉成中文；草稿與未完成譯文有標記', () => {
    const item = {id:'c',sessionId:'s',direction:'ja-zh',receivedAt:1000,paragraphId:'p',revision:1,
      original:'来週大学へ',rawOriginal:'来週大学へ',translation:'下週去大學',translationRevision:1,
      originalFinal:false,translationFinal:false} satisfies Caption;
    expect(recognitionText(item)).toBe('来週大学へ'); const text = exportComparison([item]);
    expect(text).toContain('・草稿'); expect(text).toContain('日本語 → 繁體中文');
  });
  it('續講保留對照，清除紀錄則一起消失', () => {
    const items = captionHistory([],{type:'message',direction:'zh-en',event:{type:'transcript',sessionId:'s',captionId:'c',
      revision:1,text:'原文',rawText:'最初辨識',final:true,receivedAt:1000}});
    expect(captionHistory(items,{type:'start-session'})[0].rawOriginal).toBe('最初辨識');
    expect(exportComparison(captionHistory(items,{type:'clear-history'}))).toBe('');
  });
  it('舊紀錄可退回原文，片段時間可超過一分鐘', () => {
    expect(recognitionText({original:'內容',direction:'zh-ja'} as Caption)).toBe('內容');
    expect(audioTime(125.9)).toBe('02:05');
  });
});
