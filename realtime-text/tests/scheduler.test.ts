import { describe, expect, it, vi } from 'vitest';
import { isMeaningfulChange, TranslationScheduler, type TranslationTask } from '../server/scheduler';

const task = (overrides: Partial<TranslationTask> = {}): TranslationTask => ({
  sessionId: 's1', captionId: 'c1', revision: 1, text: '今天下雨', context: '', direction: 'zh-ja', final: false, ...overrides,
});

describe('翻譯排程', () => {
  it('能辨識同長度實質修正並忽略純標點變化', () => {
    expect(isMeaningfulChange('今天下雨', '今天不雨')).toBe(true);
    expect(isMeaningfulChange('你好', '你好！')).toBe(false);
  });

  it('舊請求晚到時不覆蓋新版本', async () => {
    vi.useFakeTimers();
    const translations: Array<{ revision: number; text: string }> = [];
    let resolveFirst!: (value: { text: string }) => void;
    const translate = vi.fn((_item: TranslationTask, _id: string, onChunk: (text: string) => void) => {
      onChunk('舊譯文');
      return new Promise<{ text: string }>((resolve) => { resolveFirst = resolve; });
    });
    const scheduler = new TranslationScheduler({ intervalMs: 1, translate, onUsage: () => {}, onWarning: () => {},
      onTranslation: (event) => translations.push({ revision: event.revision, text: event.translatedText }) });
    scheduler.enqueue(task());
    await vi.advanceTimersByTimeAsync(2);
    scheduler.enqueue(task({ revision: 2, text: '今天不下雨' }));
    resolveFirst({ text: '舊譯文' });
    await Promise.resolve();
    expect(translations.filter((item) => item.revision === 1 && item.text === '舊譯文')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(translate).toHaveBeenCalledTimes(2);
    scheduler.close();
    vi.useRealTimers();
  });

  it('相同句子在不同字幕單位仍各自處理', async () => {
    vi.useFakeTimers();
    const translate = vi.fn(async () => ({ text: '同じです' }));
    const scheduler = new TranslationScheduler({ intervalMs: 0, translate, onUsage: () => {}, onWarning: () => {}, onTranslation: () => {} });
    scheduler.enqueue(task({ captionId: 'c1', final: true }));
    await vi.runAllTimersAsync();
    scheduler.enqueue(task({ captionId: 'c2', final: true }));
    await vi.runAllTimersAsync();
    expect(translate).toHaveBeenCalledTimes(1);
    scheduler.close();
    vi.useRealTimers();
  });
});
