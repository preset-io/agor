/**
 * Mapping from `agor_grants.<key>` to the canonical env var name the daemon
 * synthesizes into `.env`. The template-appropriate prefix
 * (`VITE_` / `REACT_APP_` / none) is applied separately by
 * `envVarPrefixForTemplate` in apps/agor-daemon/src/utils/sandpack-config.ts.
 */
import type { AgorGrants } from './artifact';

export const GRANT_ENV_VAR_NAMES = {
  agor_token: 'AGOR_TOKEN',
  agor_api_url: 'AGOR_API_URL',
  agor_user_email: 'AGOR_USER_EMAIL',
  agor_artifact_id: 'AGOR_ARTIFACT_ID',
  agor_board_id: 'AGOR_BOARD_ID',
} as const satisfies Record<keyof Omit<AgorGrants, 'agor_proxies'>, string>;

/**
 * Vendor name → AGOR_PROXY_<VENDOR> env var name.
 * Vendor is uppercased, dashes/spaces normalised to underscores.
 */
export function proxyGrantEnvName(vendor: string): string {
  return `AGOR_PROXY_${vendor.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Grants the daemon will inject without prompting for consent. These are
 * pure metadata — no secrets, no capability beyond "knowing your own
 * coordinates".
 */
export const NO_CONSENT_GRANT_KEYS = ['agor_artifact_id', 'agor_board_id'] as const;

/**
 * Grants that REQUIRE artifact-scoped consent and cannot be satisfied by an
 * author- or instance-wide grant. The JWT (`agor_token`) is the canonical
 * example: handing a 15-minute daemon JWT to "everything Alice ever
 * publishes" is too broad.
 */
export const ARTIFACT_SCOPED_ONLY_GRANT_KEYS = ['agor_token'] as const;

export type ConsentRelevantGrantKey = Exclude<keyof AgorGrants, 'agor_proxies'>;
