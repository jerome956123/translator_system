import { describe, expect, it } from 'vitest';
import { stopWhenHidden } from '../src/lib/page-visibility';

describe('背景分頁收音政策', () => {
  it('桌面切到影音分頁時不主動停止', () => {
    expect(stopWhenHidden({ userAgent: 'Chrome Windows', platform: 'Win32', maxTouchPoints: 0 })).toBe(false);
    expect(stopWhenHidden({ userAgent: 'Safari Mac', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
  });
  it('iPhone、Android 與偽裝桌面的 iPad 切到背景時仍停止', () => {
    expect(stopWhenHidden({ userAgent: 'iPhone Safari', platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
    expect(stopWhenHidden({ userAgent: 'Android Chrome', platform: 'Linux', maxTouchPoints: 5 })).toBe(true);
    expect(stopWhenHidden({ userAgent: 'Mac Safari', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
  });
});
