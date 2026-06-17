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
        }) => void;
      };
    };
  }
}

const HUBSPOT_PORTAL_ID = '5901754';
const HUBSPOT_FORM_ID = 'f76e3259-8c31-4e39-8147-8e23fa53be74';
const HUBSPOT_REGION = 'na1';
const HUBSPOT_SCRIPT_SRC = 'https://js.hsforms.net/forms/embed/v2.js';

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
