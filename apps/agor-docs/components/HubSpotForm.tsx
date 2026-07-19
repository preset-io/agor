'use client';

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
          onFormReady?: () => void;
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
// `html:not(.dark)` to follow the docs site's theme class. The docs
// site defaults to dark, but these light-mode tokens keep
// the embedded form legible when readers switch themes.
const HUBSPOT_FORM_CSS = `
  .hs-form-private { color: #e6f4f1; font-family: inherit; }
  .hs-form-private .hs-form-field { margin-bottom: 1.15rem; }
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
    /* height:auto so HubSpot's default fixed input height doesn't clip the
     * padding and push text to the top — lets the vertical padding center.
     * !important beats HubSpot's own late-loading stylesheet. */
    height: auto !important;
    padding: 1.45rem 1.8rem !important;
    line-height: 1.4;
    font-size: 1rem;
    font-family: inherit;
    border-radius: 999px;
    border: 1px solid rgba(52, 230, 196, 0.28);
    background: rgba(10, 20, 18, 0.6);
    color: #e6f4f1;
    transition: border-color 0.25s ease, box-shadow 0.25s ease;
  }
  .hs-form-private .hs-input::placeholder { color: rgba(230, 244, 241, 0.45); }
  .hs-form-private .hs-input:focus {
    outline: none;
    border-color: rgba(52, 230, 196, 0.7);
    box-shadow: 0 0 0 3px rgba(52, 230, 196, 0.16);
  }
  /* Multi-line fields keep soft corners instead of a full pill */
  .hs-form-private textarea.hs-input {
    border-radius: 18px;
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
    border-radius: 999px;
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

  /* Light mode keeps the embedded form legible for readers who switch themes. */
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
  /** When set, "Book a Demo" invokes this (e.g. swap to the in-modal
   * scheduler) instead of linking out to meetings.hubspot.com. */
  onBookDemo?: () => void;
}

export function HubSpotForm({
  anchorId = 'cloud-signup-form',
  showDemoLink = true,
  portalId = HUBSPOT_PORTAL_ID,
  formId = HUBSPOT_FORM_ID,
  region = HUBSPOT_REGION,
  onBookDemo,
}: HubSpotFormProps) {
  // useId returns ":r0:"-style strings; strip ":" so we can use it
  // safely in both a DOM id and a CSS selector.
  const reactId = useId().replace(/:/g, '');
  const targetId = `hubspot-form-${reactId}`;
  const [scriptReady, setScriptReady] = useState(false);
  const [formReady, setFormReady] = useState(false);

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
      onFormReady: () => setFormReady(true),
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
      {!formReady && (
        <output className={styles.loading} aria-label="Loading form">
          <span className={styles.spinner} aria-hidden="true" />
        </output>
      )}
      <div id={targetId} className={styles.form} />
      {showDemoLink && (
        <p className={styles.demoLine}>
          Prefer a chat first?{' '}
          {onBookDemo ? (
            <button type="button" className={styles.demoLink} onClick={onBookDemo}>
              Book a Demo →
            </button>
          ) : (
            <a
              href={AGOR_CLOUD_DEMO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.demoLink}
            >
              Book a Demo →
            </a>
          )}
        </p>
      )}
    </div>
  );
}
