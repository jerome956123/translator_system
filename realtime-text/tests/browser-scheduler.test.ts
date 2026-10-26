import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationScheduler } from '../src/lib/scheduler';
import type { TranslationTask } from '../src/lib/types';

const task = (updates: Partial<TranslationTask> = {}): TranslationTask => ({
  sessionId: 's1', utteranceId: 'u1', captionId: 'c1', revision: 1,
  text: '我想買十五個', context: '', direction: 'zh-ja', final: false, ...updates,
});
afterEach(() => vi.useRealTimers());

describe('瀏覽器翻譯排程', () => {
  it('持續新增字時按節流時間啟動，合併過時草稿且只有一個請求', async () => {
    vi.useFakeTimers();
    const translate = vi.fn(async (_task: TranslationTask) => ({ text: '訳文' }));
    const scheduler = new TranslationScheduler({ intervalMs: 1500, translate, onTranslation: vi.fn(), onError: vi.fn() });
    scheduler.enqueue(task()); await vi.advanceTimersByTimeAsync(1);
    for (let i = 2; i <= 9; i++) {
      scheduler.enqueue(task({ revision: i, text: '我想買十五個' + '字'.repeat(i) }));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(translate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(translate.mock.calls[1][0].revision).toBe(9);
    scheduler.close();
  });

  it('舊否定句晚到時不再顯示，但允許相容的前綴草稿', async () => {
    vi.useFakeTimers();
    let finish!: (value: { text: string }) => void;
    const onTranslation = vi.fn();
    const scheduler = new TranslationScheduler({ intervalMs: 1000,
      translate: vi.fn(() => new Promise<{ text: string }>(resolve => { finish = resolve; })), onTranslation, onError: vi.fn() });
    scheduler.enqueue(task()); await vi.advanceTimersByTimeAsync(1);
    scheduler.enqueue(task({ revision: 2, text: '我不買十五個' }));
    finish({ text: '旧訳文' }); await vi.advanceTimersByTimeAsync(1);
    expect(onTranslation).not.toHaveBeenCalled();
    scheduler.close();
  });

  it('同一句草稿完成後轉定稿，沿用快取並各自顯示重複說的兩次', async () => {
    vi.useFakeTimers();
    const translate = vi.fn(async () => ({ text: 'こんにちは' }));
    const onTranslation = vi.fn();
    const scheduler = new TranslationScheduler({ intervalMs: 1000, translate, onTranslation, onError: vi.fn() });
    scheduler.enqueue(task()); await vi.advanceTimersByTimeAsync(1);
    scheduler.enqueue(task({ revision: 2, final: true })); await vi.advanceTimersByTimeAsync(1000);
    scheduler.enqueue(task({ captionId: 'c2', utteranceId: 'u2', final: true })); await vi.advanceTimersByTimeAsync(1);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(onTranslation.mock.calls.map(call => call[0].captionId)).toEqual(['c1', 'c1', 'c2']);
    expect(onTranslation.mock.calls[1][0].final).toBe(true);
    scheduler.close();
  });

  it('定稿優先，關閉後中止請求且不接受晚到結果', async () => {
    vi.useFakeTimers();
    const onTranslation = vi.fn();
    let resolve!: (value: { text: string }) => void;
    let signal!: AbortSignal;
    const translate = vi.fn((_task: TranslationTask, _id: string, _chunk: unknown, abort: AbortSignal) => {
      signal = abort; return new Promise<{ text: string }>(done => { resolve = done; });
    });
    const scheduler = new TranslationScheduler({ intervalMs: 1000, translate, onTranslation, onError: vi.fn() });
    scheduler.enqueue(task()); scheduler.enqueue(task({ captionId: 'final', final: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(translate.mock.calls[0][0].captionId).toBe('final');
    scheduler.close(); expect(signal.aborted).toBe(true);
    resolve({ text: 'late' }); await vi.advanceTimersByTimeAsync(2000);
    expect(onTranslation).not.toHaveBeenCalled(); expect(translate).toHaveBeenCalledTimes(1);
  });

  it('佇列溢出會明確通知，不默默刪掉定稿', () => {
    const onError = vi.fn();
    const scheduler = new TranslationScheduler({ intervalMs: 1000, maxPending: 2,
      translate: vi.fn(), onTranslation: vi.fn(), onError });
    for (let i = 0; i < 3; i++) scheduler.enqueue(task({ captionId: `c${i}`, final: true }));
    expect(onError).toHaveBeenCalledOnce(); scheduler.close();
  });
});
