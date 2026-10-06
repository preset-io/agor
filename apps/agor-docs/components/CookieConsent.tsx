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

function loadOptionalTrackers() {
  loadScript('hs-script-loader', HUBSPOT_SRC);
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

// Cookies the optional trackers set, cleared when consent is withdrawn.
const OPTIONAL_COOKIE = /^(_ga|_gid|_gcl_|__hs|hubspotutk|messagesUtk|_clck|_clsk|_uetsid|_uetvid)/;

function clearOptionalTrackers() {
  window._hsq?.push(['doNotTrack']);
  window.clarity?.('consent', false);
  const host = window.location.hostname;
  const domains = ['', host, `.${host}`, `.${host.split('.').slice(-2).join('.')}`];
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0].trim();
    if (!OPTIONAL_COOKIE.test(name)) continue;
    for (const domain of domains) {
      // biome-ignore lint/suspicious/noDocumentCookie: expiring cookies; the Cookie Store API isn't in every browser.
      document.cookie = `${name}=; Max-Age=0; path=/${domain ? `; domain=${domain}` : ''}`;
    }
  }
}

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
    if (state?.granted) loadOptionalTrackers();
  }, [state?.granted]);

  const choose = (choice: ConsentChoice) => {
    if (choice === 'denied' && state?.granted) clearOptionalTrackers();
    setState(saveConsent(choice));
    setOpen(false);
  };

  if (!open || !state) return null;
  return (
    <section className={styles.banner} aria-label="Cookie preferences">
      <p className={styles.text}>
        We use optional cookies to understand how the site is used and to follow up on sign-ups.{' '}
        {state.decided
          ? `You've ${state.granted ? 'accepted' : 'rejected'} them; change that here anytime.`
          : 'Change your choice anytime from Cookie settings in the footer.'}{' '}
        <Link href="/privacy" className={styles.link}>
          Privacy Policy
        </Link>
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.reject} onClick={() => choose('denied')}>
          Reject
        </button>
        <button type="button" className={styles.accept} onClick={() => choose('granted')}>
          Accept
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
