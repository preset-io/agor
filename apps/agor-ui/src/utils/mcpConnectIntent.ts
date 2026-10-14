import { MCP_CONNECT_WIDGET_QUERY_PARAM } from '@agor/core/types';

/**
 * A relayed `?mcp_connect=<widget id>` link asks the matching Connect card to
 * open its Catalog drawer on arrival.
 *
 * Captured once at boot, before any router runs: desktop URL canonicalization
 * and the mobile shell redirect both rewrite the address without the query,
 * and the card mounts only after the session has loaded. The intent is held in
 * sessionStorage (so a login round-trip keeps it) and removed from the address
 * immediately, so a reload never reopens a drawer the user already handled.
 */
const STORAGE_KEY = 'agor:mcp-connect-intent';

export function captureMcpConnectIntent(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const widgetId = url.searchParams.get(MCP_CONNECT_WIDGET_QUERY_PARAM);
  if (widgetId === null) return;
  url.searchParams.delete(MCP_CONNECT_WIDGET_QUERY_PARAM);
  window.history.replaceState(
    window.history.state,
    document.title,
    `${url.pathname}${url.search}${url.hash}`
  );
  try {
    if (widgetId.trim()) window.sessionStorage.setItem(STORAGE_KEY, widgetId);
  } catch {
    // Storage unavailable: the link still lands on the session and its card.
  }
}

/** True exactly once, for the widget the captured link named. */
export function consumeMcpConnectIntent(widgetId: string): boolean {
  try {
    if (window.sessionStorage.getItem(STORAGE_KEY) !== widgetId) return false;
    window.sessionStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
