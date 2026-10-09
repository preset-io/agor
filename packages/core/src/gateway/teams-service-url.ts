/**
 * Bot Connector service-URL allowlist for Teams. Dependency-free so storage,
 * ingress, catch-up, and the send path share one check.
 */

/** Bot Connector hosts for commercial, GCC, GCC High, and DoD tenants. */
export const TEAMS_SERVICE_URL_HOSTS = [
  'smba.trafficmanager.net',
  'smba.infra.gcc.teams.microsoft.com',
  'smba.infra.gov.teams.microsoft.us',
  'smba.infra.dod.teams.microsoft.us',
] as const;

/** True only for an https URL whose host is an allowlisted host or its subdomain. */
export function isAllowedTeamsServiceUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return TEAMS_SERVICE_URL_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

/** The one check before a Bot Framework token is attached to any request: Bot Connector hosts only. */
export function isTeamsTokenHost(value: unknown): value is string {
  return isAllowedTeamsServiceUrl(value);
}
