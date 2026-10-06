const CONSOLE_ORIGIN = 'https://console.agor.cloud';

export const TEAM_SIGNUP_STATUS_URL = `${CONSOLE_ORIGIN}/api/team-signup/status`;

export type TeamSignupStatus = 'available' | 'invite_required' | 'capacity_unavailable';

/** Which button the visitor was shown; reported to analytics alongside the status. */
export type CloudCtaVariant = 'console' | 'waitlist' | 'capacity' | 'hubspot_modal';

export interface CloudCta {
  label: string;
  href: string;
  variant: CloudCtaVariant;
}

const CTA_BY_STATUS: Record<TeamSignupStatus, CloudCta> = {
  available: { label: 'Get Agor Cloud', href: `${CONSOLE_ORIGIN}/`, variant: 'console' },
  invite_required: {
    label: 'Join the Agor Cloud waitlist',
    href: `${CONSOLE_ORIGIN}/request-invite`,
    variant: 'waitlist',
  },
  capacity_unavailable: {
    label: 'Sign up for Agor Cloud',
    href: `${CONSOLE_ORIGIN}/`,
    variant: 'capacity',
  },
};

// Unknown status (loading, failed, unexpected body): CloudCtaLink opens the
// HubSpot modal on click. The console root is the no-JS href since it serves
// both sign-in and the waitlist.
const UNKNOWN_STATUS_CTA: CloudCta = {
  label: 'Sign up for Agor Cloud',
  href: `${CONSOLE_ORIGIN}/`,
  variant: 'hubspot_modal',
};

/** Short labels for tight spots such as the navbar island. */
export const COMPACT_CTA_LABELS: Record<CloudCtaVariant, string> = {
  console: 'Try Agor Cloud',
  waitlist: 'Join waitlist',
  capacity: 'Sign up',
  hubspot_modal: 'Try Agor Cloud',
};

/**
 * Labels for a button that already sits under an "Agor Cloud" label (the home
 * hero's Cloud tier), so they needn't repeat the product name. No "free":
 * nothing establishes a free tier.
 */
export const TIER_CTA_LABELS: Record<CloudCtaVariant, string> = {
  console: 'Get started',
  waitlist: 'Join the waitlist',
  capacity: 'Sign up',
  hubspot_modal: 'Sign up',
};

const CTA_UTM_BASE = 'utm_source=agor.live&utm_medium=referral&utm_campaign=agor-cloud-cta';

export function isTeamSignupStatus(value: unknown): value is TeamSignupStatus {
  return typeof value === 'string' && Object.hasOwn(CTA_BY_STATUS, value);
}

/** `placement` becomes utm_content, so each CTA spot is attributable in the console. */
export function cloudCtaFor(status: TeamSignupStatus | null, placement: string): CloudCta {
  const cta = status ? CTA_BY_STATUS[status] : UNKNOWN_STATUS_CTA;
  return {
    ...cta,
    href: `${cta.href}?${CTA_UTM_BASE}&utm_content=${encodeURIComponent(placement)}`,
  };
}

/**
 * The visitor's HubSpot token (hubspotutk cookie), so the console can tie a
 * sign-up to their agor.live history. Read at click time: HubSpot's script
 * sets the cookie after hydration.
 */
export function hubspotVisitorToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)hubspotutk=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : null;
  return token && /^[a-f0-9]{32}$/.test(token) ? token : null;
}
