import { PRODUCT_ANALYTICS_SERVICE, type ProductAnalyticsInput } from '@agor-live/client';
import { getDaemonUrl } from '../config/daemon';
import { getAgorAccessToken, getCurrentUserIdFromJwt } from './authHeaders';

/**
 * Best effort, no retries/queue and no browser analytics SDK or anonymous ID.
 * Snapshot credentials synchronously so an event can never adopt a later login.
 * The daemon supplies identity and applies operator enablement/event exclusions.
 */
export function trackProductEvent(userId: string | undefined, event: ProductAnalyticsInput): void {
  if (!userId || getCurrentUserIdFromJwt() !== userId) return;
  const token = getAgorAccessToken();
  if (!token) return;
  void fetch(`${getDaemonUrl()}/${PRODUCT_ANALYTICS_SERVICE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(event),
    // Never send a launch code, route query, or provider URL as a referrer.
    referrerPolicy: 'no-referrer',
  }).catch(() => {
    // Analytics delivery must not affect product actions or log credentials.
  });
}
