/**
 * Build the external launch-init URL for direct-host entry.
 *
 * When a browser lands directly on a workspace host without a local runtime
 * session, the unauthenticated screen sends it to the issuer's configured
 * launch-init endpoint. We attach:
 *
 * - `return_to`: the current *relative* Agor route, so deep links survive a
 *   fresh launch. Only a relative path is sent so this can never become an
 *   open-redirect primitive on the launcher side.
 * - the configured return-host param: the exact host the browser landed on, so
 *   the issuer can resolve/allow-list the return host from its own routing
 *   records and mint a code scoped to it. It is opaque to the daemon.
 *
 * The browser is only ever sent to the operator-configured launch-init URL, so
 * Agor itself introduces no open redirect regardless of these query values.
 */
export function currentReturnToPath(): string | null {
  if (typeof window === 'undefined') return null;
  const pathname = window.location.pathname.startsWith('//') ? '/' : window.location.pathname;
  return `${pathname}${window.location.search}${window.location.hash}`;
}

export function currentHost(): string | null {
  if (typeof window === 'undefined') return null;
  return window.location.host || null;
}

export function buildLaunchInitUrl(loginRedirectUrl: string, returnHostParam?: string): string {
  const returnTo = currentReturnToPath();
  const host = currentHost();

  try {
    const url = new URL(loginRedirectUrl);
    if (returnTo) url.searchParams.set('return_to', returnTo);
    if (returnHostParam && host) url.searchParams.set(returnHostParam, host);
    return url.toString();
  } catch {
    return loginRedirectUrl;
  }
}
