/** 因切到背景而停止後，在這段時間內回到頁面才自動繼續；離開太久不擅自重開麥克風。 */
export const RESUME_WINDOW_MS = 10 * 60 * 1000;
export function resumeOnReturn(stoppedAt: number | undefined, now: number): boolean {
  return stoppedAt !== undefined && now >= stoppedAt && now - stoppedAt <= RESUME_WINDOW_MS;
}

// 桌面可切到影音分頁；手機鎖屏／切 App 仍停止，避免瀏覽器停收音卻持續計時。
export function stopWhenHidden(browser: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return /Android|iPhone|iPad|iPod/i.test(browser.userAgent)
    || (browser.platform === 'MacIntel' && browser.maxTouchPoints > 1);
}
