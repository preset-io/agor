/**
 * Mapping from `agor_grants.<key>` to the canonical env var name the daemon
 * synthesizes into `.env`. The template-appropriate prefix
 * (`VITE_` / `REACT_APP_` / none) is applied separately by
 * `envVarPrefixForTemplate` in apps/agor-daemon/src/utils/sandpack-config.ts.
 */
import type { AgorGrants } from './artifact';

export const GRANT_ENV_VAR_NAMES = {
  agor_api_url: 'AGOR_API_URL',
  agor_user_email: 'AGOR_USER_EMAIL',
  agor_artifact_id: 'AGOR_ARTIFACT_ID',
  agor_board_id: 'AGOR_BOARD_ID',
} as const satisfies Record<keyof AgorGrants, string>;

/**
 * Return the canonical persisted/public grant shape.
 *
 * JSON columns and untyped REST clients can contain keys that are no longer
 * part of AgorGrants. Normalize at repository boundaries so removed
 * capabilities cannot remain writable or observable through service/MCP
 * reads, including for rows created by older versions.
 */
export function canonicalizeAgorGrants(input: unknown): AgorGrants {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const grants: AgorGrants = {};
  for (const key of Object.keys(GRANT_ENV_VAR_NAMES) as (keyof AgorGrants)[]) {
    if (source[key] === true) grants[key] = true;
  }
  return grants;
}

/**
 * Grants the daemon will inject without prompting for consent. These are
 * pure metadata — no secrets, no capability beyond "knowing your own
 * coordinates".
 */
export const NO_CONSENT_GRANT_KEYS = ['agor_artifact_id', 'agor_board_id'] as const;
