/**
 * Cookie consent for agor.live (components/CookieConsent.tsx; policy in
 * content/privacy.mdx). Three categories: necessary storage (always on),
 * analytics (Google Analytics, Microsoft Clarity), and marketing (Tag
 * Manager with Google Ads and LinkedIn, HubSpot). Visitors accept all,
 * analytics only, or neither.
 *
 * The visitor's stored choice wins. Without one, optional cookies are off
 * where opt-in is required (the EEA, UK, and Switzerland, judged from the
 * browser's time zone, since a static site has no server-side geo) and when
 * the browser sends Global Privacy Control; elsewhere they're on until the
 * visitor rejects them.
 *
 * Google Analytics reads the result through Consent Mode (set first, by
 * consentBootScript). Clarity loads with analytics consent; Tag Manager and
 * HubSpot with marketing consent.
 */

export const CONSENT_KEY = 'agor-cookie-consent';
/** Google Tag Manager container. It loads only with consent: besides Google's
 * own tags (which follow Consent Mode) it carries third-party tags, such as
 * LinkedIn's, that don't. */
export const GTM_ID = 'GTM-WL3Q29NW';
/**
 * Google Ads, mirrored from the Tag Manager container. Without consent Tag
 * Manager doesn't load, so the direct Google tag (GoogleAnalytics.tsx) sends
 * the Ads page hit and these conversions instead: cookieless under Consent
 * Mode, so Google can still count and model them. Only while Tag Manager is
 * absent, so a consenting visitor is never counted twice.
 *
 * Keep these in step with the Google Ads conversion actions and their Tag
 * Manager tags: see "Google Ads conversions" in apps/agor-docs/README.md.
 */
export const ADS_ID = 'AW-18371499745';
export const ADS_CONVERSIONS = {
  /** Agor Cloud sign-up form submitted (GTM: hubspot_interest_form_success). */
  signup: `${ADS_ID}/40o_CK6kiuEcEOGtm7hE`,
  /** Demo booked (GTM: hubspot_meeting_booked). */
  demo: `${ADS_ID}/8oqsCPHbl-EcEOGtm7hE`,
} as const;

/** Inline-script snippet: report a conversion when Tag Manager won't. */
export function adsConversionSnippet(sendTo: string): string {
  return `if(!window.__agorGtmLoaded&&window.gtag){window.gtag('event','conversion',{send_to:${JSON.stringify(sendTo)}})}`;
}

/** Fired on window to reopen the banner (the footer's Cookie settings). */
export const CONSENT_SETTINGS_EVENT = 'agor:cookie-settings';

/** Accept all, analytics only, or reject (stored as given). */
export type ConsentChoice = 'granted' | 'analytics' | 'denied';

// Time zones in the EEA, the UK, and Switzerland that aren't under Europe/:
// Atlantic islands, Cyprus, Svalbard, and the EU's outermost regions in
// Africa, the Caribbean, South America, and the Indian Ocean (GDPR applies
// there too). Every Europe/ zone counts as well (a few non-EEA ones
// included, which only errs toward asking first). Legacy alias spellings are
// listed because browsers report whichever ID the OS gives them.
const OPT_IN_ZONES = [
  // Portugal, Spain, Iceland, Faroe Islands, Norway (Svalbard, Jan Mayen)
  'Atlantic/Azores',
  'Atlantic/Madeira',
  'Atlantic/Canary',
  'Atlantic/Reykjavik',
  'Atlantic/Faroe',
  'Atlantic/Faeroe',
  'Arctic/Longyearbyen',
  'Atlantic/Jan_Mayen',
  // Cyprus
  'Asia/Nicosia',
  'Asia/Famagusta',
  // Spain: Ceuta and Melilla
  'Africa/Ceuta',
  // France: Guadeloupe, Martinique, Saint-Martin, French Guiana, Réunion, Mayotte
  'America/Guadeloupe',
  'America/Martinique',
  'America/Marigot',
  'America/Cayenne',
  'Indian/Reunion',
  'Indian/Mayotte',
];

/** Script body (no tags) for the pre-paint head script. Kept dependency-free. */
export function consentBootScript(): string {
  return `(function(){var k=${JSON.stringify(CONSENT_KEY)},c=null,z='';try{c=localStorage.getItem(k)}catch(e){}try{z=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}var optIn=z.indexOf('Europe/')===0||${JSON.stringify(OPT_IN_ZONES)}.indexOf(z)>=0;var gpc=navigator.globalPrivacyControl===true;var decided=c==='granted'||c==='analytics'||c==='denied';var dflt=!decided&&!optIn&&!gpc;var mk=c==='granted'||dflt;var an=mk||c==='analytics';var a=an?'granted':'denied',m=mk?'granted':'denied';window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){window.dataLayer.push(arguments)};window.gtag('consent','default',{analytics_storage:a,ad_storage:m,ad_user_data:m,ad_personalization:m});window.__agorConsent={analytics:an,marketing:mk,decided:decided,optIn:optIn,gpc:gpc};window.__agorLoadGtm=function(){if(window.__agorGtmLoaded)return;window.__agorGtmLoaded=true;window.dataLayer.push({'gtm.start':new Date().getTime(),event:'gtm.js'});var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtm.js?id=${GTM_ID}';document.head.appendChild(s)};if(mk)window.__agorLoadGtm()})();`;
}

export interface ConsentState {
  /** Analytics cookies allowed: Google Analytics, Microsoft Clarity. */
  analytics: boolean;
  /** Marketing cookies allowed: Tag Manager (Google Ads, LinkedIn), HubSpot. */
  marketing: boolean;
  /** The visitor has made a choice (so the banner stays closed). */
  decided: boolean;
  /** Opt-in required here (EEA, UK, Switzerland). */
  optIn: boolean;
  /** The browser sends Global Privacy Control. */
  gpc: boolean;
}

declare global {
  interface Window {
    __agorConsent?: ConsentState;
    /** Loads Tag Manager once (defined by the boot script). */
    __agorLoadGtm?: () => void;
  }
}

/** The state the boot script worked out for this page view. */
export function consentState(): ConsentState {
  return (
    window.__agorConsent ?? {
      analytics: false,
      marketing: false,
      decided: false,
      optIn: true,
      gpc: false,
    }
  );
}

/** Record a choice and tell Google tags. */
export function saveConsent(choice: ConsentChoice): ConsentState {
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // Storage blocked: the choice holds for this page view only.
  }
  const marketing = choice === 'granted';
  const analytics = marketing || choice === 'analytics';
  const state = { ...consentState(), analytics, marketing, decided: true };
  window.__agorConsent = state;
  const ads = marketing ? 'granted' : 'denied';
  window.gtag?.('consent', 'update', {
    analytics_storage: analytics ? 'granted' : 'denied',
    ad_storage: ads,
    ad_user_data: ads,
    ad_personalization: ads,
  });
  if (marketing) window.__agorLoadGtm?.();
  return state;
}
