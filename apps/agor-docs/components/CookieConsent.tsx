'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  CONSENT_SETTINGS_EVENT,
  type ConsentChoice,
  type ConsentState,
  consentState,
  saveConsent,
} from '../lib/consent';
import styles from './CookieConsent.module.css';

/*
 * The cookie banner, and the loader for the optional trackers that must not
 * run without consent (HubSpot's tracking code and Microsoft Clarity). Google
 * tags load from app/layout.tsx and follow Consent Mode instead. See
 * lib/consent.ts for how the default is decided.
 */

const HUBSPOT_SRC = 'https://js-na2.hs-scripts.com/246818610.js';
const CLARITY_ID = 'xroxavynkf';

declare global {
  interface Window {
    _hsq?: unknown[][];
    clarity?: (...args: unknown[]) => void;
  }
}

function loadScript(id: string, src: string) {
  if (document.getElementById(id)) return;
  const script = document.createElement('script');
  script.id = id;
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}

function loadAnalytics() {
  // Clarity's own queueing stub, so calls made before it loads are kept.
  if (!window.clarity) {
    const stub = function (this: unknown) {
      if (!stub.q) stub.q = [];
      // biome-ignore lint/complexity/noArguments: Clarity's queue expects the arguments object.
      stub.q.push(arguments);
    } as ((...args: unknown[]) => void) & { q?: IArguments[] };
    window.clarity = stub;
  }
  loadScript('ms-clarity', `https://www.clarity.ms/tag/${CLARITY_ID}`);
}

function loadMarketing() {
  loadScript('hs-script-loader', HUBSPOT_SRC);
}

// First-party cookies each category sets, cleared when consent is withdrawn.
const ANALYTICS_COOKIE = /^(_ga|_gid|_clck|_clsk)/;
const MARKETING_COOKIE = /^(_gcl_|__hs|hubspotutk|messagesUtk|_uetsid|_uetvid|li_fat_id)/;

function expireCookies(pattern: RegExp) {
  const host = window.location.hostname;
  const domains = ['', host, `.${host}`, `.${host.split('.').slice(-2).join('.')}`];
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0].trim();
    if (!pattern.test(name)) continue;
    for (const domain of domains) {
      // biome-ignore lint/suspicious/noDocumentCookie: expiring cookies; the Cookie Store API isn't in every browser.
      document.cookie = `${name}=; Max-Age=0; path=/${domain ? `; domain=${domain}` : ''}`;
    }
  }
}

const CHOICE_LABEL = {
  granted: 'all optional cookies',
  analytics: 'analytics cookies only',
  denied: 'no optional cookies',
};

const currentChoice = (state: ConsentState): ConsentChoice =>
  state.marketing ? 'granted' : state.analytics ? 'analytics' : 'denied';

export function CookieConsent() {
  const [state, setState] = useState<ConsentState | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const initial = consentState();
    setState(initial);
    // GPC visitors have already said no; they can still opt in from settings.
    setOpen(!initial.decided && !initial.gpc);
    const reopen = () => setOpen(true);
    window.addEventListener(CONSENT_SETTINGS_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_SETTINGS_EVENT, reopen);
  }, []);

  useEffect(() => {
    if (state?.analytics) loadAnalytics();
  }, [state?.analytics]);

  useEffect(() => {
    if (state?.marketing) loadMarketing();
  }, [state?.marketing]);

  const choose = (choice: ConsentChoice) => {
    const next = saveConsent(choice);
    // Withdrawn categories stop now; Tag Manager, if it already loaded, is
    // left out from the next page on.
    if (state?.marketing && !next.marketing) {
      window._hsq?.push(['doNotTrack']);
      expireCookies(MARKETING_COOKIE);
    }
    if (state?.analytics && !next.analytics) {
      window.clarity?.('consent', false);
      expireCookies(ANALYTICS_COOKIE);
    }
    setState(next);
    setOpen(false);
  };

  if (!open || !state) return null;
  return (
    <section className={styles.banner} aria-label="Cookie preferences">
      <p className={styles.text}>
        Optional cookies help us understand how the site is used (analytics) and measure our ads and
        follow up on sign-ups (marketing).{' '}
        {state.decided
          ? `You've chosen ${CHOICE_LABEL[currentChoice(state)]}; change that anytime.`
          : 'You can change your choice anytime from Cookie settings in the footer.'}{' '}
        <Link href="/privacy#4-cookies-and-your-choices" className={styles.link}>
          Details
        </Link>
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.reject} onClick={() => choose('denied')}>
          Reject
        </button>
        <button type="button" className={styles.reject} onClick={() => choose('analytics')}>
          Analytics only
        </button>
        <button type="button" className={styles.accept} onClick={() => choose('granted')}>
          Accept all
        </button>
      </div>
    </section>
  );
}

/** Reopens the cookie banner (footers, privacy policy). */
export function CookieSettingsLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className ?? styles.settingsLink}
      onClick={() => window.dispatchEvent(new Event(CONSENT_SETTINGS_EVENT))}
    >
      Cookie settings
    </button>
  );
}
