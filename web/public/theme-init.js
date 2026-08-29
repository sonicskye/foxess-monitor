/*
 * Applied before first paint, so a dark kiosk never flashes white.
 *
 * This lives in its own file rather than inline in index.html because the Content-Security-Policy
 * sets `script-src 'self'` — an inline script would simply be blocked, and the flash would come
 * back. It must stay a blocking <script src> in <head>: deferred or bundled, it would run after
 * the first paint and defeat the purpose.
 *
 * Plain JS, no build step: Vite copies web/public verbatim.
 */
(function () {
  try {
    var root = document.documentElement;

    var theme = localStorage.getItem('theme');
    if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);

    // The manual zoom too, for the same reason: applying it after mount reflows the whole page.
    var scale = Number(localStorage.getItem('ui-scale'));
    if (isFinite(scale) && scale >= 0.6 && scale <= 2) {
      root.style.setProperty('--ui-scale', String(scale));
    }
  } catch (e) {
    /* private mode, or storage disabled — the defaults are fine */
  }
})();
