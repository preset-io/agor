/**
 * HTML escaping utilities for rendering user-facing HTML strings from
 * custom Express routes (OAuth callbacks, GitHub App install, etc.).
 *
 * NOTE: prefer a real templating library if you reach for this more than
 * a handful of times — this is a targeted helper, not a rendering engine.
 */

import { randomBytes } from 'node:crypto';

/**
 * Keep successful OAuth confirmation visible long enough to be understood,
 * without making the user clean up a transient authorization tab themselves.
 * Three seconds is a conventional short confirmation interval and gives the
 * user time to read both the result and the close notice.
 */
export const OAUTH_SUCCESS_AUTO_CLOSE_DELAY_MS = 3_000;

export interface RenderedHtmlPage {
  html: string;
  contentSecurityPolicy: string;
}

/**
 * Escape a value for safe insertion into HTML text or quoted-attribute
 * contexts. Covers the five characters required by both contexts:
 * `&`, `<`, `>`, `"`, `'`.
 *
 * Do NOT use for URL-valued attributes (href, src) — those require URL
 * encoding via `encodeURI` / the `URL` constructor on top of this.
 */
export function escapeHtml(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the terminal MCP OAuth callback page.
 *
 * Only confirmed successes receive script and a close timer. Error, denied,
 * expired, malformed, and recovery pages remain static so the user can read
 * and act on them. The script never reads the callback URL, provider response,
 * or opener, and a per-response nonce keeps the callback's CSP narrow.
 */
export function renderOAuthResultPage(success: boolean, message: string): RenderedHtmlPage {
  const color = success ? '#3fb950' : '#f85149';
  const icon = success ? '&#10003;' : '&#10007;';
  const heading = success ? 'Authentication complete' : 'Authentication not completed';
  const safeMessage = escapeHtml(message);
  const nonce = success ? randomBytes(18).toString('base64url') : undefined;
  const autoCloseSeconds = Math.ceil(OAUTH_SUCCESS_AUTO_CLOSE_DELAY_MS / 1_000);
  const autoCloseMarkup = success
    ? `<p id="close-status" class="close-status">This tab will close automatically in <span id="close-countdown" role="timer" aria-live="off" aria-atomic="true">${autoCloseSeconds} seconds</span>.</p>
    <p class="fallback">If this page stays open, you can close this tab and return to Agor.</p>
    <noscript><p class="fallback">JavaScript is unavailable, so you can close this tab and return to Agor.</p></noscript>`
    : '';
  const autoCloseScript = success
    ? `<script nonce="${nonce}">
(() => {
  const root = document.documentElement;
  if (root.dataset.agorOauthAutoCloseStarted === 'true') return;
  root.dataset.agorOauthAutoCloseStarted = 'true';

  const status = document.getElementById('close-status');
  const countdown = document.getElementById('close-countdown');
  let secondsRemaining = ${autoCloseSeconds};
  const intervalId = window.setInterval(() => {
    if (secondsRemaining <= 1) return;
    secondsRemaining -= 1;
    if (countdown) {
      countdown.textContent = secondsRemaining + (secondsRemaining === 1 ? ' second' : ' seconds');
    }
  }, 1000);
  const closeTimerId = window.setTimeout(() => {
    window.clearInterval(intervalId);
    window.close();
    if (!window.closed && status) {
      status.textContent = 'This tab did not close automatically. You can close this tab and return to Agor.';
    }
  }, ${OAUTH_SUCCESS_AUTO_CLOSE_DELAY_MS});

  window.addEventListener('pagehide', () => {
    window.clearInterval(intervalId);
    window.clearTimeout(closeTimerId);
  }, { once: true });
})();
</script>`
    : '';

  return {
    contentSecurityPolicy: nonce
      ? `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`
      : "default-src 'none'; style-src 'unsafe-inline'",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agor OAuth</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 24px; background: #0d1117; color: #e6edf3; }
    .card { width: 100%; max-width: 440px; padding: 32px; border: 1px solid #30363d; border-radius: 12px; background: #161b22; text-align: center; }
    .icon { color: ${color}; font-size: 3rem; line-height: 1; }
    h1 { margin: 16px 0 12px; color: ${color}; font-size: 1.5rem; }
    p { margin: 0; color: #b1bac4; line-height: 1.6; }
    .close-status { margin-top: 16px; color: #e6edf3; }
    .fallback { margin-top: 10px; font-size: 0.875rem; }
  </style>
</head>
<body>
  <main class="card" aria-labelledby="result-heading">
    <div class="icon" aria-hidden="true">${icon}</div>
    <h1 id="result-heading">${heading}</h1>
    <p>${safeMessage}</p>
    ${autoCloseMarkup}
  </main>
  ${autoCloseScript}
</body>
</html>`,
  };
}
