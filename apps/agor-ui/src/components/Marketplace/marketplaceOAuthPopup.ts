export interface MarketplaceOAuthPopup {
  readonly operationId: string;
  close(): void;
  navigate(url: string, isCurrent: () => boolean): boolean;
}

function operationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * Pre-open a unique, same-origin blank window while user activation is live.
 *
 * Supplying the browser `noopener` feature can intentionally make
 * `window.open` return null, which would lose the WindowProxy needed after the
 * OAuth-start await. Instead the inherited-origin intermediate is opened with
 * a unique name, its opener is synchronously severed and verified, and only
 * the parent-held proxy may later navigate it.
 */
export function openMarketplaceOAuthPopup(): MarketplaceOAuthPopup | null {
  const id = operationId();
  const popup = window.open(
    'about:blank',
    `agor-mcp-oauth-${id}`,
    'popup=yes,width=720,height=760'
  );
  if (!popup) return null;
  try {
    popup.opener = null;
    if (popup.opener !== null) throw new Error('Could not isolate OAuth popup');
    popup.document.title = 'Connecting account…';
    if (popup.document.body) popup.document.body.textContent = 'Preparing secure sign-in…';
  } catch {
    popup.close();
    return null;
  }
  return {
    operationId: id,
    close: () => popup.close(),
    navigate: (url, isCurrent) => {
      if (!isCurrent() || popup.closed) {
        popup.close();
        return false;
      }
      popup.location.replace(url);
      return true;
    },
  };
}
