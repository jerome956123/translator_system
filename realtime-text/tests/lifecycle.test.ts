import { describe, expect, it } from 'vitest';
import { SessionLifecycle } from '../server/lifecycle';

describe('場次生命週期', () => {
  it('阻止連續開始與停止後的舊事件', () => {
    const lifecycle = new SessionLifecycle();
    const first = lifecycle.start();
    expect(first).toBe(1);
    expect(lifecycle.start()).toBeNull();
    expect(lifecycle.transition('listening', first!)).toBe(true);
    expect(lifecycle.transition('stopped', first!)).toBe(true);
    const second = lifecycle.start();
    expect(second).toBe(2);
    expect(lifecycle.transition('error', first!)).toBe(false);
    expect(lifecycle.current()).toBe('connecting');
  });
});
