/**
 * Sends one event to GA4 (gtag) and GTM (dataLayer). Configure GTM not to
 * forward these same events to GA4, or they count twice.
 */
export function trackEvent(name: string, params: Record<string, string>): void {
  window.gtag?.('event', name, params);
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event: name, ...params });
}
