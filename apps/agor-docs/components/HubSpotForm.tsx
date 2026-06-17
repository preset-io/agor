import Script from 'next/script';
import { useEffect, useId, useState } from 'react';
import { AGOR_CLOUD_DEMO_URL } from '../lib/links';
import styles from './HubSpotForm.module.css';

declare global {
  interface Window {
    hbspt?: {
      forms: {
        create: (opts: {
          portalId: string;
          formId: string;
          region: string;
          target: string;
          css?: string;
        }) => void;
      };
    };
  }
}

// Source form (edit submit button copy, fields, etc. in HubSpot):
// https://app.hubspot.com/forms/5901754/editor/f76e3259-8c31-4e39-8147-8e23fa53be74/edit
const HUBSPOT_PORTAL_ID = '5901754';
const HUBSPOT_FORM_ID = 'f76e3259-8c31-4e39-8147-8e23fa53be74';
const HUBSPOT_REGION = 'na1';
const HUBSPOT_SCRIPT_SRC = 'https://js.hsforms.net/forms/embed/v2.js';

// HubSpot v2 renders the form inline into our target div and injects
// whatever we pass via `css` as a <style> tag in the document head. We
// scope everything under `.hs-form-private` (HubSpot's form class) so
// we never touch page-level elements. Light-mode rules key off
// `html:not(.dark)` to follow the docs site's theme class — today the
// site is `forcedTheme: 'dark'`, so light rules are inert, but they
// will Just Work the day forcedTheme is dropped.
const HUBSPOT_FORM_CSS = `
  .hs-form-private { color: #e6f4f1; font-family: inherit; }
  .hs-form-private .hs-form-field { margin-bottom: 1rem; }
  .hs-form-private .hs-form-field > label {
    display: block;
    margin-bottom: 0.35rem;
    font-weight: 600;
    font-size: 0.95rem;
    color: #e6f4f1;
  }
  .hs-form-private .hs-form-required { color: #ff8a8a; margin-left: 4px; }
  .hs-form-private .hs-input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.55rem 0.75rem;
    font-size: 1rem;
    font-family: inherit;
    border-radius: 6px;
    border: 1px solid rgba(127, 232, 223, 0.35);
    background: rgba(10, 10, 10, 0.55);
    color: #e6f4f1;
  }
  .hs-form-private .hs-input::placeholder { color: rgba(230, 244, 241, 0.45); }
  .hs-form-private .hs-input:focus {
    outline: none;
    border-color: rgba(127, 232, 223, 0.7);
    box-shadow: 0 0 0 3px rgba(127, 232, 223, 0.18);
  }
  .hs-form-private .hs-button {
    display: inline-block;
    margin-top: 0.5rem;
    padding: 0.85rem 1.85rem;
    font-size: 1.0625rem;
    font-weight: 700;
    font-family: inherit;
    color: #0a0a0a;
    background: linear-gradient(135deg, #2e9a92 0%, #4ec4ba 100%);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(46, 154, 146, 0.4);
    transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
  }
  .hs-form-private .hs-button:hover {
    transform: translateY(-1px);
    background: linear-gradient(135deg, #3db4aa 0%, #6dd5cb 100%);
    box-shadow: 0 6px 20px rgba(46, 154, 146, 0.55);
  }
  .hs-form-private .hs-error-msg,
  .hs-form-private .hs-error-msgs,
  .hs-form-private .hs-error-msgs label {
    color: #ff8a8a;
    font-size: 0.875rem;
    list-style: none;
    padding: 0;
    margin: 0.35rem 0 0;
  }

  /* Inert today (site is forcedTheme: 'dark'); activates when light mode lands. */
  html:not(.dark) .hs-form-private,
  html:not(.dark) .hs-form-private .hs-form-field > label { color: #1a1a1a; }
  html:not(.dark) .hs-form-private .hs-input {
    background: #ffffff;
    color: #1a1a1a;
    border-color: rgba(46, 154, 146, 0.35);
  }
  html:not(.dark) .hs-form-private .hs-input::placeholder { color: rgba(0, 0, 0, 0.4); }
`;

interface HubSpotFormProps {
  anchorId?: string;
  showDemoLink?: boolean;
  portalId?: string;
  formId?: string;
  region?: string;
}

export function HubSpotForm({
  anchorId = 'cloud-signup-form',
  showDemoLink = true,
  portalId = HUBSPOT_PORTAL_ID,
  formId = HUBSPOT_FORM_ID,
  region = HUBSPOT_REGION,
}: HubSpotFormProps) {
  // useId returns ":r0:"-style strings; strip ":" so we can use it
  // safely in both a DOM id and a CSS selector.
  const reactId = useId().replace(/:/g, '');
  const targetId = `hubspot-form-${reactId}`;
  const [scriptReady, setScriptReady] = useState(false);

  // The HubSpot loader is cached across client-side navigations, so on
  // remount window.hbspt is already populated — flip the flag immediately
  // instead of waiting for an onLoad that will never fire again.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.hbspt?.forms?.create) {
      setScriptReady(true);
    }
  }, []);

  useEffect(() => {
    if (!scriptReady) return;
    if (typeof window === 'undefined' || !window.hbspt?.forms?.create) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    target.innerHTML = '';
    window.hbspt.forms.create({
      portalId,
      formId,
      region,
      target: `#${targetId}`,
      css: HUBSPOT_FORM_CSS,
    });
  }, [scriptReady, portalId, formId, region, targetId]);

  return (
    <div id={anchorId} className={styles.wrapper}>
      <Script
        src={HUBSPOT_SCRIPT_SRC}
        strategy="afterInteractive"
        onLoad={() => setScriptReady(true)}
        onReady={() => setScriptReady(true)}
      />
      <div id={targetId} className={styles.form} />
      {showDemoLink && (
        <p className={styles.demoLine}>
          Prefer a chat first?{' '}
          <a
            href={AGOR_CLOUD_DEMO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.demoLink}
          >
            Book a Demo →
          </a>
        </p>
      )}
    </div>
  );
}
