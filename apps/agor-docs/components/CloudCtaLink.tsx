'use client';

import { type MouseEvent, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { trackEvent } from '../lib/analytics';
import {
  adClickIds,
  type CloudCta,
  type CloudCtaVariant,
  COMPACT_CTA_LABELS,
  cloudCtaFor,
  hubspotVisitorToken,
  isTeamSignupStatus,
  TEAM_SIGNUP_STATUS_URL,
  type TeamSignupStatus,
} from '../lib/cloudCta';
import { HubSpotFormModal } from './HubSpotFormModal';

const STATUS_TIMEOUT_MS = 4000;

// 'pending' = request still in flight; 'unknown' = failed or unexpected body.
type ReportedStatus = TeamSignupStatus | 'pending' | 'unknown';

// Dev-only: ?cloud_status=available|invite_required|capacity_unavailable|error
// forces a gate state, since the status API only allows agor.live origins.
function devStatusOverride(): TeamSignupStatus | null | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  const forced = new URLSearchParams(window.location.search).get('cloud_status');
  if (forced === 'error') return null;
  return isTeamSignupStatus(forced) ? forced : undefined;
}

// Status params ride on every later GA4 event (gtag 'set'); the one-off event
// and dataLayer push record which button this page view showed.
function reportStatus(status: TeamSignupStatus | null) {
  const params = {
    cloud_signup_status: status ?? 'unknown',
    cloud_cta_variant: cloudCtaFor(status, '').variant,
  };
  window.gtag?.('set', params);
  trackEvent('agor_cloud_cta_status', params);
}

// One request per page load, shared by every CTA on the page.
let statusRequest: Promise<TeamSignupStatus | null> | undefined;

function fetchTeamSignupStatus(): Promise<TeamSignupStatus | null> {
  if (!statusRequest) {
    const forced = devStatusOverride();
    const request =
      forced !== undefined
        ? Promise.resolve(forced)
        : fetch(TEAM_SIGNUP_STATUS_URL, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => (isTeamSignupStatus(body?.status) ? body.status : null))
            .catch(() => null);
    statusRequest = request.then((status) => {
      reportStatus(status);
      return status;
    });
  }
  return statusRequest;
}

/** Static export renders the fallback CTA; the live gate status swaps it in after hydration. */
export function useCloudCta(placement: string): CloudCta & { status: ReportedStatus } {
  const [status, setStatus] = useState<ReportedStatus>('pending');

  useEffect(() => {
    let cancelled = false;
    fetchTeamSignupStatus().then((next) => {
      if (!cancelled) setStatus(next ?? 'unknown');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const known = status === 'pending' || status === 'unknown' ? null : status;
  return { ...cloudCtaFor(known, placement), status };
}

interface CloudCtaLinkProps {
  placement: string;
  className?: string;
  /** Use the short label (see COMPACT_CTA_LABELS). */
  compact?: boolean;
  /** A label per variant, e.g. TIER_CTA_LABELS; wins over `compact`. */
  labels?: Record<CloudCtaVariant, string>;
}

/**
 * Links to the console when the gate status is known. While the status is
 * unknown (still loading, request failed, unexpected body) a click opens the
 * HubSpot sign-up modal instead; the href stays as the no-JS fallback.
 */
export function CloudCtaLink({ placement, className, compact, labels }: CloudCtaLinkProps) {
  const { label, href, status, variant } = useCloudCta(placement);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const params = {
      source_page: placement,
      cloud_signup_status: status,
      cloud_cta_variant: variant,
    };
    trackEvent('agor_cloud_cta_click', params);
    if (variant === 'hubspot_modal') {
      event.preventDefault();
      setIsFormOpen(true);
      return;
    }
    // Console links carry the HubSpot visitor token (the console prefers
    // ?hutk= over its own cookie) and any Google Ads click id from this page,
    // which the console can't otherwise see once it's on its own domain;
    // utm_content still names the placement.
    const token = hubspotVisitorToken();
    const ids = adClickIds();
    if (token || Object.keys(ids).length) {
      const url = new URL(event.currentTarget.href);
      if (token) url.searchParams.set('hutk', token);
      for (const [key, value] of Object.entries(ids)) url.searchParams.set(key, value);
      event.currentTarget.href = url.toString();
    }
  };

  return (
    <>
      <a href={href} className={className} onClick={onClick}>
        {labels ? labels[variant] : compact ? COMPACT_CTA_LABELS[variant] : label}
      </a>
      {/* Portaled: CTAs sit inside transformed reveal sections, which would
          otherwise trap the modal's position: fixed. */}
      {isFormOpen &&
        createPortal(
          <HubSpotFormModal
            isOpen
            onClose={() => setIsFormOpen(false)}
            title="Sign up for Agor Cloud"
            sourceCta={placement}
          />,
          document.body
        )}
    </>
  );
}
