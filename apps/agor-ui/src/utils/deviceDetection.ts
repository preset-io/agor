/**
 * Viewport-based shell selection for the responsive web app.
 *
 * The shell is chosen by viewport WIDTH, not device user-agent, so a landscape
 * iPad / laptop gets the desktop 3-pane shell while a phone or portrait iPad
 * gets the touch shell. Rotating a tablet changes `innerWidth`, so width alone
 * also captures orientation.
 */

/**
 * Viewports narrower than this (px) use the mobile shell; this width and wider
 * use the desktop shell. 1024 keeps a landscape iPad on desktop and a portrait
 * iPad on mobile. Single source of truth for the shell breakpoint.
 */
export const MOBILE_SHELL_MAX_WIDTH = 1024;

/** The exact complement of AntD's `md` query, so it agrees with `!screens.md` at fractional widths too. */
export const COMPACT_SETTINGS_MEDIA_QUERY = 'not all and (min-width: 768px)';

/** Minimum touch-target size (px) for interactive controls on mobile-shell viewports. */
export const MOBILE_TOUCH_TARGET = 44;

/** Whether the current viewport should render the mobile shell. */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < MOBILE_SHELL_MAX_WIDTH;
}

/** iPhone/iPad WebKit. iPadOS Safari reports a Mac user agent, so touch points tell them apart. */
export function isIosDevice(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>): boolean {
  return (
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
  );
}

/**
 * iOS zooms into any focused field under 16px and stays zoomed.
 * `maximum-scale=1` stops that focus zoom. Safari and SFSafariViewController
 * ignore it for pinch-zoom, but WKWebView in-app browsers honor it by default,
 * so pinch-zoom is lost there. Other browsers would lose it too, so only iOS
 * gets it.
 */
export function preventIosInputZoom(doc: Document = document): void {
  if (!isIosDevice(doc.defaultView?.navigator ?? navigator)) return;
  const viewport = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!viewport || viewport.content.includes('maximum-scale')) return;
  viewport.content = `${viewport.content}, maximum-scale=1`;
}
