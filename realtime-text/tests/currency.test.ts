import { describe, expect, it } from 'vitest';
import { DEFAULT_USD_TWD, formatTwd, twdBudgetToUsd, usdToTwd } from '../src/lib/currency';

describe('台幣估算與預算', () => {
  it('以設定匯率換算美元成本，預算反向換算後不改變金額', () => {
    expect(usdToTwd(1, DEFAULT_USD_TWD)).toBe(32.58);
    expect(usdToTwd(twdBudgetToUsd('100', 33)!, 33)).toBeCloseTo(100);
    expect(twdBudgetToUsd('32.58', DEFAULT_USD_TWD)).toBe(1);
    expect(twdBudgetToUsd(' ', DEFAULT_USD_TWD)).toBeUndefined();
  });
  it('拒絕無效匯率與預算，避免誤算成零或無限金額', () => {
    for (const rate of [0,-1,NaN,Infinity]) {
      expect(() => twdBudgetToUsd('10', rate)).toThrow('匯率');
      expect(() => usdToTwd(1, rate)).toThrow('匯率');
    }
    for (const value of ['0','-10','abc','Infinity']) expect(() => twdBudgetToUsd(value, 32)).toThrow('台幣');
  });
  it('小額費用不顯示為免費，大額使用台幣符號與千分位', () => {
    expect(formatTwd(0)).toBe('NT$0.00');
    expect(formatTwd(0.001)).toBe('< NT$0.01');
    expect(formatTwd(1234.567)).toBe('NT$1,234.57');
  });
});
