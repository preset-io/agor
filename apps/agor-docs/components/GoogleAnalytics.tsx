'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import Script from 'next/script';
import { useEffect, useState } from 'react';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    __agorGaLastLocation?: string;
  }
}

interface GoogleAnalyticsProps {
  measurementId: string;
}

/**
 * GA's automatic page view is disabled so App Router navigations can be
 * counted explicitly, once. Keeping the last location on `window` also
 * protects development Strict Mode and accidental component remounts.
 */
export function GoogleAnalytics({ measurementId }: GoogleAnalyticsProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ready || !window.gtag) return;

    const query = searchParams.toString();
    const pagePath = `${pathname}${query ? `?${query}` : ''}`;
    const pageLocation = `${window.location.origin}${pagePath}`;

    if (window.__agorGaLastLocation === pageLocation) return;
    window.__agorGaLastLocation = pageLocation;
    window.gtag('event', 'page_view', {
      page_location: pageLocation,
      page_path: pagePath,
      page_title: document.title,
    });
  }, [pathname, ready, searchParams]);

  return (
    <>
      <Script
        id="google-analytics-loader"
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
        onLoad={() => setReady(true)}
      />
      <Script id="google-analytics-config" strategy="afterInteractive">
        {`window.dataLayer=window.dataLayer||[];window.gtag=function(){window.dataLayer.push(arguments)};window.gtag('js',new Date());window.gtag('config','${measurementId}',{send_page_view:false});`}
      </Script>
    </>
  );
}
