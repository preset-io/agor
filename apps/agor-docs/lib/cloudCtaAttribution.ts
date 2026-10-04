import { trackEvent } from './analytics';

const CONSOLE_HOST = 'console.agor.cloud';
// Same UTM convention as the redesign's status-aware CTA, so reports line up.
const CTA_UTM = {
  utm_source: 'agor.live',
  utm_medium: 'referral',
  utm_campaign: 'agor-cloud-cta',
} as const;
const HUBSPOT_VISITOR_TOKEN = /^[a-f0-9]{32}$/;

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
 * hands over the HubSpot visitor token so the console ties the sign-up to the
 * visitor's agor.live history. Runs at click time because HubSpot sets the
 * cookie after hydration.
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
  if (HUBSPOT_VISITOR_TOKEN.test(token)) {
    url.searchParams.set('hutk', token);
    anchor.href = url.toString();
  }
}
