import { trackEvent } from './analytics';

const CONSOLE_HOST = 'console.agor.cloud';
// Same UTM convention as the redesign's status-aware CTA, so reports line up.
const CTA_UTM = {
  utm_source: 'agor.live',
  utm_medium: 'referral',
  utm_campaign: 'agor-cloud-cta',
} as const;
const HUBSPOT_VISITOR_TOKEN = /^[a-f0-9]{32}$/;
const AD_CLICK_PARAMS = ['gclid', 'gbraid', 'wbraid'] as const;

export type CloudCtaVariant = 'console' | 'hubspot_modal';

function isConsoleUrl(url: URL): boolean {
  return url.hostname === CONSOLE_HOST;
}

/**
 * Tags a console link with this CTA's placement: utm_content for GA4, and
 * `source` for the console's HubSpot source_page field. Other links pass through.
 */
export function withCtaAttribution(href: string, placement: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (!isConsoleUrl(url)) return href;
  for (const [key, value] of Object.entries(CTA_UTM)) url.searchParams.set(key, value);
  url.searchParams.set('utm_content', placement);
  url.searchParams.set('source', placement);
  return url.toString();
}

/**
 * Click handler for a sign-up CTA: reports the click, and for a console link
 * hands over the HubSpot visitor token and any Google Ads click id so the
 * console ties the sign-up to the visitor's agor.live history and ad click.
 * Runs at click time because HubSpot sets the cookie after hydration, and the
 * click id otherwise never reaches a different domain.
 */
export function onCloudCtaClick(
  placement: string,
  variant: CloudCtaVariant,
  anchor?: HTMLAnchorElement | null
): void {
  trackEvent('agor_cloud_cta_click', { source_page: placement, cloud_cta_variant: variant });
  if (!anchor) return;
  const url = new URL(anchor.href);
  if (!isConsoleUrl(url)) return;
  const match = /(?:^|;\s*)hubspotutk=([^;]*)/.exec(document.cookie);
  const token = match ? decodeURIComponent(match[1]) : '';
  const pageParams = new URLSearchParams(window.location.search);
  let changed = false;
  if (HUBSPOT_VISITOR_TOKEN.test(token)) {
    url.searchParams.set('hutk', token);
    changed = true;
  }
  for (const key of AD_CLICK_PARAMS) {
    const value = pageParams.get(key);
    if (value) {
      url.searchParams.set(key, value);
      changed = true;
    }
  }
  if (changed) anchor.href = url.toString();
}
