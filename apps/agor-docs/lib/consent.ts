/**
 * Cookie consent for agor.live (components/CookieConsent.tsx; policy in
 * content/privacy.mdx). Two categories: necessary storage (always on) and
 * optional analytics + marketing (Google Analytics / Tag Manager, HubSpot,
 * Microsoft Clarity).
 *
 * The visitor's stored choice wins. Without one, optional cookies are off
 * where opt-in is required (the EEA, UK, and Switzerland, judged from the
 * browser's time zone, since a static site has no server-side geo) and when
 * the browser sends Global Privacy Control; elsewhere they're on until the
 * visitor rejects them.
 *
 * Google Analytics reads the result through Consent Mode (set first, by
 * consentBootScript). Tag Manager, HubSpot, and Clarity only load once
 * consent is granted.
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

export type ConsentChoice = 'granted' | 'denied';

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
  return `(function(){var k=${JSON.stringify(CONSENT_KEY)},c=null,z='';try{c=localStorage.getItem(k)}catch(e){}try{z=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}var optIn=z.indexOf('Europe/')===0||${JSON.stringify(OPT_IN_ZONES)}.indexOf(z)>=0;var gpc=navigator.globalPrivacyControl===true;var on=c==='granted'||(c!=='denied'&&!optIn&&!gpc);var v=on?'granted':'denied';window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){window.dataLayer.push(arguments)};window.gtag('consent','default',{analytics_storage:v,ad_storage:v,ad_user_data:v,ad_personalization:v});window.__agorConsent={granted:on,decided:c==='granted'||c==='denied',optIn:optIn,gpc:gpc};window.__agorLoadGtm=function(){if(window.__agorGtmLoaded)return;window.__agorGtmLoaded=true;window.dataLayer.push({'gtm.start':new Date().getTime(),event:'gtm.js'});var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtm.js?id=${GTM_ID}';document.head.appendChild(s)};if(on)window.__agorLoadGtm()})();`;
}

export interface ConsentState {
  /** Optional cookies allowed right now. */
  granted: boolean;
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
  return window.__agorConsent ?? { granted: false, decided: false, optIn: true, gpc: false };
}

/** Record a choice and tell Google tags. */
export function saveConsent(choice: ConsentChoice): ConsentState {
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // Storage blocked: the choice holds for this page view only.
  }
  const state = { ...consentState(), granted: choice === 'granted', decided: true };
  window.__agorConsent = state;
  const value = choice === 'granted' ? 'granted' : 'denied';
  window.gtag?.('consent', 'update', {
    analytics_storage: value,
    ad_storage: value,
    ad_user_data: value,
    ad_personalization: value,
  });
  if (choice === 'granted') window.__agorLoadGtm?.();
  return state;
}
