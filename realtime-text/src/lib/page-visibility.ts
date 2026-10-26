// 桌面可切到影音分頁；手機鎖屏／切 App 仍停止，避免瀏覽器停收音卻持續計時。
export function stopWhenHidden(browser: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return /Android|iPhone|iPad|iPod/i.test(browser.userAgent)
    || (browser.platform === 'MacIntel' && browser.maxTouchPoints > 1);
}
