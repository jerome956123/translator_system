export const PAGE_IDLE_MS = 60 * 60 * 1000;

// Only physical input on this page counts. In particular, automatic subtitle scrolling must not reset the clock.
export function watchPageInactivity(page: EventTarget, onIdle: () => void, lifecycle?: EventTarget,
  acceptInput: (event: Event) => boolean = event => event.isTrusted) {
  let lastActivity = Date.now();
  let closed = false;
  let timer: ReturnType<typeof setTimeout>;
  const inputs = ['pointermove', 'mousemove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'touchmove'];
  const cleanup = () => {
    closed = true; clearTimeout(timer);
    for (const type of inputs) page.removeEventListener(type, activity, true);
    page.removeEventListener('visibilitychange', check);
    lifecycle?.removeEventListener('focus', check); lifecycle?.removeEventListener('pageshow', check);
  };
  function check() {
    if (closed) return;
    clearTimeout(timer);
    const remaining = PAGE_IDLE_MS - (Date.now() - lastActivity);
    if (remaining <= 0) { cleanup(); onIdle(); }
    else timer = setTimeout(check, remaining);
  }
  function activity(event: Event) {
    if (closed || !acceptInput(event)) return;
    // A throttled/background timer may be late: a new mouse move cannot erase an already-expired deadline.
    if (Date.now() - lastActivity >= PAGE_IDLE_MS) { check(); return; }
    lastActivity = Date.now();
  }
  for (const type of inputs) page.addEventListener(type, activity, { capture: true, passive: true });
  page.addEventListener('visibilitychange', check);
  lifecycle?.addEventListener('focus', check); lifecycle?.addEventListener('pageshow', check);
  timer = setTimeout(check, PAGE_IDLE_MS);
  return cleanup;
}
